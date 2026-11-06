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
/// Client-supplied idempotency key (a UUID). Keys the tri-state replay guard, scoped per
/// `(predecessor, RequestId)`: a client must use a **globally-unique** id per delegate account,
/// not per-task — reusing one across tasks collides within that delegate's namespace (the second
/// call replays/blocks, fail-safe: no double-spend).
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
    /// `AccountId` (NEAR) or `0x`-address (EVM). Validated/parsed by `payload::build_near_payload` (NEAR)
    /// or `evm_tx::parse_address` (EVM).
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
    /// Set when a settlement callback contradicts an owner `reconcile(false)` and the spend it
    /// proves pushes `completed + outstanding` over `cap`. A frozen task refuses every new
    /// proposal; it is the only state in which invariant (I) may not hold, and it can only be
    /// reached through a wrong owner attestation. APPENDED last to keep the Borsh layout
    /// append-only.
    pub frozen: bool,
}

/// Per-task state-growth limits (S8). Stored OUTSIDE `TaskBudget` and `Purser` (a separate map under
/// an appended storage prefix) so adding it changes no existing Borsh layout: the deployed contract
/// upgrades in place with no migration. A task with no stored entry uses the defaults.
///
/// `created_count` counts every commitment ever opened for the task and never decrements, not even
/// when a commitment later fails and releases its budget: commitments and their idempotency
/// entries are never pruned, so only a count of what was created bounds storage growth.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TaskLimits {
    /// Smallest NEAR-native payment the task admits (`0` = no minimum). Not applied to EVM tasks,
    /// whose amounts are in wei and which have their own owner-set `min_value`.
    pub min_payment: NearToken,
    /// Most commitments the task may ever create.
    pub max_commitments: u32,
    /// Commitments created so far.
    pub created_count: u32,
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
    /// The hash the CONTRACT constructed over the action it authorized; never client-supplied.
    /// `intent.chain` selects HOW it re-derives: `NearNative` = the scheme the `payload_scheme()`
    /// view describes (layout owned by [`payload::canonical_payload_bytes`]) — an integrity/audit
    /// anchor, not a signature; `Evm` (Prompt 12) = un-prefixed `keccak256(RLP(tx))`, the actual
    /// signing digest. A verifier / the indexer MUST branch on `intent.chain` — never assume one
    /// scheme. The version it was hashed under is in `payload_version`.
    pub payload_hash: Option<[u8; 32]>,
    pub near_tx: Option<String>,
    pub evm_tx: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    /// The `payload::PAYLOAD_VERSION` under which `payload_hash` was computed. `Some` exactly when
    /// `payload_hash` is `Some` (set together at reserve). A verifier reads this to pick which
    /// `payload_scheme()` version to re-derive with, so historical anchors stay re-derivable across
    /// a future version bump. APPENDED last (Borsh layout is append-only).
    pub payload_version: Option<u16>,
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

// ---- EVM payment path (Prompt 12) ---------------------------------------------------------------
//
// Everything below is APPENDED (Borsh layout is append-only; the types above are untouched). These are
// STORED types: Borsh only, no JSON. Byte strings and u64/u128 amounts are exposed to clients through the
// JSON view DTOs in `evm_api` (decimal strings for every u64/u128), never through these structs.

/// A secp256k1 signature as an EVM transaction carries it: `r`, `s` and `yParity` (0/1; no 27/28 and no
/// EIP-155 offset for a typed transaction).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EvmSig {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub y_parity: u8,
}

/// Owner-set EVM configuration (one `Option` on [`crate::Purser`]). The fee fields of an
/// already-built transaction are copied into [`EvmMeta`], so a config change never alters a built tx.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EvmCfg {
    /// The only chain the contract will build for. Must be in `evm_tx::TESTNET_CHAIN_IDS`.
    pub chain_id: u64,
    /// `maxFeePerGas` of every ORIGINAL transaction (fee = ceiling: simplest and un-stuckable), and the
    /// upper bound of any cancel.
    pub max_fee_ceiling: u128,
    /// `maxPriorityFeePerGas` of every original, and the upper bound of any cancel.
    pub max_priority_ceiling: u128,
    /// Smallest `value` (wei) an original may carry; also the fee-drain grief floor.
    pub min_value: u128,
    /// How old a `Signed` commitment must be (ns) before `mark_unknown` accepts it. Floored at 5 minutes.
    pub min_unknown_age_ns: u64,
}

/// The single nonce-burn cancel of one commitment: same nonce, a 0-value self-send, higher fees.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CancelMeta {
    pub max_fee: u128,
    pub tip: u128,
    /// The digest the cancel was signed over (stored at request time, so a late signature can be
    /// verified without rebuilding anything).
    pub sighash: [u8; 32],
    pub sig: Option<EvmSig>,
    pub tx_hash: Option<[u8; 32]>,
}

/// Why the owner may `confirm_release` an `Unknown` commitment. Evidence is RECORDED by the relayer's
/// attestation; only the owner acts on it.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReleaseEvidence {
    /// The cancel landed at the same nonce, so the original can never land.
    CancelLanded,
    /// The original landed but reverted: the nonce burned and no value moved.
    OriginalReverted,
}

/// Everything EVM about one commitment (`Commitment` itself is not touched). Keyed by `CommitmentId`.
#[near(serializers = [borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EvmMeta {
    pub path: String,
    pub nonce: u64,
    pub sighash: [u8; 32],
    pub from: [u8; 20],
    pub to: [u8; 20],
    pub value: u128,
    pub chain_id: u64,
    pub max_fee: u128,
    pub tip: u128,
    pub sig: Option<EvmSig>,
    pub tx_hash: Option<[u8; 32]>,
    pub signed_at_ns: Option<u64>,
    pub cancel: Option<CancelMeta>,
    pub evidence: Option<ReleaseEvidence>,
}

/// One serialized signing lane: a derived address, with at most one in-flight commitment.
#[near(serializers = [borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Lane {
    pub path: String,
    pub chain_id: u64,
    /// Uncompressed secp256k1 key (x || y), cached write-once from the signer's `derived_public_key`.
    pub pubkey: [u8; 64],
    pub address: [u8; 20],
    /// `None` until the owner seeds it from `eth_getTransactionCount(address, finalized)`.
    pub next_nonce: Option<u64>,
    pub in_flight: Option<CommitmentId>,
}
