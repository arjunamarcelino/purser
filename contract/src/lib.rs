use near_sdk::{near, AccountId, BorshStorageKey, PanicOnDefault};

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
/// Holds the contract owner and the Chain Signatures MPC signer id. All budget
/// and reservation state is added in later steps; this is the scaffold shell.
///
/// ⚠️ Borsh layout is NOT append-only-safe yet (unlike `StorageKey`). The collection
/// fields from backend-schema §1.1 land *between* `owner` and `signer_id`, so the
/// layout WILL change when they are added. That is free only while no state exists —
/// do NOT `new()`/stateful-init this on testnet until the full struct lands, or you
/// create `migrate`/`ignore_state` debt. (CI builds a deployable wasm; don't deploy+init it.)
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Purser {
    owner: AccountId,
    signer_id: AccountId,
}

#[near]
impl Purser {
    /// Initialize the contract.
    ///
    /// `signer_id` is the Chain Signatures MPC signer (testnet:
    /// `v1.signer-prod.testnet`); it is unused until the external-chain path.
    #[init]
    pub fn new(owner: AccountId, signer_id: AccountId) -> Self {
        Self { owner, signer_id }
    }

    /// Crate version — a trivial view to confirm the contract is live.
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
