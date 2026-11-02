//! Budget accounting (BACKEND-SCHEMA §1.3) — the invariant-preserving core.
//!
//! Pure and `env`-free: every function operates on borrowed values, and callers
//! (the Prompt 4 contract layer) inject `now` / `id` and perform the
//! `CommitmentId -> Commitment` lookup. The safety invariant
//!
//! > (I)  `completed + outstanding <= cap`   at every observable state
//!
//! is preserved by construction here, and proven by the tests below (which assert
//! it — and re-derive the aggregates from an independent ledger — after *every*
//! operation).
//!
//! Money is [`NearToken`], which has NO `+`/`-` operators — only `checked_*`. Every
//! mutation uses `checked_add`/`checked_sub` and maps `None` to
//! [`PurserError::ArithmeticOverflow`]; `saturating_*` is never used (it would
//! silently clamp an under-count and mask a bug). State legality is delegated to
//! [`crate::reservation::transition`] so the state machine has a single authority.
//!
//! Money-moving functions are **compute-then-commit**: they compute every candidate
//! value with `checked_*` BEFORE writing any field, so a rejected operation leaves
//! [`TaskBudget`]/[`Commitment`] byte-for-byte unchanged regardless of how the
//! boundary handles the `Err`.

use crate::error::PurserError;
use crate::reservation::{transition, Event};
use crate::types::{
    Commitment, CommitmentId, PaymentIntent, RequestId, ReservationState, TaskBudget, TaskId,
};
use near_sdk::{AccountId, NearToken};

/// Assert the safety invariant (I) on the stored aggregates. Pure, infallible read.
///
/// Also usable as a LIVE Prompt-4 backstop: call it at the tail of every mutating
/// entrypoint — a violation panics, which rolls back the whole call atomically.
/// (It re-checks only the aggregates, not the full ledger; the ledger recompute is
/// a test-only oracle — see [`crate::budget::tests`].)
pub fn assert_invariant(b: &TaskBudget) {
    // Unreachable under (I): completed + outstanding <= cap <= u128::MAX.
    let sum = b
        .completed
        .checked_add(b.outstanding)
        .expect("invariant check overflow");
    assert!(
        sum <= b.cap,
        "INVARIANT VIOLATED: completed + outstanding > cap"
    );
}

/// §1.3 `try_reserve`. Admit iff `completed + outstanding + amount <= cap`; then
/// `outstanding += amount` and return a fresh `Commitment{Reserved}`.
///
/// `amount` is `intent.amount`. `id`, `task`, `now` are supplied by the caller
/// (the contract bumps its monotonic counter and reads `env::block_timestamp`).
/// Rejects a zero amount ([`PurserError::ZeroAmount`]).
#[allow(clippy::too_many_arguments)]
pub fn try_reserve(
    b: &mut TaskBudget,
    id: CommitmentId,
    task: TaskId,
    delegate: AccountId,
    intent: PaymentIntent,
    request_id: RequestId,
    now: u64,
) -> Result<Commitment, PurserError> {
    let amount = intent.amount;
    if amount.is_zero() {
        return Err(PurserError::ZeroAmount);
    }
    let used = b
        .completed
        .checked_add(b.outstanding)
        .ok_or(PurserError::ArithmeticOverflow)?;
    let projected = used
        .checked_add(amount)
        .ok_or(PurserError::ArithmeticOverflow)?;
    if projected > b.cap {
        // `used = completed + outstanding <= cap` by invariant (I), so `checked_sub`
        // is always `Some` here; `ZERO` is an unreachable defensive floor for a
        // display-only field.
        let remaining = b.cap.checked_sub(used).unwrap_or(NearToken::ZERO);
        return Err(PurserError::ExceedsBudget {
            requested: amount,
            remaining,
        });
    }
    // compute-then-commit: nothing above mutated `b`. This `checked_add` cannot
    // overflow (`outstanding <= used` and `used + amount = projected <= cap <= MAX`
    // already succeeded above); the guard is kept as defense-in-depth.
    b.outstanding = b
        .outstanding
        .checked_add(amount)
        .ok_or(PurserError::ArithmeticOverflow)?;
    Ok(Commitment {
        id,
        task,
        delegate,
        intent,
        reserved_amount: amount,
        actual_spent: None,
        state: ReservationState::Reserved,
        request_id,
        payload_hash: None,
        near_tx: None,
        evm_tx: None,
        created_at: now,
        updated_at: now,
    })
}

/// `Reserved -> Signed` (zero accounting). A core mutator so EVERY `commitment.state`
/// write routes through the state machine — the Prompt-4 `on_signed` callback calls
/// this rather than hand-writing the transition.
pub fn authorize(c: &mut Commitment, now: u64) -> Result<(), PurserError> {
    let next = transition(c.state, Event::Authorize)?; // only Reserved -> Signed
    c.state = next;
    c.updated_at = now;
    Ok(())
}

/// §1.3 `settle_confirmed`. Pre: `spent <= reserved` and `state ∈ {Signed, Unknown}`.
/// Effect: `outstanding -= reserved`; `completed += spent`; `state = Confirmed`;
/// `actual_spent = Some(spent)`. Net Δ ≤ 0 (the over-reservation is released here).
pub fn settle_confirmed(
    b: &mut TaskBudget,
    c: &mut Commitment,
    spent: NearToken,
    now: u64,
) -> Result<(), PurserError> {
    let next = transition(c.state, Event::Confirm)?; // validates Signed|Unknown -> Confirmed
    if spent > c.reserved_amount {
        return Err(PurserError::SpentExceedsReserved {
            spent,
            reserved: c.reserved_amount,
        });
    }
    // compute BOTH candidates before touching `b` — an Err here leaves it untouched.
    let new_outstanding = b
        .outstanding
        .checked_sub(c.reserved_amount)
        .ok_or(PurserError::ArithmeticOverflow)?;
    let new_completed = b
        .completed
        .checked_add(spent)
        .ok_or(PurserError::ArithmeticOverflow)?;
    b.outstanding = new_outstanding;
    b.completed = new_completed;
    c.actual_spent = Some(spent);
    c.state = next; // Confirmed
    c.updated_at = now;
    Ok(())
}

/// §1.3 `release_failed`. Pre: `state ∈ {Reserved, Failed}` with no signature issued.
/// Effect (once, on `Reserved -> Failed`): `outstanding -= reserved`; `state = Failed`.
///
/// Idempotent: a call when already `Failed` is a no-op with ZERO accounting change
/// (so a retry can never double-release). "No signature issued" is enforced by the
/// state gate — `Signed`/`Unknown` sources reject.
pub fn release_failed(b: &mut TaskBudget, c: &mut Commitment, now: u64) -> Result<(), PurserError> {
    if c.state == ReservationState::Failed {
        return Ok(()); // idempotent: no accounting change
    }
    release_outstanding(b, c, Event::Fail, now) // only Reserved -> Failed is legal
}

/// Shared tail of the two terminal-release ops ([`release_failed`], [`cancel`]):
/// validate the edge via [`transition`], release the full `reserved_amount` from
/// `outstanding` (checked), and move to the terminal state. Private — callers own
/// any precondition (e.g. `release_failed`'s idempotency short-circuit) and pass the
/// event that selects the legal edge.
fn release_outstanding(
    b: &mut TaskBudget,
    c: &mut Commitment,
    event: Event,
    now: u64,
) -> Result<(), PurserError> {
    let next = transition(c.state, event)?;
    b.outstanding = b
        .outstanding
        .checked_sub(c.reserved_amount)
        .ok_or(PurserError::ArithmeticOverflow)?;
    c.state = next;
    c.updated_at = now;
    Ok(())
}

/// §1.3 `mark_unknown`. Pre: `state == Signed`. Effect: `state = Unknown`; NO
/// accounting change (reclaim-only-on-proof — a timed-out payment stays reserved).
pub fn mark_unknown(c: &mut Commitment, now: u64) -> Result<(), PurserError> {
    let next = transition(c.state, Event::Timeout)?; // Signed -> Unknown ONLY
    c.state = next; // Unknown
    c.updated_at = now;
    Ok(())
}

/// §1.3 `cancel` (stretch nonce-burn). Pre: `state == Unknown` (cancel attested).
/// Effect: `outstanding -= reserved`; `state = Cancelled`. Not idempotent — a second
/// call sees `Cancelled` and rejects via the state gate (no double-release).
pub fn cancel(b: &mut TaskBudget, c: &mut Commitment, now: u64) -> Result<(), PurserError> {
    release_outstanding(b, c, Event::Cancel, now) // only Unknown -> Cancelled is legal
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Chain, TaskBudget, TokenSpec};

    // ---- fixtures -------------------------------------------------------------

    fn yocto(n: u128) -> NearToken {
        NearToken::from_yoctonear(n)
    }
    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn intent(amount: u128) -> PaymentIntent {
        PaymentIntent {
            chain: Chain::NearNative,
            recipient: "recipient.near".to_string(),
            amount: yocto(amount),
            token: TokenSpec::NearNative,
            memo: None,
        }
    }
    fn budget(cap: u128) -> TaskBudget {
        TaskBudget {
            owner: acct("owner.near"),
            token: TokenSpec::NearNative,
            cap: yocto(cap),
            completed: NearToken::ZERO,
            outstanding: NearToken::ZERO,
            crew_cap: 3,
            created_at: 0,
        }
    }

    /// A pure in-memory ledger used as a STATE-INVARIANT TEST ORACLE (model-based
    /// testing). `recompute_*` sum over the commitment list *independently* of the
    /// incremental aggregate math, so `check()` catches any drift between the stored
    /// `TaskBudget` aggregates and the ledger — the one thing `assert_invariant`
    /// (aggregates-only) cannot see.
    struct TestLedger {
        budget: TaskBudget,
        commitments: Vec<Commitment>,
        next_id: CommitmentId,
    }

    impl TestLedger {
        fn new(cap: u128) -> Self {
            TestLedger {
                budget: budget(cap),
                commitments: Vec::new(),
                next_id: 0,
            }
        }

        fn index_of(&self, id: CommitmentId) -> usize {
            self.commitments.iter().position(|c| c.id == id).unwrap()
        }

        fn reserve(&mut self, amount: u128) -> Result<CommitmentId, PurserError> {
            let id = self.next_id;
            let c = try_reserve(
                &mut self.budget,
                id,
                "task-1".to_string(),
                acct("delegate.near"),
                intent(amount),
                format!("req-{id}"),
                0,
            )?;
            self.commitments.push(c);
            self.next_id += 1;
            self.check();
            Ok(id)
        }

        fn authorize(&mut self, id: CommitmentId) {
            let i = self.index_of(id);
            authorize(&mut self.commitments[i], 1).unwrap();
            self.check();
        }
        fn settle(&mut self, id: CommitmentId, spent: u128) -> Result<(), PurserError> {
            let i = self.index_of(id);
            let r = settle_confirmed(&mut self.budget, &mut self.commitments[i], yocto(spent), 1);
            self.check();
            r
        }
        fn fail(&mut self, id: CommitmentId) -> Result<(), PurserError> {
            let i = self.index_of(id);
            let r = release_failed(&mut self.budget, &mut self.commitments[i], 1);
            self.check();
            r
        }
        fn timeout(&mut self, id: CommitmentId) -> Result<(), PurserError> {
            let i = self.index_of(id);
            let r = mark_unknown(&mut self.commitments[i], 1);
            self.check();
            r
        }
        fn cancel(&mut self, id: CommitmentId) -> Result<(), PurserError> {
            let i = self.index_of(id);
            let r = cancel(&mut self.budget, &mut self.commitments[i], 1);
            self.check();
            r
        }
        fn state(&self, id: CommitmentId) -> ReservationState {
            self.commitments[self.index_of(id)].state
        }

        fn recompute_outstanding(&self) -> NearToken {
            use ReservationState::*;
            self.commitments
                .iter()
                .filter(|c| matches!(c.state, Reserved | Signed | Unknown))
                .fold(NearToken::ZERO, |acc, c| {
                    acc.checked_add(c.reserved_amount).unwrap()
                })
        }
        fn recompute_completed(&self) -> NearToken {
            self.commitments
                .iter()
                .filter(|c| c.state == ReservationState::Confirmed)
                .fold(NearToken::ZERO, |acc, c| {
                    acc.checked_add(c.actual_spent.unwrap_or(NearToken::ZERO))
                        .unwrap()
                })
        }
        /// assert_invariant AND the independent ledger recompute. Called after every op.
        fn check(&self) {
            assert_invariant(&self.budget);
            assert_eq!(
                self.budget.outstanding,
                self.recompute_outstanding(),
                "outstanding desynced from ledger"
            );
            assert_eq!(
                self.budget.completed,
                self.recompute_completed(),
                "completed desynced from ledger"
            );
        }
    }

    // ---- "Done when" tests ----------------------------------------------------

    #[test]
    fn invariant_holds_over_legal_sequence() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap(); // outstanding 40
        let b = l.reserve(30).unwrap(); // outstanding 70
        let c = l.reserve(20).unwrap(); // outstanding 90
        l.authorize(a);
        l.settle(a, 35).unwrap(); // completed 35, outstanding 50 (released 5 over-reservation)
        l.fail(b).unwrap(); // outstanding 20
        l.authorize(c);
        l.timeout(c).unwrap(); // stays reserved; outstanding 20
        l.cancel(c).unwrap(); // outstanding 0
        assert_eq!(l.budget.completed, yocto(35));
        assert_eq!(l.budget.outstanding, yocto(0));
    }

    #[test]
    fn reserve_rejects_amount_that_breaches_cap() {
        let mut l = TestLedger::new(100);
        l.reserve(60).unwrap();
        let before = l.budget.clone();
        let before_len = l.commitments.len();
        // remaining = 40; 41 must be refused.
        let err = l.reserve(41).unwrap_err();
        assert!(matches!(
            err,
            PurserError::ExceedsBudget { remaining, .. } if remaining == yocto(40)
        ));
        assert_eq!(l.budget, before, "budget mutated on rejected reserve");
        assert_eq!(
            l.commitments.len(),
            before_len,
            "commitment created on reject"
        );
    }

    #[test]
    fn reserve_admits_exactly_at_cap() {
        let mut l = TestLedger::new(100);
        l.reserve(60).unwrap();
        l.reserve(40).unwrap(); // completed+outstanding+amount == cap -> admit
        assert_eq!(l.budget.outstanding, yocto(100));
        l.check();
        // one more yocto over the cap is refused.
        assert!(matches!(
            l.reserve(1).unwrap_err(),
            PurserError::ExceedsBudget { .. }
        ));
    }

    #[test]
    fn settle_under_reserved_releases_overreservation() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(50).unwrap();
        l.authorize(a);
        let remaining_before = yocto(100)
            .checked_sub(
                l.budget
                    .completed
                    .checked_add(l.budget.outstanding)
                    .unwrap(),
            )
            .unwrap();
        l.settle(a, 30).unwrap(); // spent < reserved
        let remaining_after = yocto(100)
            .checked_sub(
                l.budget
                    .completed
                    .checked_add(l.budget.outstanding)
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(l.budget.completed, yocto(30));
        assert_eq!(l.budget.outstanding, yocto(0));
        assert!(
            remaining_after > remaining_before,
            "net Δ should be ≤ 0 (budget freed)"
        );
    }

    #[test]
    fn release_failed_impossible_once_signed() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(50).unwrap();
        l.authorize(a); // now Signed — a signature may exist
        let before = l.budget.clone();
        let err = l.fail(a).unwrap_err();
        assert!(matches!(err, PurserError::IllegalTransition { .. }));
        assert_eq!(
            l.budget, before,
            "outstanding must not be released after Signed"
        );
        assert_eq!(l.state(a), ReservationState::Signed);
    }

    #[test]
    fn mark_unknown_changes_no_accounting() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(50).unwrap();
        l.authorize(a);
        let before = l.budget.clone();
        l.timeout(a).unwrap();
        assert_eq!(l.budget, before, "mark_unknown must not touch the budget");
        assert_eq!(l.state(a), ReservationState::Unknown);
    }

    // ---- MUST-TEST matrix -----------------------------------------------------

    #[test]
    fn reserve_rejects_zero_amount() {
        let mut l = TestLedger::new(100);
        assert_eq!(l.reserve(0).unwrap_err(), PurserError::ZeroAmount);
        assert_eq!(l.budget.outstanding, yocto(0));
    }

    #[test]
    fn reserve_rejects_admission_sum_overflow() {
        // completed+outstanding+amount overflows u128 → ArithmeticOverflow, never admit/panic.
        let mut b = budget(u128::MAX);
        b.outstanding = yocto(10);
        let err = try_reserve(
            &mut b,
            0,
            "t".into(),
            acct("d.near"),
            intent(u128::MAX),
            "r".into(),
            0,
        )
        .unwrap_err();
        assert_eq!(err, PurserError::ArithmeticOverflow);
        assert_eq!(b.outstanding, yocto(10), "budget mutated on overflow");
    }

    #[test]
    fn reserve_full_cap_then_reject() {
        let mut l = TestLedger::new(90);
        l.reserve(30).unwrap();
        l.reserve(30).unwrap();
        l.reserve(30).unwrap(); // exactly cap
        assert_eq!(l.budget.outstanding, yocto(90));
        assert!(matches!(
            l.reserve(1).unwrap_err(),
            PurserError::ExceedsBudget { .. }
        ));
    }

    #[test]
    fn settle_spent_equals_reserved() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        l.authorize(a);
        l.settle(a, 40).unwrap();
        assert_eq!(l.budget.completed, yocto(40));
        assert_eq!(l.budget.outstanding, yocto(0));
        assert_eq!(l.state(a), ReservationState::Confirmed);
    }

    #[test]
    fn settle_spent_zero_is_valid_confirmed() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        l.authorize(a);
        l.settle(a, 0).unwrap(); // proven zero-cost payment: full release, completed += 0
        assert_eq!(l.budget.completed, yocto(0));
        assert_eq!(l.budget.outstanding, yocto(0));
        assert_eq!(l.state(a), ReservationState::Confirmed);
    }

    #[test]
    fn settle_from_unknown_is_legal() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        l.authorize(a);
        l.timeout(a).unwrap(); // Unknown
        l.settle(a, 25).unwrap(); // later proof arrives
        assert_eq!(l.budget.completed, yocto(25));
        assert_eq!(l.budget.outstanding, yocto(0));
    }

    #[test]
    fn settle_rejects_spent_over_reserved() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        l.authorize(a);
        let before = l.budget.clone();
        let err = l.settle(a, 41).unwrap_err();
        assert!(matches!(err, PurserError::SpentExceedsReserved { .. }));
        assert_eq!(l.budget, before, "budget mutated on spent>reserved");
        assert_eq!(l.state(a), ReservationState::Signed);
    }

    #[test]
    fn settle_rejects_illegal_sources() {
        // From Reserved (no direct confirm).
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        assert!(matches!(
            l.settle(a, 10).unwrap_err(),
            PurserError::IllegalTransition { .. }
        ));
        // Double-settle: from Confirmed.
        let mut l = TestLedger::new(100);
        let b = l.reserve(40).unwrap();
        l.authorize(b);
        l.settle(b, 40).unwrap();
        let before = l.budget.clone();
        assert!(matches!(
            l.settle(b, 10).unwrap_err(),
            PurserError::IllegalTransition { .. }
        ));
        assert_eq!(
            l.budget, before,
            "double-settle must not double-count completed"
        );
    }

    #[test]
    fn release_failed_from_reserved_then_idempotent() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        l.fail(a).unwrap();
        assert_eq!(l.budget.outstanding, yocto(0));
        assert_eq!(l.state(a), ReservationState::Failed);
        // Idempotent re-call: zero accounting change (double-subtract regression).
        let before = l.budget.clone();
        l.fail(a).unwrap();
        assert_eq!(
            l.budget, before,
            "second release_failed must not subtract again"
        );
    }

    #[test]
    fn release_failed_rejects_unknown() {
        // no-release-on-silence: Unknown implies a signature existed.
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        l.authorize(a);
        l.timeout(a).unwrap(); // Unknown
        let before = l.budget.clone();
        assert!(matches!(
            l.fail(a).unwrap_err(),
            PurserError::IllegalTransition { .. }
        ));
        assert_eq!(l.budget, before);
    }

    #[test]
    fn mark_unknown_rejects_non_signed() {
        // From Reserved.
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        assert!(matches!(
            l.timeout(a).unwrap_err(),
            PurserError::IllegalTransition { .. }
        ));
        // From Unknown (the self-loop is NOT an operation).
        l.authorize(a);
        l.timeout(a).unwrap(); // Signed -> Unknown
        assert!(matches!(
            l.timeout(a).unwrap_err(),
            PurserError::IllegalTransition { .. }
        ));
    }

    #[test]
    fn cancel_from_unknown_then_double_cancel_rejects() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        l.authorize(a);
        l.timeout(a).unwrap(); // Unknown
        l.cancel(a).unwrap();
        assert_eq!(l.budget.outstanding, yocto(0));
        assert_eq!(l.state(a), ReservationState::Cancelled);
        let before = l.budget.clone();
        assert!(matches!(
            l.cancel(a).unwrap_err(),
            PurserError::IllegalTransition { .. }
        ));
        assert_eq!(l.budget, before, "double-cancel must not subtract again");
    }

    #[test]
    fn cancel_rejects_non_unknown() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        assert!(matches!(
            l.cancel(a).unwrap_err(),
            PurserError::IllegalTransition { .. }
        )); // Reserved
        l.authorize(a);
        assert!(matches!(
            l.cancel(a).unwrap_err(),
            PurserError::IllegalTransition { .. }
        )); // Signed
    }

    #[test]
    fn authorize_only_from_reserved() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(40).unwrap();
        let before = l.budget.clone();
        l.authorize(a);
        assert_eq!(l.budget, before, "authorize must not touch the budget");
        assert_eq!(l.state(a), ReservationState::Signed);
        // Re-authorize (now Signed) rejects.
        let i = l.index_of(a);
        assert!(matches!(
            authorize(&mut l.commitments[i], 2).unwrap_err(),
            PurserError::IllegalTransition { .. }
        ));
    }

    #[test]
    fn headroom_recycling() {
        let mut l = TestLedger::new(100);
        let a = l.reserve(100).unwrap(); // to the cap
        l.authorize(a);
        assert!(matches!(
            l.reserve(1).unwrap_err(),
            PurserError::ExceedsBudget { .. }
        ));
        l.settle(a, 60).unwrap(); // frees 40 of over-reservation
        let b = l.reserve(40).unwrap(); // admits into freed room
        l.check();
        assert_eq!(l.budget.completed, yocto(60));
        assert_eq!(l.budget.outstanding, yocto(40));
        let _ = b;
    }

    /// Universal property: every rejected op leaves (budget, commitment) unchanged.
    #[test]
    fn rejection_never_mutates() {
        // settle from Reserved
        {
            let mut l = TestLedger::new(100);
            let a = l.reserve(40).unwrap();
            let i = l.index_of(a);
            let (bb, cc) = (l.budget.clone(), l.commitments[i].clone());
            let _ = settle_confirmed(&mut l.budget, &mut l.commitments[i], yocto(10), 9);
            assert_eq!((l.budget.clone(), l.commitments[i].clone()), (bb, cc));
        }
        // settle spent>reserved from Signed
        {
            let mut l = TestLedger::new(100);
            let a = l.reserve(40).unwrap();
            l.authorize(a);
            let i = l.index_of(a);
            let (bb, cc) = (l.budget.clone(), l.commitments[i].clone());
            let _ = settle_confirmed(&mut l.budget, &mut l.commitments[i], yocto(999), 9);
            assert_eq!((l.budget.clone(), l.commitments[i].clone()), (bb, cc));
        }
        // release_failed from Signed
        {
            let mut l = TestLedger::new(100);
            let a = l.reserve(40).unwrap();
            l.authorize(a);
            let i = l.index_of(a);
            let (bb, cc) = (l.budget.clone(), l.commitments[i].clone());
            let _ = release_failed(&mut l.budget, &mut l.commitments[i], 9);
            assert_eq!((l.budget.clone(), l.commitments[i].clone()), (bb, cc));
        }
        // cancel from Signed
        {
            let mut l = TestLedger::new(100);
            let a = l.reserve(40).unwrap();
            l.authorize(a);
            let i = l.index_of(a);
            let (bb, cc) = (l.budget.clone(), l.commitments[i].clone());
            let _ = cancel(&mut l.budget, &mut l.commitments[i], 9);
            assert_eq!((l.budget.clone(), l.commitments[i].clone()), (bb, cc));
        }
    }
}
