use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{near, AccountId, BorshStorageKey, PanicOnDefault};

mod budget;
mod error;
mod idempotency;
mod reservation;
mod types;

pub use budget::{
    assert_invariant, authorize, cancel, mark_unknown, release_failed, settle_confirmed,
    try_reserve,
};
pub use error::PurserError;
pub use idempotency::{classify, IdemDecision};
pub use reservation::{transition, Event};
pub use types::{
    Chain, Commitment, CommitmentId, IdemState, PaymentIntent, RequestId, ReservationState,
    TaskBudget, TaskId, TokenSpec,
};

/// Unique storage prefixes for on-chain collections.
///
/// APPEND-ONLY: `BorshStorageKey` turns each variant's position into the on-chain
/// prefix byte. After the first stateful deploy, inserting, reordering, or removing
/// a variant reshuffles prefixes and orphans existing state — so only ever APPEND;
/// never insert or reorder. Declared up front in backend-schema order to lock it now.
///
/// Nested per-task collections (the `delegate_index` and `task_commitments` vectors)
/// each need their own runtime-derived sub-prefix, added when those collections land;
/// this top-level enum does not cover them.
///
/// `#[allow(dead_code)]` stays: Prompt 2 constructs only `Tasks`, `Commitments`, and
/// `Idempotency`. The reserved `Delegates`/`DelegateIndex`/`Allowlist` (Prompt 3) and
/// `TaskCommitments` (Prompt 4) variants are unused until their collections land, but
/// their prefixes are locked now (append-only).
#[allow(dead_code)]
#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Tasks,
    Delegates,
    DelegateIndex,
    Allowlist,
    Commitments,
    TaskCommitments,
    Idempotency,
}

/// Purser — an on-chain spending controller for crews of AI agents.
///
/// Holds the owner, the Chain Signatures MPC signer id, and the Prompt-2 slice of the
/// backend-schema §1.1 storage layout: the task-budget ledger, the commitment ledger,
/// the tri-state idempotency store, and the monotonic commitment counter. These are
/// declared and initialized here but **not mutated in Prompt 2** — the accounting core
/// ([`budget`], [`reservation`], [`idempotency`]) operates on plain values; the
/// entrypoints that read/write these collections land in Prompt 4.
///
/// ⚠️ Borsh layout: Prompt 3 (delegates/allowlist) and Prompt 4 (`task_commitments`)
/// APPEND their fields at the END of this struct (append-only — struct field order is
/// independent of the `StorageKey` prefix order). Do NOT `new()`/stateful-init on
/// testnet until the struct is final for the demo (Prompt 4), or you owe a hand-written
/// `#[init(ignore_state)]` migrate. (CI builds a deployable wasm; don't deploy+init it.)
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Purser {
    owner: AccountId,
    tasks: IterableMap<TaskId, TaskBudget>,
    commitments: IterableMap<CommitmentId, Commitment>,
    idempotency: LookupMap<RequestId, IdemState>,
    next_commitment_id: CommitmentId,
    signer_id: AccountId,
}

#[near]
impl Purser {
    /// Initialize the contract.
    ///
    /// `signer_id` is the Chain Signatures MPC signer (testnet:
    /// `v1.signer-prod.testnet`); it is unused until the external-chain path. Each
    /// collection is constructed with its unique `StorageKey` prefix.
    #[init]
    pub fn new(owner: AccountId, signer_id: AccountId) -> Self {
        Self {
            owner,
            tasks: IterableMap::new(StorageKey::Tasks),
            commitments: IterableMap::new(StorageKey::Commitments),
            idempotency: LookupMap::new(StorageKey::Idempotency),
            next_commitment_id: 0,
            signer_id,
        }
    }

    /// Crate version — a trivial view to confirm the contract is live.
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
