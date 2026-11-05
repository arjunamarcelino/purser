//! Property-based proof of the Purser safety claims (Prompt 6; TECHNICAL §9A, TRD §11).
//!
//! Random op sequences are run against the code under test (SUT) and an independent reference
//! model, and three things are asserted after EVERY step:
//!
//! 1. **SUT state == model state.** Aggregates, per-commitment state, and the idempotency table.
//!    Because the model recomputes `completed`/`outstanding` from its own ledger, this subsumes
//!    ledger consistency, exactly-once authorization, outcome agreement, and
//!    rejection-never-mutates.
//! 2. **Invariant (I):** `completed + outstanding <= cap`.
//! 3. **No release on silence:** an op that carries no proof of outcome never decreases
//!    `outstanding`, and never moves a live (`Reserved | Signed | Unknown`) commitment anywhere
//!    except the zero-accounting `Reserved -> Signed` / `Signed -> Unknown` edges.
//!
//! Layer A (`core_*`) drives the pure, env-free accounting core, including the
//! `Signed -> Unknown -> Confirmed | Cancelled` edges the NEAR-native path never reaches
//! on-chain. Its propose composition is re-assembled here from the public pure fns. That is
//! acceptable only because Layer B (`contract_*`) drives the real `Purser` composition.
//!
//! Case counts default to the `with_cases` values below; `PROPTEST_CASES` overrides them.

use std::collections::BTreeMap;

use near_sdk::{AccountId, NearToken};
use proptest::prelude::*;
use proptest::sample::Index;
use purser_contract::{
    assert_invariant, authorize, cancel, classify, mark_unknown, release_failed, settle_confirmed,
    try_reserve, Chain, Commitment, IdemDecision, IdemState, PaymentIntent, PurserError,
    ReservationState, TaskBudget, TokenSpec,
};

// ==== shared vocabulary =========================================================================

const DELEGATES: usize = 3;
const REQUEST_IDS: u8 = 6;

/// `(delegate index, request id)`: the idempotency key, in model terms.
type Key = (usize, u8);

fn delegate_id(d: usize) -> AccountId {
    format!("d{d}.test.near").parse().unwrap()
}

fn request_id(r: u8) -> String {
    format!("req-{r}")
}

fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

/// A live commitment still holds budget (`outstanding`).
fn is_live(s: ReservationState) -> bool {
    use ReservationState::*;
    matches!(s, Reserved | Signed | Unknown)
}

/// How an amount is chosen, resolved against the model's state at execution time so the
/// interesting boundaries (zero, exact fit, one over, overflow) are hit on purpose.
#[derive(Clone, Copy, Debug)]
enum Amount {
    /// `per_mille` of `cap / 2`, floored at 1.
    Normal(u16),
    Zero,
    ExactFit,
    OneOver,
    Cap,
    Max,
}

fn amount_strategy() -> impl Strategy<Value = Amount> {
    prop_oneof![
        8 => (1u16..=1000).prop_map(Amount::Normal),
        1 => Just(Amount::Zero),
        1 => Just(Amount::ExactFit),
        1 => Just(Amount::OneOver),
        1 => Just(Amount::Cap),
        1 => Just(Amount::Max),
    ]
}

fn resolve_amount(a: Amount, cap: u128, used: u128) -> u128 {
    match a {
        Amount::Normal(p) => {
            let half = cap / 2;
            // multiply first when it cannot overflow (precision on small caps); divide first on
            // the u128::MAX/2 cap
            let v = if half < (1u128 << 100) {
                half * p as u128 / 1000
            } else {
                half / 1000 * p as u128
            };
            v.max(1)
        }
        Amount::Zero => 0,
        Amount::ExactFit => cap - used,
        Amount::OneOver => (cap - used).saturating_add(1),
        Amount::Cap => cap,
        Amount::Max => u128::MAX,
    }
}

fn cap_strategy() -> impl Strategy<Value = u128> {
    prop_oneof![Just(100u128), Just(1_000u128), Just(u128::MAX / 2)]
}

// ==== Layer A: pure core ========================================================================

#[derive(Clone, Debug)]
enum CoreOp {
    Propose {
        d: usize,
        r: u8,
        amount: Amount,
    },
    /// Re-propose the key of an existing commitment (the retry path; never a new reservation).
    Retry {
        pick: Index,
    },
    /// An authorization/signature now exists (`Reserved -> Signed`).
    Sign {
        pick: Index,
    },
    /// Outcome proven: `Signed | Unknown -> Confirmed(spent <= reserved)`.
    SettleOk {
        pick: Index,
        spent_per_mille: u16,
    },
    /// Failed BEFORE any signature existed: `Reserved -> Failed`, safe release.
    FailPreSig {
        pick: Index,
    },
    /// Timed out / no proof yet: `Signed -> Unknown`, zero accounting.
    Timeout {
        pick: Index,
    },
    /// Attested nonce-burn cancel: `Unknown -> Cancelled`, safe release.
    CancelAttested {
        pick: Index,
    },
    Revoke {
        d: usize,
    },
    /// Time passes and nothing is delivered (the clock also advances by one on every step). The
    /// silence check below is what this op exercises.
    Tick,
}

impl CoreOp {
    /// Only these ops carry a positive proof of outcome, so only they may release budget.
    fn carries_proof(&self) -> bool {
        matches!(
            self,
            CoreOp::SettleOk { .. } | CoreOp::FailPreSig { .. } | CoreOp::CancelAttested { .. }
        )
    }
}

fn core_op_strategy() -> impl Strategy<Value = CoreOp> {
    prop_oneof![
        6 => (0..DELEGATES, 0..REQUEST_IDS, amount_strategy())
            .prop_map(|(d, r, amount)| CoreOp::Propose { d, r, amount }),
        2 => any::<Index>().prop_map(|pick| CoreOp::Retry { pick }),
        3 => any::<Index>().prop_map(|pick| CoreOp::Sign { pick }),
        3 => (any::<Index>(), 0u16..=1100)
            .prop_map(|(pick, spent_per_mille)| CoreOp::SettleOk { pick, spent_per_mille }),
        2 => any::<Index>().prop_map(|pick| CoreOp::FailPreSig { pick }),
        2 => any::<Index>().prop_map(|pick| CoreOp::Timeout { pick }),
        1 => any::<Index>().prop_map(|pick| CoreOp::CancelAttested { pick }),
        // d0 is never revoked (revocation is terminal, as in the contract), so late proposals in a
        // long sequence are not starved
        1 => (1..DELEGATES).prop_map(|d| CoreOp::Revoke { d }),
        1 => Just(CoreOp::Tick),
    ]
}

/// What an op did. Compared SUT-vs-model, so a wrong refusal reason is a failure too.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Outcome {
    Admitted(u64),
    Replay(u64),
    InFlight,
    AlreadyFailed,
    NotAuthorized,
    ZeroAmount,
    Overflow,
    ExceedsBudget,
    Applied,
    SpentExceeds,
    Illegal,
    NoOp,
}

fn outcome_of(e: &PurserError) -> Outcome {
    match e {
        PurserError::ExceedsBudget { .. } => Outcome::ExceedsBudget,
        PurserError::ArithmeticOverflow => Outcome::Overflow,
        PurserError::ZeroAmount => Outcome::ZeroAmount,
        PurserError::SpentExceedsReserved { .. } => Outcome::SpentExceeds,
        PurserError::IllegalTransition { .. } => Outcome::Illegal,
        other => panic!("pure core returned an unexpected error: {other:?}"),
    }
}

/// The pure core, composed the way `propose_payment` composes it (auth -> classify -> reserve
/// -> `Pending`, in one step).
#[derive(Clone, PartialEq, Debug)]
struct CoreSut {
    budget: TaskBudget,
    commitments: Vec<Commitment>,
    idem: BTreeMap<(AccountId, String), IdemState>,
    active: [bool; DELEGATES],
    now: u64,
}

impl CoreSut {
    fn new(cap: u128) -> Self {
        CoreSut {
            budget: TaskBudget {
                owner: "owner.test.near".parse().unwrap(),
                token: TokenSpec::NearNative,
                cap: yocto(cap),
                completed: NearToken::ZERO,
                outstanding: NearToken::ZERO,
                crew_cap: DELEGATES as u8,
                created_at: 0,
                active_crew: DELEGATES as u8,
                frozen: false,
            },
            commitments: Vec::new(),
            idem: BTreeMap::new(),
            active: [true; DELEGATES],
            now: 0,
        }
    }

    fn propose(&mut self, (d, r): Key, amount: u128) -> Outcome {
        if !self.active[d] {
            return Outcome::NotAuthorized;
        }
        let key = (delegate_id(d), request_id(r));
        match classify(self.idem.get(&key)) {
            IdemDecision::Replay { commitment_id } => return Outcome::Replay(commitment_id),
            IdemDecision::InFlight => return Outcome::InFlight,
            IdemDecision::AlreadyFailed => return Outcome::AlreadyFailed,
            IdemDecision::Fresh => {}
        }
        let id = self.commitments.len() as u64;
        let intent = PaymentIntent {
            chain: Chain::NearNative,
            recipient: "merchant.test.near".to_string(),
            amount: yocto(amount),
            token: TokenSpec::NearNative,
            memo: None,
        };
        match try_reserve(
            &mut self.budget,
            id,
            "t1".to_string(),
            key.0.clone(),
            intent,
            key.1.clone(),
            self.now,
        ) {
            Ok(c) => {
                self.commitments.push(c);
                self.idem.insert(key, IdemState::Pending);
                Outcome::Admitted(id)
            }
            Err(e) => outcome_of(&e),
        }
    }

    /// Run a core mutator on commitment `i`, then apply the idempotency write that the contract
    /// boundary performs on that resolution.
    fn resolve(
        &mut self,
        i: usize,
        f: impl FnOnce(&mut TaskBudget, &mut Commitment, u64) -> Result<(), PurserError>,
        idem_on_ok: Option<IdemState>,
    ) -> Outcome {
        let now = self.now;
        match f(&mut self.budget, &mut self.commitments[i], now) {
            Ok(()) => {
                if let Some(s) = idem_on_ok {
                    let c = &self.commitments[i];
                    self.idem
                        .insert((c.delegate.clone(), c.request_id.clone()), s);
                }
                Outcome::Applied
            }
            Err(e) => outcome_of(&e),
        }
    }
}

#[derive(Clone, Debug)]
struct ModelCommit {
    key: Key,
    reserved: u128,
    spent: Option<u128>,
    state: ReservationState,
}

/// Independent reference model: plain `u128` arithmetic and its own legal-edge rules. It never
/// calls contract code.
#[derive(Clone, Debug)]
struct CoreModel {
    cap: u128,
    commits: Vec<ModelCommit>,
    idem: BTreeMap<Key, IdemState>,
    active: [bool; DELEGATES],
}

impl CoreModel {
    fn new(cap: u128) -> Self {
        CoreModel {
            cap,
            commits: Vec::new(),
            idem: BTreeMap::new(),
            active: [true; DELEGATES],
        }
    }

    fn outstanding(&self) -> u128 {
        self.commits
            .iter()
            .filter(|c| is_live(c.state))
            .map(|c| c.reserved)
            .sum()
    }

    fn completed(&self) -> u128 {
        self.commits
            .iter()
            .filter(|c| c.state == ReservationState::Confirmed)
            .map(|c| c.spent.expect("confirmed commitment has a spent amount"))
            .sum()
    }

    fn used(&self) -> u128 {
        self.completed() + self.outstanding()
    }

    fn propose(&mut self, key: Key, amount: u128) -> Outcome {
        if !self.active[key.0] {
            return Outcome::NotAuthorized;
        }
        match self.idem.get(&key) {
            Some(IdemState::Pending) => return Outcome::InFlight,
            Some(IdemState::Failed) => return Outcome::AlreadyFailed,
            Some(IdemState::Committed { commitment_id }) => return Outcome::Replay(*commitment_id),
            None => {}
        }
        if amount == 0 {
            return Outcome::ZeroAmount;
        }
        let Some(projected) = self.used().checked_add(amount) else {
            return Outcome::Overflow;
        };
        if projected > self.cap {
            return Outcome::ExceedsBudget;
        }
        let id = self.commits.len() as u64;
        self.commits.push(ModelCommit {
            key,
            reserved: amount,
            spent: None,
            state: ReservationState::Reserved,
        });
        self.idem.insert(key, IdemState::Pending);
        Outcome::Admitted(id)
    }

    /// Move commitment `i` from one of `from` to `to`, or report an illegal edge.
    fn edge(&mut self, i: usize, from: &[ReservationState], to: ReservationState) -> Outcome {
        if !from.contains(&self.commits[i].state) {
            return Outcome::Illegal;
        }
        self.commits[i].state = to;
        Outcome::Applied
    }
}

/// Spent amount for a settle: `per_mille` of the reservation, so `1000` settles in full and
/// `> 1000` over-spends (which the core must refuse). Same overflow-safe ordering as `Amount`.
fn spent_for(reserved: u128, per_mille: u16) -> u128 {
    if reserved < (1u128 << 100) {
        reserved * per_mille as u128 / 1000
    } else {
        reserved / 1000 * per_mille as u128
    }
}

/// Apply one op to both SUT and model; return both outcomes.
fn step_core(sut: &mut CoreSut, model: &mut CoreModel, op: &CoreOp) -> (Outcome, Outcome) {
    use ReservationState::*;
    sut.now += 1;
    let pick = |p: &Index| -> Option<usize> {
        (!model.commits.is_empty()).then(|| p.index(model.commits.len()))
    };
    match op {
        CoreOp::Propose { d, r, amount } => {
            let a = resolve_amount(*amount, model.cap, model.used());
            (sut.propose((*d, *r), a), model.propose((*d, *r), a))
        }
        CoreOp::Retry { pick: p } => match pick(p) {
            None => (Outcome::NoOp, Outcome::NoOp),
            Some(i) => {
                let (key, a) = (model.commits[i].key, model.commits[i].reserved);
                (sut.propose(key, a), model.propose(key, a))
            }
        },
        CoreOp::Sign { pick: p } => match pick(p) {
            None => (Outcome::NoOp, Outcome::NoOp),
            Some(i) => (
                sut.resolve(i, |_, c, now| authorize(c, now), None),
                model.edge(i, &[Reserved], Signed),
            ),
        },
        CoreOp::SettleOk {
            pick: p,
            spent_per_mille,
        } => match pick(p) {
            None => (Outcome::NoOp, Outcome::NoOp),
            Some(i) => {
                let spent = spent_for(model.commits[i].reserved, *spent_per_mille);
                let s = sut.resolve(
                    i,
                    |b, c, now| settle_confirmed(b, c, yocto(spent), now),
                    Some(IdemState::Committed {
                        commitment_id: i as u64,
                    }),
                );
                // settle_confirmed checks the edge first, then the amount
                let m = if !matches!(model.commits[i].state, Signed | Unknown) {
                    Outcome::Illegal
                } else if spent > model.commits[i].reserved {
                    Outcome::SpentExceeds
                } else {
                    model.edge(i, &[Signed, Unknown], Confirmed)
                };
                if m == Outcome::Applied {
                    model.commits[i].spent = Some(spent);
                    model.idem.insert(
                        model.commits[i].key,
                        IdemState::Committed {
                            commitment_id: i as u64,
                        },
                    );
                }
                (s, m)
            }
        },
        CoreOp::FailPreSig { pick: p } => match pick(p) {
            None => (Outcome::NoOp, Outcome::NoOp),
            Some(i) => {
                let already_failed = model.commits[i].state == Failed;
                let s = sut.resolve(i, release_failed, Some(IdemState::Failed));
                // `release_failed` is idempotent on `Failed` (no accounting change).
                let m = if already_failed {
                    Outcome::Applied
                } else {
                    model.edge(i, &[Reserved], Failed)
                };
                if m == Outcome::Applied {
                    model.idem.insert(model.commits[i].key, IdemState::Failed);
                }
                (s, m)
            }
        },
        CoreOp::Timeout { pick: p } => match pick(p) {
            None => (Outcome::NoOp, Outcome::NoOp),
            Some(i) => (
                sut.resolve(i, |_, c, now| mark_unknown(c, now), None),
                model.edge(i, &[Signed], Unknown),
            ),
        },
        CoreOp::CancelAttested { pick: p } => match pick(p) {
            None => (Outcome::NoOp, Outcome::NoOp),
            Some(i) => {
                let s = sut.resolve(i, cancel, Some(IdemState::Failed));
                let m = model.edge(i, &[Unknown], Cancelled);
                if m == Outcome::Applied {
                    model.idem.insert(model.commits[i].key, IdemState::Failed);
                }
                (s, m)
            }
        },
        CoreOp::Revoke { d } => {
            sut.active[*d] = false;
            model.active[*d] = false;
            (Outcome::Applied, Outcome::Applied)
        }
        CoreOp::Tick => (Outcome::NoOp, Outcome::NoOp),
    }
}

fn check_core(
    op: &CoreOp,
    before: &CoreSut,
    sut: &CoreSut,
    model: &CoreModel,
    outcomes: (Outcome, Outcome),
) -> Result<(), TestCaseError> {
    let (s, m) = outcomes;
    // (1) SUT state == model state.
    prop_assert_eq!(s, m, "outcome disagrees with the model");
    prop_assert_eq!(sut.budget.outstanding, yocto(model.outstanding()));
    prop_assert_eq!(sut.budget.completed, yocto(model.completed()));
    prop_assert_eq!(sut.commitments.len(), model.commits.len());
    for (c, mc) in sut.commitments.iter().zip(&model.commits) {
        prop_assert_eq!(&c.delegate, &delegate_id(mc.key.0));
        prop_assert_eq!(&c.request_id, &request_id(mc.key.1));
        prop_assert_eq!(c.state, mc.state);
        prop_assert_eq!(c.reserved_amount, yocto(mc.reserved));
        prop_assert_eq!(c.actual_spent, mc.spent.map(yocto));
    }
    let model_idem: BTreeMap<_, _> = model
        .idem
        .iter()
        .map(|(&(d, r), s)| ((delegate_id(d), request_id(r)), *s))
        .collect();
    prop_assert_eq!(&sut.idem, &model_idem);
    // A refused or illegal op leaves the SUT byte-identical (apart from the injected clock).
    if !matches!(s, Outcome::Admitted(_) | Outcome::Applied) {
        let mut b = before.clone();
        b.now = sut.now;
        prop_assert_eq!(&b, sut, "a rejected op mutated state");
    }
    // Exactly-once, on the SUT: a (delegate, request_id) key owns at most one commitment, and a
    // replay names a settled commitment of that very key.
    let mut seen = BTreeMap::new();
    for c in &sut.commitments {
        prop_assert!(
            seen.insert((&c.delegate, &c.request_id), c.id).is_none(),
            "two authorizations for one key"
        );
    }
    if let Outcome::Replay(cid) = s {
        let c = &sut.commitments[cid as usize];
        prop_assert_eq!(c.state, ReservationState::Confirmed);
        prop_assert_eq!(seen.get(&(&c.delegate, &c.request_id)), Some(&cid));
    }

    // (2) Invariant (I), on the SUT's own aggregates.
    assert_invariant(&sut.budget);
    prop_assert!(
        sut.budget
            .completed
            .checked_add(sut.budget.outstanding)
            .unwrap()
            <= sut.budget.cap
    );

    // (3) No release on silence.
    if !op.carries_proof() {
        prop_assert!(sut.budget.outstanding >= before.budget.outstanding);
        for (old, new) in before.commitments.iter().zip(&sut.commitments) {
            if is_live(old.state) {
                use ReservationState::*;
                let allowed = old.state == new.state
                    || (old.state, new.state) == (Reserved, Signed)
                    || (old.state, new.state) == (Signed, Unknown);
                prop_assert!(allowed, "{:?} -> {:?} without proof", old.state, new.state);
            }
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    /// Layer A: invariant, exactly-once, and no-release-on-silence over the pure core.
    #[test]
    fn core_invariants_hold_over_random_interleavings(
        cap in cap_strategy(),
        ops in prop::collection::vec(core_op_strategy(), 1..64),
    ) {
        let mut sut = CoreSut::new(cap);
        let mut model = CoreModel::new(cap);
        for op in &ops {
            let before = sut.clone();
            let outcomes = step_core(&mut sut, &mut model, op);
            check_core(op, &before, &sut, &model, outcomes)?;
        }
    }
}

// ==== Layer B: the real `Purser` composition ====================================================
//
// Drives the actual `#[near]` struct under near-sdk's mocked VM, emulating NEAR's per-call
// semantics: state is loaded from storage before each call and flushed after a successful one.
// A panicking call has its in-memory struct discarded unflushed (`mem::forget`), which leaves
// storage at its pre-call bytes, exactly like the runtime's rollback. Callbacks are delivered in
// any order, or lost, so many reservations are in flight at once.

mod contract_layer {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{env, testing_env, PromiseError, PromiseOrValue};
    use purser_contract::{
        Purser, MSG_ALREADY_FAILED, MSG_CREW_CAP_REACHED, MSG_DELEGATE_EXISTS,
        MSG_DELEGATE_NOT_AUTHORIZED, MSG_EXCEEDS_BUDGET, MSG_IN_FLIGHT, MSG_NOT_RECONCILABLE,
        MSG_NO_SUCH_DELEGATE, MSG_OVERFLOW, MSG_RECIPIENT_NOT_ALLOWED, MSG_RECONCILE_TOO_EARLY,
        MSG_REQUEST_ID_REUSED, MSG_TASK_FROZEN, MSG_ZERO_AMOUNT, RECONCILE_MIN_AGE_NS,
    };
    use std::cell::Cell;
    use std::panic::{self, AssertUnwindSafe};
    use std::sync::Once;

    const TASKS: [&str; 2] = ["t1", "t2"];
    /// `d0`, `d1`, and the OWNER, who is also registered as a delegate (owner-as-delegate).
    const ACTORS: usize = 3;
    const OWNER: usize = 2;
    const RIDS: u8 = 4;
    /// 0 = merchant (allowlisted on both tasks), 1 = removable (t1 only, toggled), 2 = stranger.
    const RECIPIENTS: [&str; 3] = [
        "merchant.test.near",
        "removable.test.near",
        "stranger.test.near",
    ];
    /// Memos a proposal may carry. The first two are the same request (no memo == empty memo);
    /// the others differ, so a reused request_id with another memo must be refused.
    const MEMOS: [Option<&str>; 4] = [None, Some(""), Some("note"), Some("other")];

    /// The reconcile time-lock as SPECIFIED (10 minutes), stated independently of the contract's
    /// constant so the model does not borrow the logic under test; `run` asserts they agree.
    const SPEC_RECONCILE_MIN_AGE_NS: u64 = 600 * 1_000_000_000;
    /// Block timestamp the mocked chain starts at.
    const GENESIS_NS: u64 = 1_000_000_000;

    fn contract_id() -> AccountId {
        "purser.test.near".parse().unwrap()
    }
    fn actor(a: usize) -> AccountId {
        if a == OWNER {
            "owner.test.near".parse().unwrap()
        } else {
            delegate_id(a)
        }
    }

    // ---- quiet, catchable panics --------------------------------------------------------------

    thread_local!(static EXPECTING_PANIC: Cell<bool> = const { Cell::new(false) });
    static QUIET_HOOK: Once = Once::new();

    /// Silence ONLY the panics this harness deliberately provokes; every other panic (including
    /// Layer A failures in the same binary) still reaches the default hook.
    fn install_quiet_hook() {
        QUIET_HOOK.call_once(|| {
            let default = panic::take_hook();
            panic::set_hook(Box::new(move |info| {
                if !EXPECTING_PANIC.with(Cell::get) {
                    default(info)
                }
            }));
        });
    }

    fn catch<R>(f: impl FnOnce() -> R) -> Result<R, String> {
        EXPECTING_PANIC.with(|e| e.set(true));
        let r = panic::catch_unwind(AssertUnwindSafe(f));
        EXPECTING_PANIC.with(|e| e.set(false));
        r.map_err(|p| {
            p.downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default()
        })
    }

    fn set_ctx(predecessor: AccountId, now: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(contract_id())
            .predecessor_account_id(predecessor)
            .block_timestamp(now)
            // the model does not track the contract's balance; transfers must never be refused for it
            .account_balance(NearToken::from_yoctonear(u128::MAX))
            .build());
    }

    // ---- ops -----------------------------------------------------------------------------------

    #[derive(Clone, Debug)]
    pub enum Op {
        Propose {
            task: usize,
            who: usize,
            r: u8,
            amount: Amount,
            recipient: usize,
            /// Index into `MEMOS`; `None` and `Some("")` are the same request.
            memo: usize,
            /// Hidden real-world outcome of the transfer this proposal would issue.
            transfer_ok: bool,
        },
        /// Re-send a prior commitment's request (task, delegate, request_id, amount, recipient).
        /// With `memo: None` it is the exact honest retry, which must replay, report in-flight, or
        /// report failed, and never open a second reservation. With `Some(m)` only the memo
        /// changes: the same request when canonically equal, otherwise a refused reuse.
        Retry {
            pick: Index,
            memo: Option<usize>,
        },
        /// Deliver any undelivered callback (any order, any delay: NEAR bounds neither) with its
        /// real outcome. A callback that is never delivered is the lost-callback residual.
        Deliver {
            pick: Index,
        },
        /// Owner reconcile of any undelivered callback. An `honest` owner attests the transfer's
        /// observed final outcome; otherwise it attests `guess`, i.e. on silence. A wrong guess
        /// is what a later delivery must contradict.
        Reconcile {
            pick: Index,
            honest: bool,
            guess: bool,
        },
        Revoke {
            task: usize,
            who: usize,
        },
        AddDelegate {
            task: usize,
            who: usize,
        },
        RemoveAllowlist,
        ReAddAllowlist,
        Tick {
            secs: u64,
        },
    }

    impl Op {
        fn carries_proof(&self) -> bool {
            matches!(self, Op::Deliver { .. } | Op::Reconcile { .. })
        }
    }

    pub fn op_strategy() -> impl Strategy<Value = Op> {
        prop_oneof![
            8 => (0..2usize, 0..ACTORS, 0..RIDS, amount_strategy(), 0..3usize, 0..MEMOS.len(), prop::bool::weighted(0.8))
                .prop_map(|(task, who, r, amount, recipient, memo, transfer_ok)| Op::Propose {
                    task, who, r, amount, recipient, memo, transfer_ok,
                }),
            3 => (any::<Index>(), prop::option::of(0..MEMOS.len()))
                .prop_map(|(pick, memo)| Op::Retry { pick, memo }),
            4 => any::<Index>().prop_map(|pick| Op::Deliver { pick }),
            2 => (any::<Index>(), prop::bool::weighted(0.6), any::<bool>())
                .prop_map(|(pick, honest, guess)| Op::Reconcile { pick, honest, guess }),
            1 => (0..2usize, 0..ACTORS).prop_map(|(task, who)| Op::Revoke { task, who }),
            1 => (0..2usize, 0..ACTORS).prop_map(|(task, who)| Op::AddDelegate { task, who }),
            1 => Just(Op::RemoveAllowlist),
            1 => Just(Op::ReAddAllowlist),
            // short ticks, and long ones that straddle the 600 s reconcile lock on purpose
            2 => prop_oneof![1u64..=10, 590u64..=900].prop_map(|secs| Op::Tick { secs }),
        ]
    }

    // ---- model ---------------------------------------------------------------------------------

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Callback {
        Undelivered,
        Delivered,
    }

    #[derive(Clone, Debug)]
    struct Commit {
        task: usize,
        key: Key,
        amount: u128,
        recipient: usize,
        memo: usize,
        state: ReservationState,
        spent: Option<u128>,
        created_at: u64,
        transfer_ok: bool,
        callback: Callback,
    }

    /// What a call is predicted to (or did) return.
    #[derive(Clone, PartialEq, Eq, Debug)]
    enum Out {
        Promise(u64),
        Value(u64),
        Panic(&'static str),
        Done,
        NoOp,
    }

    #[derive(Clone, Debug)]
    struct Model {
        caps: [u128; 2],
        commits: Vec<Commit>,
        idem: BTreeMap<Key, IdemState>,
        /// `registered[task][actor] = Some(active)`.
        registered: [[Option<bool>; ACTORS]; 2],
        removable_allowed: bool,
        now: u64,
        /// Value whose transfer actually executes (scheduled with `transfer_ok`), per task. The
        /// money-flow oracle: it must never exceed `completed + outstanding`.
        outflow: [u128; 2],
        /// Tasks frozen by a contradicted reconcile.
        frozen: [bool; 2],
    }

    impl Model {
        fn new(caps: [u128; 2]) -> Self {
            Model {
                caps,
                commits: Vec::new(),
                idem: BTreeMap::new(),
                registered: [
                    [Some(true), Some(true), Some(true)],
                    [Some(true), None, Some(true)],
                ],
                removable_allowed: true,
                now: GENESIS_NS,
                outflow: [0; 2],
                frozen: [false; 2],
            }
        }
        fn outstanding(&self, t: usize) -> u128 {
            self.commits
                .iter()
                .filter(|c| c.task == t && is_live(c.state))
                .map(|c| c.amount)
                .sum()
        }
        fn completed(&self, t: usize) -> u128 {
            self.commits
                .iter()
                .filter(|c| c.task == t && c.state == ReservationState::Confirmed)
                .map(|c| c.spent.unwrap())
                .sum()
        }
        fn used(&self, t: usize) -> u128 {
            self.completed(t) + self.outstanding(t)
        }
        fn allowlisted(&self, t: usize, rcp: usize) -> bool {
            match (t, rcp) {
                (_, 0) => true,
                (0, 1) => self.removable_allowed,
                _ => false,
            }
        }
        /// Value a wrong `reconcile(false)` released although its transfer executed, and whose
        /// callback has not yet arrived to contradict it: the only money the books can miss.
        fn unproven_release(&self, t: usize) -> u128 {
            self.commits
                .iter()
                .filter(|c| {
                    c.task == t
                        && c.state == ReservationState::Failed
                        && c.transfer_ok
                        && c.callback == Callback::Undelivered
                })
                .map(|c| c.amount)
                .sum()
        }
        fn active_crew(&self, t: usize) -> usize {
            self.registered[t]
                .iter()
                .filter(|r| **r == Some(true))
                .count()
        }
    }

    // ---- SUT -----------------------------------------------------------------------------------

    struct Sut {
        /// The `EVENT_JSON` logs of the last successful call.
        logs: std::cell::RefCell<Vec<String>>,
    }

    impl Sut {
        fn setup(caps: [u128; 2]) -> Self {
            install_quiet_hook();
            // Each proptest case starts from empty storage (`testing_env!` carries it over).
            // UPGRADE HAZARD: this harness relies on near-sdk mock internals (`take_storage`,
            // flush-on-drop, unwinding `panic_utf8`); re-verify them when bumping near-sdk.
            near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
            set_ctx(actor(OWNER), GENESIS_NS);
            let mut c = Purser::new(actor(OWNER), "v1.signer-prod.testnet".parse().unwrap());
            for (t, cap) in TASKS.iter().zip(caps) {
                c.create_task(t.to_string(), yocto(cap), TokenSpec::NearNative, 3);
            }
            for a in 0..ACTORS {
                c.add_delegate("t1".into(), actor(a), "m/0".into());
            }
            for a in [0, OWNER] {
                c.add_delegate("t2".into(), actor(a), "m/0".into());
            }
            c.set_recipient_allowlist(
                "t1".into(),
                vec![RECIPIENTS[0].into(), RECIPIENTS[1].into()],
            );
            c.set_recipient_allowlist("t2".into(), vec![RECIPIENTS[0].into()]);
            env::state_write(&c);
            drop(c); // flush the store caches
            Sut {
                logs: Default::default(),
            }
        }

        /// One NEAR function call: load, run, then flush on success or discard on panic.
        /// On panic, every view must still read the pre-call state (validate-before-mutate).
        fn call<R>(
            &self,
            before: &Snap,
            who: AccountId,
            now: u64,
            f: impl FnOnce(&mut Purser) -> R,
        ) -> Result<Result<R, String>, TestCaseError> {
            set_ctx(who, now);
            let mut c: Purser = env::state_read().unwrap();
            match catch(|| f(&mut c)) {
                Ok(r) => {
                    env::state_write(&c);
                    drop(c);
                    *self.logs.borrow_mut() = near_sdk::test_utils::get_logs();
                    Ok(Ok(r))
                }
                Err(msg) => {
                    let after = snapshot(&c);
                    std::mem::forget(c); // never flush a call that the runtime would roll back
                    prop_assert_eq!(before, &after, "panicking call mutated state: {}", msg);
                    Ok(Err(msg))
                }
            }
        }
    }

    type Snap = (
        Vec<Option<TaskBudget>>,
        Vec<Commitment>,
        Vec<Option<IdemState>>,
        Option<Commitment>,
    );

    /// Every observable key, not just the ones an op touched, so a write to the wrong key shows.
    fn snapshot(c: &Purser) -> Snap {
        let tasks = TASKS.iter().map(|t| c.get_task(t.to_string())).collect();
        let mut commits: Vec<Commitment> = TASKS
            .iter()
            .flat_map(|t| c.list_commitments(t.to_string(), 0, u32::MAX))
            .collect();
        commits.sort_by_key(|x| x.id);
        let idem = (0..ACTORS)
            .flat_map(|a| (0..RIDS).map(move |r| (a, r)))
            .map(|(a, r)| c.get_idempotency(actor(a), request_id(r)))
            .collect();
        let next = c.get_commitment(commits.len() as u64);
        (tasks, commits, idem, next)
    }

    fn intent(amount: u128, recipient: usize, memo: usize) -> PaymentIntent {
        PaymentIntent {
            chain: Chain::NearNative,
            recipient: RECIPIENTS[recipient].to_string(),
            amount: yocto(amount),
            token: TokenSpec::NearNative,
            memo: MEMOS[memo].map(str::to_string),
        }
    }

    /// The memo as the spec compares it: an empty memo is no memo.
    fn canonical_memo(memo: usize) -> &'static str {
        MEMOS[memo].unwrap_or("")
    }

    fn panic_out(msg: &str, expected: &[&'static str]) -> Out {
        expected
            .iter()
            .find(|m| msg.contains(**m))
            .map(|m| Out::Panic(m))
            .unwrap_or_else(|| panic!("unexpected panic message: {msg}"))
    }

    const ALL_MSGS: &[&str] = &[
        MSG_TASK_FROZEN,
        purser_contract::MSG_ILLEGAL,
        MSG_REQUEST_ID_REUSED,
        MSG_RECONCILE_TOO_EARLY,
        MSG_DELEGATE_NOT_AUTHORIZED,
        MSG_IN_FLIGHT,
        MSG_ALREADY_FAILED,
        MSG_RECIPIENT_NOT_ALLOWED,
        MSG_ZERO_AMOUNT,
        MSG_OVERFLOW,
        MSG_EXCEEDS_BUDGET,
        MSG_NOT_RECONCILABLE,
        MSG_DELEGATE_EXISTS,
        MSG_CREW_CAP_REACHED,
        MSG_NO_SUCH_DELEGATE,
    ];

    fn to_out<T>(r: Result<T, String>, ok: impl FnOnce(T) -> Out) -> Out {
        match r {
            Ok(v) => ok(v),
            Err(m) => panic_out(&m, ALL_MSGS),
        }
    }

    /// `(event, commitment_id)` of every NEP-297 event the last successful call emitted.
    fn events(sut: &Sut) -> Vec<(String, Option<u64>)> {
        sut.logs
            .borrow()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| {
                let v: serde_json::Value = serde_json::from_str(j).unwrap();
                let name = v["event"].as_str().unwrap().to_string();
                (name, v["data"]["commitment_id"].as_u64())
            })
            .collect()
    }

    // ---- step ----------------------------------------------------------------------------------

    /// Apply `op` to the contract and to the model; return (actual, predicted).
    fn step(sut: &Sut, before: &Snap, m: &mut Model, op: &Op) -> Result<(Out, Out), TestCaseError> {
        use ReservationState::*;
        let pending: Vec<usize> = (0..m.commits.len())
            .filter(|&i| m.commits[i].callback == Callback::Undelivered)
            .collect();
        let owner = actor(OWNER);
        let now = m.now;
        Ok(match op {
            Op::Propose {
                task,
                who,
                r,
                amount,
                recipient,
                memo,
                transfer_ok,
            } => {
                let (t, key) = (*task, (*who, *r));
                let a = resolve_amount(*amount, m.caps[t], m.used(t));
                let actual = sut.call(before, actor(*who), now, |c| {
                    c.propose_payment(
                        TASKS[t].into(),
                        intent(a, *recipient, *memo),
                        request_id(*r),
                    )
                })?;
                // A fresh admission returns a Promise; its cid is the one `payment_reserved` names
                // (the indexer's wire), never assumed from the ledger length.
                let actual = to_out(actual, |v| match v {
                    PromiseOrValue::Promise(_) => match events(sut).as_slice() {
                        [(e, Some(cid))] if e == "payment_reserved" => Out::Promise(*cid),
                        other => panic!("a fresh admission emitted {other:?}"),
                    },
                    PromiseOrValue::Value(cid) => Out::Value(cid),
                });
                let predicted = predict_propose(m, t, key, a, *recipient, *memo, *transfer_ok);
                (actual, predicted)
            }
            Op::Retry { pick, memo: swap } => {
                if m.commits.is_empty() {
                    return Ok((Out::NoOp, Out::NoOp));
                }
                let c = &m.commits[pick.index(m.commits.len())];
                let (t, key, a, rcp) = (c.task, c.key, c.amount, c.recipient);
                let memo = swap.unwrap_or(c.memo);
                let actual = sut.call(before, actor(key.0), now, |k| {
                    k.propose_payment(TASKS[t].into(), intent(a, rcp, memo), request_id(key.1))
                })?;
                let actual = to_out(actual, |v| match v {
                    PromiseOrValue::Promise(_) => Out::Promise(u64::MAX),
                    PromiseOrValue::Value(cid) => Out::Value(cid),
                });
                // a key that has a commitment always has an idempotency entry, so this never admits
                (actual, predict_propose(m, t, key, a, rcp, memo, false))
            }
            Op::Deliver { pick } => {
                if pending.is_empty() {
                    return Ok((Out::NoOp, Out::NoOp));
                }
                let i = pending[pick.index(pending.len())];
                let ok = m.commits[i].transfer_ok;
                let rid = request_id(m.commits[i].key.1);
                let res = if ok {
                    Ok(())
                } else {
                    Err(PromiseError::Failed)
                };
                let actual = sut.call(before, contract_id(), now, |c| {
                    c.on_near_settled(i as u64, rid, res)
                })?;
                let actual = to_out(actual, |_| Out::Done);
                let emitted: Vec<String> = events(sut).into_iter().map(|(e, _)| e).collect();
                let c = &mut m.commits[i];
                c.callback = Callback::Delivered;
                let expected_event = match (c.state, ok) {
                    (Reserved, true) => Some("payment_confirmed"),
                    (Reserved, false) => Some("payment_failed"),
                    (Failed, true) | (Confirmed, false) => Some("reconcile_contradicted"),
                    _ => None,
                };
                prop_assert_eq!(
                    emitted,
                    expected_event
                        .map(str::to_string)
                        .into_iter()
                        .collect::<Vec<_>>()
                );
                let committed = IdemState::Committed {
                    commitment_id: i as u64,
                };
                match (c.state, ok) {
                    (Reserved, true) => {
                        c.state = Confirmed;
                        c.spent = Some(c.amount);
                        m.idem.insert(c.key, committed);
                    }
                    (Reserved, false) => {
                        c.state = Failed;
                        m.idem.insert(c.key, IdemState::Failed);
                    }
                    // the proof contradicts a wrong release: record the spend, freeze if over cap
                    (Failed, true) => {
                        c.state = Confirmed;
                        c.spent = Some(c.amount);
                        let (t, key) = (c.task, c.key);
                        m.idem.insert(key, committed);
                        m.frozen[t] |= m.used(t) > m.caps[t];
                    }
                    // agreement, or an over-count the contract only flags
                    _ => {}
                }
                (actual, Out::Done)
            }
            Op::Reconcile {
                pick,
                honest,
                guess,
            } => {
                let candidates: Vec<usize> = (0..m.commits.len())
                    .filter(|&i| m.commits[i].callback != Callback::Delivered)
                    .collect();
                if candidates.is_empty() {
                    return Ok((Out::NoOp, Out::NoOp));
                }
                let i = candidates[pick.index(candidates.len())];
                let confirmed = if *honest {
                    m.commits[i].transfer_ok
                } else {
                    *guess
                };
                let actual = sut.call(before, owner.clone(), now, |k| {
                    k.reconcile(i as u64, confirmed)
                })?;
                let actual = to_out(actual, |_| Out::Done);
                let c = &mut m.commits[i];
                let predicted = if c.state != Reserved {
                    Out::Panic(MSG_NOT_RECONCILABLE)
                } else if now < c.created_at + SPEC_RECONCILE_MIN_AGE_NS {
                    Out::Panic(MSG_RECONCILE_TOO_EARLY)
                } else if confirmed {
                    c.state = Confirmed;
                    c.spent = Some(c.amount);
                    m.idem.insert(
                        c.key,
                        IdemState::Committed {
                            commitment_id: i as u64,
                        },
                    );
                    Out::Done
                } else {
                    c.state = Failed;
                    m.idem.insert(c.key, IdemState::Failed);
                    Out::Done
                };
                (actual, predicted)
            }
            Op::Revoke { task, who } => {
                let (t, a) = (*task, *who);
                let actual = sut.call(before, owner.clone(), now, |c| {
                    c.revoke_delegate(TASKS[t].into(), actor(a))
                })?;
                let actual = to_out(actual, |was| Out::Value(was as u64));
                let predicted = match m.registered[t][a] {
                    None => Out::Panic(MSG_NO_SUCH_DELEGATE),
                    Some(was) => {
                        m.registered[t][a] = Some(false);
                        Out::Value(was as u64)
                    }
                };
                (actual, predicted)
            }
            Op::AddDelegate { task, who } => {
                let (t, a) = (*task, *who);
                let actual = sut.call(before, owner.clone(), now, |c| {
                    c.add_delegate(TASKS[t].into(), actor(a), "m/0".into())
                })?;
                let actual = to_out(actual, |_| Out::Done);
                let predicted = if m.registered[t][a].is_some() {
                    Out::Panic(MSG_DELEGATE_EXISTS)
                } else if m.active_crew(t) >= 3 {
                    Out::Panic(MSG_CREW_CAP_REACHED)
                } else {
                    m.registered[t][a] = Some(true);
                    Out::Done
                };
                (actual, predicted)
            }
            Op::RemoveAllowlist | Op::ReAddAllowlist => {
                let add = matches!(op, Op::ReAddAllowlist);
                let rcp = vec![RECIPIENTS[1].to_string()];
                let actual = sut.call(before, owner.clone(), now, |c| {
                    if add {
                        c.set_recipient_allowlist("t1".into(), rcp)
                    } else {
                        c.remove_recipient_allowlist("t1".into(), rcp)
                    }
                })?;
                m.removable_allowed = add;
                (to_out(actual, |_| Out::Done), Out::Done)
            }
            Op::Tick { secs } => {
                m.now += secs * 1_000_000_000;
                (Out::NoOp, Out::NoOp)
            }
        })
    }

    /// The `propose_payment` decision, in `lib.rs` order: auth -> idempotency (a replay must be
    /// the SAME request) -> allowlist -> admission.
    fn predict_propose(
        m: &mut Model,
        t: usize,
        key: Key,
        a: u128,
        rcp: usize,
        memo: usize,
        transfer_ok: bool,
    ) -> Out {
        if m.registered[t][key.0] != Some(true) {
            return Out::Panic(MSG_DELEGATE_NOT_AUTHORIZED);
        }
        match m.idem.get(&key) {
            Some(IdemState::Pending) => return Out::Panic(MSG_IN_FLIGHT),
            Some(IdemState::Failed) => return Out::Panic(MSG_ALREADY_FAILED),
            Some(IdemState::Committed { commitment_id }) => {
                let c = &m.commits[*commitment_id as usize];
                // the SAME request: task and the full intent, memo compared canonically
                let same = c.task == t
                    && c.amount == a
                    && c.recipient == rcp
                    && canonical_memo(c.memo) == canonical_memo(memo);
                return if same {
                    Out::Value(*commitment_id)
                } else {
                    Out::Panic(MSG_REQUEST_ID_REUSED)
                };
            }
            None => {}
        }
        if m.frozen[t] {
            return Out::Panic(MSG_TASK_FROZEN);
        }
        if !m.allowlisted(t, rcp) {
            return Out::Panic(MSG_RECIPIENT_NOT_ALLOWED);
        }
        if a == 0 {
            return Out::Panic(MSG_ZERO_AMOUNT);
        }
        match m.used(t).checked_add(a) {
            None => return Out::Panic(MSG_OVERFLOW),
            Some(p) if p > m.caps[t] => return Out::Panic(MSG_EXCEEDS_BUDGET),
            Some(_) => {}
        }
        let cid = m.commits.len() as u64;
        m.commits.push(Commit {
            task: t,
            key,
            amount: a,
            recipient: rcp,
            memo,
            state: ReservationState::Reserved,
            spent: None,
            created_at: m.now,
            transfer_ok,
            callback: Callback::Undelivered,
        });
        m.idem.insert(key, IdemState::Pending);
        if transfer_ok {
            m.outflow[t] += a;
        }
        Out::Promise(cid)
    }

    // ---- checks --------------------------------------------------------------------------------

    fn check(op: &Op, before: &Snap, m: &Model, outs: (Out, Out)) -> Result<(), TestCaseError> {
        let (actual, predicted) = outs;
        prop_assert_eq!(&actual, &predicted, "contract disagrees with the model");
        // Storage persists across `testing_env!`, so any context can read it.
        let snap = snapshot(&env::state_read::<Purser>().unwrap());
        let (tasks, commits, idem, next) = &snap;

        // (1) contract state == model state, read through the contract's own views.
        for (t, b) in tasks.iter().enumerate() {
            let b = b.as_ref().unwrap();
            prop_assert_eq!(b.outstanding, yocto(m.outstanding(t)));
            prop_assert_eq!(b.completed, yocto(m.completed(t)));
            prop_assert_eq!(b.active_crew as usize, m.active_crew(t));
            prop_assert_eq!(b.frozen, m.frozen[t]);
            // (2) invariant (I) on every task a contradicted reconcile has not frozen, and the
            // money-flow bound: every executed transfer is accounted for as completed or still
            // held, except value a wrong release freed whose contradicting callback is pending.
            if !b.frozen {
                prop_assert!(b.completed.checked_add(b.outstanding).unwrap() <= b.cap);
            }
            prop_assert!(
                m.outflow[t] <= m.used(t) + m.unproven_release(t),
                "task {}: {} left the contract but only {} is accounted",
                t,
                m.outflow[t],
                m.used(t)
            );
        }
        prop_assert_eq!(commits.len(), m.commits.len());
        for (c, mc) in commits.iter().zip(&m.commits) {
            prop_assert_eq!(c.task.as_str(), TASKS[mc.task]);
            prop_assert_eq!(&c.delegate, &actor(mc.key.0));
            prop_assert_eq!(c.state, mc.state);
            prop_assert_eq!(c.reserved_amount, yocto(mc.amount));
            prop_assert_eq!(c.actual_spent, mc.spent.map(yocto));
            prop_assert_eq!(&c.intent, &intent(mc.amount, mc.recipient, mc.memo));
            // Per-commitment money flow (the per-task sum above can mask one error with another):
            // a transfer that executed is held or counted as spent, never released, except while
            // a wrong release is still waiting for the callback that will contradict it.
            if mc.transfer_ok && c.state == ReservationState::Failed {
                prop_assert_eq!(
                    mc.callback,
                    Callback::Undelivered,
                    "commitment {} executed its transfer but is released",
                    c.id
                );
            }
        }
        prop_assert!(next.is_none(), "a commitment exists past the ledger end");
        for (i, (a, r)) in (0..ACTORS)
            .flat_map(|a| (0..RIDS).map(move |r| (a, r)))
            .enumerate()
        {
            prop_assert_eq!(
                idem[i],
                m.idem.get(&(a, r)).copied(),
                "idempotency for ({}, {})",
                a,
                r
            );
        }

        // (3) no release on silence.
        if !op.carries_proof() {
            for (old, new) in before.0.iter().zip(tasks) {
                let (old, new) = (old.as_ref().unwrap(), new.as_ref().unwrap());
                prop_assert!(
                    new.outstanding >= old.outstanding,
                    "outstanding fell without proof"
                );
            }
            for (old, new) in before.1.iter().zip(commits) {
                prop_assert!(
                    !is_live(old.state) || old.state == new.state,
                    "a live commitment moved without proof"
                );
            }
        }
        Ok(())
    }

    pub fn run(caps: [u128; 2], ops: &[Op]) -> Result<(), TestCaseError> {
        prop_assert_eq!(
            RECONCILE_MIN_AGE_NS,
            SPEC_RECONCILE_MIN_AGE_NS,
            "time-lock drifted from the spec"
        );
        let sut = Sut::setup(caps);
        let mut model = Model::new(caps);
        for op in ops {
            let before = snapshot(&env::state_read::<Purser>().unwrap());
            let outs = step(&sut, &before, &mut model, op)?;
            check(op, &before, &model, outs)?;
        }
        Ok(())
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    /// Layer B: the same three properties over the real `Purser` entrypoints, with callbacks
    /// delivered out of order or lost, owner reconciles, revocation, re-adds, allowlist churn,
    /// two tasks sharing delegates, and the owner acting as a delegate.
    #[test]
    fn contract_invariants_hold_over_random_interleavings(
        caps in (cap_strategy(), cap_strategy()),
        ops in prop::collection::vec(contract_layer::op_strategy(), 1..48),
    ) {
        contract_layer::run([caps.0, caps.1], &ops)?;
    }
}
