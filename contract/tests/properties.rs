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
    /// Time passes; nothing is delivered.
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
        3 => (any::<Index>(), 0u16..=1000)
            .prop_map(|(pick, spent_per_mille)| CoreOp::SettleOk { pick, spent_per_mille }),
        2 => any::<Index>().prop_map(|pick| CoreOp::FailPreSig { pick }),
        2 => any::<Index>().prop_map(|pick| CoreOp::Timeout { pick }),
        1 => any::<Index>().prop_map(|pick| CoreOp::CancelAttested { pick }),
        1 => (0..DELEGATES).prop_map(|d| CoreOp::Revoke { d }),
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

/// Spent amount for a settle: `per_mille` of the reservation, so `1000` settles in full.
/// `> 1000` is never generated; `spent > reserved` is exercised by the pure-core unit tests.
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
                let m = model.edge(i, &[Signed, Unknown], Confirmed);
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
    // Exactly-once: a key maps to at most one commitment, and a replay names that commitment.
    let mut seen = BTreeMap::new();
    for (i, mc) in model.commits.iter().enumerate() {
        prop_assert!(
            seen.insert(mc.key, i).is_none(),
            "two authorizations for one key"
        );
    }
    if let Outcome::Replay(cid) = s {
        prop_assert_eq!(
            model.commits[cid as usize].state,
            ReservationState::Confirmed
        );
    }

    // (2) Invariant (I).
    assert_invariant(&sut.budget);
    prop_assert!(model.used() <= model.cap);

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
