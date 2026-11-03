//! Core on-chain types for Purser (BACKEND-SCHEMA §1.2).
//!
//! These are the authoritative data types the accounting core and the contract
//! layer operate on. They carry `#[near(serializers=[json, borsh])]` because they
//! are stored (borsh) and surfaced to the dashboard/off-chain cache (json). They
//! are NOT contract state themselves — only [`crate::Purser`] is `#[near(contract_state)]`.
//!
//! ⚠️ BORSH LAYOUT IS FROZEN HERE. Borsh encodes struct fields in declaration order
//! and enum variants by their declaration index — both with no names/tags. Inserting
//! or reordering a field or variant changes the wire format and orphans any stored
//! state. After the first stateful testnet deploy these may only be APPENDED to (and
//! even then old state needs a hand-written `#[init(ignore_state)]` migrate). Freeze
//! the order now.

use near_sdk::{near, AccountId, NearToken, PublicKey};

/// Human-chosen, unique task identifier.
pub type TaskId = String;
/// Client-supplied idempotency key (a UUID). Keys the tri-state replay guard.
pub type RequestId = String;
/// Contract-assigned, monotonic commitment id (the counter lives on [`crate::Purser`]).
pub type CommitmentId = u64;

/// Which asset a task budget is denominated in (one token per task in the MVP).
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TokenSpec {
    /// Native NEAR (the MVP demo path).
    NearNative,
    /// A NEP-141 fungible token held at `contract`.
    Nep141 { contract: AccountId },
}

/// Which chain a payment settles on. `Evm` is the stretch external path.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Chain {
    NearNative,
    Evm { chain_id: u64 },
}

/// A structured payment proposal. The contract constructs/validates the signing
/// payload from this — it never blind-signs a client-supplied hash (Rule 5).
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PaymentIntent {
    pub chain: Chain,
    /// `AccountId` (NEAR) or `0x`-address (EVM). Validated in Prompt 5.
    pub recipient: String,
    pub amount: NearToken,
    pub token: TokenSpec,
    pub memo: Option<String>,
}

/// One shared, capped task budget.
///
/// INVARIANT (enforced by [`crate::budget`]): `completed + outstanding <= cap` at
/// every observable state.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TaskBudget {
    pub owner: AccountId,
    pub token: TokenSpec,
    pub cap: NearToken,
    /// Σ `actual_spent` over `Confirmed` commitments.
    pub completed: NearToken,
    /// Σ `reserved_amount` over `Reserved | Signed | Unknown` commitments.
    pub outstanding: NearToken,
    pub crew_cap: u8,
    /// Block timestamp (ns) at creation. Supplied by the caller; the pure core
    /// never reads `env`.
    pub created_at: u64,
    /// Count of currently-active delegates on this task. Maintained incrementally
    /// (`+1` on `add_delegate`, `-1` on a revoke that actually deactivates) so the
    /// crew-cap admission check is O(1) — never an O(n) scan over the registry.
    /// APPENDED last (Prompt 3) to keep the Borsh layout append-only.
    pub active_crew: u8,
}

/// Reservation lifecycle state (TECHNICAL §4). Variant order is the borsh wire
/// format — append-only.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReservationState {
    Reserved,
    Signed,
    Confirmed,
    Unknown,
    Failed,
    Cancelled,
}

/// A single reservation in the ledger.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Commitment {
    pub id: CommitmentId,
    pub task: TaskId,
    pub delegate: AccountId,
    pub intent: PaymentIntent,
    pub reserved_amount: NearToken,
    /// `Some(spent)` once `Confirmed`, with `spent <= reserved_amount`.
    pub actual_spent: Option<NearToken>,
    pub state: ReservationState,
    pub request_id: RequestId,
    /// The hash the CONTRACT constructed (populated in Prompt 5); never client-supplied.
    pub payload_hash: Option<[u8; 32]>,
    pub near_tx: Option<String>,
    pub evm_tx: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// A registered crew member (delegate agent) of a task (BACKEND-SCHEMA §1.2).
///
/// Authorization is by `account_id` under the registry + predecessor model — the
/// contract issues no access keys (see `delegates.rs`), so `public_key` is always
/// `None` in the MVP; both `public_key` and `derivation_path` are carried now as
/// cheap pre-freeze insurance for the Chain-Signatures stretch (adding a stored
/// field after the first stateful deploy would cost a migration). `active` is set
/// to `false` on revoke — honest revocation blocks *new* authorizations only.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Delegate {
    pub account_id: AccountId,
    /// Chain-Signatures derivation path (opaque in the MVP; length-bounded on input).
    pub derivation_path: String,
    /// `false` after `revoke_delegate`.
    pub active: bool,
    /// An issued function-call key, if ever provisioned. Always `None` under
    /// registry + predecessor auth.
    pub public_key: Option<PublicKey>,
    /// Block timestamp (ns) at registration; injected by the contract layer.
    pub added_at: u64,
}

/// Tri-state idempotency entry, keyed by `(AccountId, RequestId)` — the proposing
/// delegate plus the client request id (TECHNICAL §6).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IdemState {
    /// A reservation is open and in-flight (still signing).
    Pending,
    /// Settled; `commitment_id` is returned on replay (exactly-once).
    Committed { commitment_id: CommitmentId },
    /// Failed safely before any signature existed.
    Failed,
}
