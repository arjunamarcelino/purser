//! Purser contract crate root — the `#[near]` entrypoint/state boundary.
//!
//! This is the ONLY layer that reads `env::*`, touches the `near_sdk::store` collections,
//! emits events, and panics-to-roll-back. It composes the pure, `env`-free cores —
//! [`budget`] (accounting, BACKEND-SCHEMA §1.3), [`reservation`] (state machine), and
//! [`idempotency`] (replay guard) — behind the owner-gated control plane (task + delegate
//! registry; APP-FLOW §3/§4/§9, BACKEND-SCHEMA §1.4/§1.5). The `propose_payment`
//! reserve-before-sign path lands in Prompt 4. See the per-module banners for details.

use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

mod budget;
mod delegates;
mod error;
mod events;
mod idempotency;
mod payload;
mod reservation;
mod types;

pub use budget::{
    assert_invariant, authorize, cancel, mark_unknown, release_failed, remaining, settle_confirmed,
    try_reserve,
};
pub use error::{
    PurserError, MSG_ALREADY_FAILED, MSG_CAP_POSITIVE, MSG_CREW_CAP_MIN, MSG_CREW_CAP_REACHED,
    MSG_DELEGATE_EXISTS, MSG_DELEGATE_NOT_AUTHORIZED, MSG_EXCEEDS_BUDGET, MSG_INVALID_PATH,
    MSG_INVALID_RECIPIENT, MSG_INVALID_REQUEST_ID, MSG_INVALID_TASK_ID, MSG_IN_FLIGHT,
    MSG_MEMO_TOO_LONG, MSG_NOT_RECONCILABLE, MSG_NO_SUCH_COMMITMENT, MSG_NO_SUCH_DELEGATE,
    MSG_NO_SUCH_TASK, MSG_ONLY_OWNER, MSG_RECIPIENT_NOT_ALLOWED, MSG_TASK_EXISTS,
    MSG_UNSUPPORTED_CHAIN, MSG_UNSUPPORTED_TOKEN, MSG_ZERO_AMOUNT,
};
pub use events::PurserEvent;
pub use idempotency::{classify, IdemDecision};
pub use payload::{
    build_near_payload, canonical_payload_bytes, NearPayload, PAYLOAD_CHAIN_TAG, PAYLOAD_DOMAIN,
    PAYLOAD_ENCODING, PAYLOAD_HASH_ALG, PAYLOAD_PREIMAGE_SPEC, PAYLOAD_VERSION,
};
pub use reservation::{transition, Event};
pub use types::{
    Chain, Commitment, CommitmentId, Delegate, IdemState, PaymentIntent, RequestId,
    ReservationState, TaskBudget, TaskId, TokenSpec,
};

/// Max byte length of an owner-chosen `task_id` (mirrors NEAR's account-id max); an
/// unbounded id is a storage-griefing and indexer hazard.
const MAX_TASK_ID_LEN: usize = 64;
/// Max byte length of a delegate's operator-supplied `derivation_path`.
const MAX_DERIVATION_PATH_LEN: usize = 128;
/// Max byte length of a client-supplied `request_id` (a UUID is 36). Bounds the idempotency
/// key, the stored `Commitment.request_id`, and the event payload — an unbounded id is a
/// storage-staking griefing amplifier (S8).
const MAX_REQUEST_ID_LEN: usize = 64;
/// Max byte length of an `intent.memo` (stored inside the `Commitment`). Same griefing rationale.
const MAX_MEMO_LEN: usize = 256;
/// Static gas for the `on_near_settled` callback: a few `store` writes + one event `log!`.
/// ~2x NEAR's canonical callback floor (`FIVE_TGAS`); the bare `Transfer` action costs ~0.5 Tgas
/// and does not compete. Re-measure if the wasm grows materially (Prompt 12's RLP/keccak).
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// Unique storage prefixes for on-chain collections.
///
/// APPEND-ONLY: `BorshStorageKey` maps each variant's position to its on-chain prefix byte, so
/// after the first stateful deploy you may only append — never insert, reorder, or remove (doing
/// so orphans existing state). Order is locked up front in backend-schema order.
///
/// `DelegateIndex` and `TaskCommitments` are reserved but unused: the delegate registry and the
/// commitment ledger are flat composite-key maps (D-6), filtered in-place rather than via a
/// per-task secondary index. `TaskCommitments` stays reserved as the scale fix if `list_commitments`
/// ever outgrows its view-scan ceiling.
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
/// Holds the owner, the Chain Signatures MPC signer id, the task-budget and commitment ledgers,
/// the tri-state idempotency store, the monotonic commitment counter, and the delegate registry +
/// recipient allowlist (backend-schema §1.1). The `#[near]` entrypoints are the only mutators; the
/// accounting cores ([`budget`], [`reservation`], [`idempotency`]) operate on plain borrowed values.
///
/// ⚠️ Borsh layout: APPEND-ONLY for any future field. Do NOT `new()`/stateful-init on testnet until
/// the demo deploy (nothing is stateful-deployed yet — which is why the `idempotency` key could be
/// widened to `(AccountId, RequestId)` for free); otherwise you owe an `#[init(ignore_state)]` migrate.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Purser {
    owner: AccountId,
    tasks: IterableMap<TaskId, TaskBudget>,
    commitments: IterableMap<CommitmentId, Commitment>,
    // Idempotency keyed by (predecessor, request_id): namespacing per caller stops a co-delegate
    // from squatting/hijacking another's request_id. `classify` is key-agnostic.
    idempotency: LookupMap<(AccountId, RequestId), IdemState>,
    next_commitment_id: CommitmentId,
    signer_id: AccountId,
    // Prompt 3 (appended — Borsh layout is append-only): the delegate (crew) registry
    // and the recipient allowlist. `delegates` is a single flat composite-key map (no
    // secondary index — D-6). `allowlist` is owner-managed via `set_recipient_allowlist`.
    delegates: IterableMap<(TaskId, AccountId), Delegate>,
    allowlist: LookupMap<(TaskId, AccountId), bool>,
}

/// The NEAR-native `payload_hash` scheme, surfaced by [`Purser::payload_scheme`] so a NON-Rust
/// verifier (TS indexer / dashboard / judge) can re-derive `Commitment.payload_hash` from on-chain
/// reads ALONE — the `preimage` field carries the full composition rule, so nothing is source-only.
/// JSON-only (view DTO) — never stored, no Borsh-freeze obligation.
#[near(serializers = [json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PayloadScheme {
    /// The chain this scheme applies to (`"near-native"`). A verifier branches on it; the EVM
    /// scheme (Prompt 12) is a sibling with its own digest/framing.
    pub chain: String,
    /// The authoritative schema version (the first borsh field of the preimage). A commitment
    /// carries the version it was hashed under in `Commitment.payload_version`.
    pub version: u16,
    /// Digest algorithm (`"sha256"`). Named `hash_algorithm` (not `hash`) so it is not confused
    /// with `payload_hash`, which is a digest VALUE.
    pub hash_algorithm: String,
    /// Body encoding following the domain prefix (`"borsh"`).
    pub encoding: String,
    /// Hex of the fixed 32-byte domain, prepended as a RAW PREFIX (not borsh-encoded).
    pub domain_hex: String,
    /// Machine-readable composition rule (ordered fields + types + domain framing). This is the
    /// authoritative re-derivation contract; `domain32` = the bytes of `domain_hex`.
    pub preimage: String,
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
            delegates: IterableMap::new(StorageKey::Delegates),
            allowlist: LookupMap::new(StorageKey::Allowlist),
        }
    }

    /// Crate version — a trivial view to confirm the contract is live.
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    /// The NEAR-native `payload_hash` scheme (chain, version, algorithm, encoding, domain, and the
    /// full `preimage` composition rule), so an off-chain verifier in ANY language can re-derive
    /// `Commitment.payload_hash` from on-chain reads alone — see [`PayloadScheme`]. Describes the
    /// CURRENT `PAYLOAD_VERSION`; a commitment hashed under an older version (after a future bump)
    /// is identified by its `Commitment.payload_version`.
    pub fn payload_scheme(&self) -> PayloadScheme {
        PayloadScheme {
            chain: PAYLOAD_CHAIN_TAG.to_string(),
            version: PAYLOAD_VERSION,
            hash_algorithm: PAYLOAD_HASH_ALG.to_string(),
            encoding: PAYLOAD_ENCODING.to_string(),
            domain_hex: PAYLOAD_DOMAIN.iter().map(|b| format!("{b:02x}")).collect(),
            preimage: PAYLOAD_PREIMAGE_SPEC.to_string(),
        }
    }

    // ---- owner-gated control plane (APP-FLOW §3, §4, §9) -----------------------

    /// Create a task budget (Flow A). Owner-gated; rejects a duplicate `task_id`,
    /// an empty/oversized id, a zero `cap`, or a zero `crew_cap`. Initializes
    /// `completed = outstanding = 0`, so invariant (I) holds trivially.
    pub fn create_task(&mut self, task_id: TaskId, cap: NearToken, token: TokenSpec, crew_cap: u8) {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner, MSG_ONLY_OWNER);
        require!(
            !task_id.is_empty() && task_id.len() <= MAX_TASK_ID_LEN,
            MSG_INVALID_TASK_ID
        );
        require!(!self.tasks.contains_key(&task_id), MSG_TASK_EXISTS);
        require!(!cap.is_zero(), MSG_CAP_POSITIVE);
        require!(crew_cap >= 1, MSG_CREW_CAP_MIN);

        let budget = TaskBudget {
            owner: caller.clone(),
            token: token.clone(),
            cap,
            completed: NearToken::ZERO,
            outstanding: NearToken::ZERO,
            crew_cap,
            created_at: env::block_timestamp(),
            active_crew: 0,
        };
        assert_invariant(&budget); // defense-in-depth; trivially holds at 0 + 0 <= cap
        self.tasks.insert(task_id.clone(), budget);
        PurserEvent::TaskCreated {
            task_id,
            owner: caller,
            cap,
            token,
            crew_cap,
        }
        .emit();
    }

    /// Register a delegate agent on a task (Flow B). Owner-gated. Rejects an unknown
    /// task, a duplicate delegate (active OR revoked — revoke is terminal for the MVP),
    /// or an add that would exceed `crew_cap` *active* members (O(1) via `active_crew`).
    ///
    /// SIGNATURE NOTE: returns `()` under the registry + predecessor auth model (the
    /// contract issues no access keys). It becomes `-> Promise` only if function-call-key
    /// provisioning is enabled later — a deferred, non-trivial change (see the operator
    /// gate in docs/BUILD-START-VERIFICATION.md).
    pub fn add_delegate(
        &mut self,
        task_id: TaskId,
        account_id: AccountId,
        derivation_path: String,
    ) {
        require!(env::predecessor_account_id() == self.owner, MSG_ONLY_OWNER);
        require!(
            derivation_path.len() <= MAX_DERIVATION_PATH_LEN,
            MSG_INVALID_PATH
        );

        let (crew_cap, active_crew) = {
            let task = self
                .tasks
                .get(&task_id)
                .unwrap_or_else(|| env::panic_str(MSG_NO_SUCH_TASK));
            (task.crew_cap, task.active_crew)
        };
        let key = (task_id.clone(), account_id.clone());
        require!(!self.delegates.contains_key(&key), MSG_DELEGATE_EXISTS);
        require!(
            (active_crew as usize) < (crew_cap as usize),
            MSG_CREW_CAP_REACHED
        );

        self.delegates.insert(
            key,
            Delegate {
                account_id: account_id.clone(),
                derivation_path,
                active: true,
                public_key: None, // registry + predecessor auth issues no key
                added_at: env::block_timestamp(),
            },
        );
        // active_crew < crew_cap <= 255, so +1 cannot overflow.
        self.tasks
            .get_mut(&task_id)
            .expect("task presence checked above")
            .active_crew += 1;
        PurserEvent::DelegateAdded {
            task_id,
            account_id,
        }
        .emit();
    }

    /// Revoke a delegate (Flow G). Owner-gated. Sets `active = false`, which blocks all
    /// FUTURE authorizations immediately (the next `propose_payment` is refused). Returns
    /// whether the call actually deactivated the delegate (`false` on an idempotent
    /// re-revoke). HONEST REVOCATION: this cannot un-issue a signature already produced,
    /// and it does NOT release that delegate's already-`outstanding` reservations — those
    /// stay reserved until settled/failed by the normal lifecycle (no reclaim on silence).
    ///
    /// SIGNATURE NOTE: `-> Promise` (with `delete_key`) only if a function-call key was
    /// ever issued — deferred (see add_delegate).
    pub fn revoke_delegate(&mut self, task_id: TaskId, account_id: AccountId) -> bool {
        require!(env::predecessor_account_id() == self.owner, MSG_ONLY_OWNER);
        require!(self.tasks.contains_key(&task_id), MSG_NO_SUCH_TASK);

        let key = (task_id.clone(), account_id.clone());
        let was_active = {
            let d = self
                .delegates
                .get_mut(&key)
                .unwrap_or_else(|| env::panic_str(MSG_NO_SUCH_DELEGATE));
            let prev = d.active;
            d.active = false; // unconditional: a no-op when already inactive
            prev
        };
        if was_active {
            // task existence checked above; decrement only on a real deactivation so a
            // re-revoke can never double-decrement the counter. Emit here too, so an
            // idempotent re-revoke produces no phantom DelegateRevoked event.
            self.tasks
                .get_mut(&task_id)
                .expect("task presence checked above")
                .active_crew -= 1;
            PurserEvent::DelegateRevoked {
                task_id,
                account_id,
            }
            .emit();
        }
        was_active
    }

    /// Add recipients to a task's payee allowlist (owner-gated). Additive: each recipient is
    /// parsed to an `AccountId` and marked allowed. `propose_payment` is deny-by-default, so a
    /// task with no allowlisted recipients cannot pay out — this is the fail-closed recipient
    /// confinement ("never blind-sign"). Emits one `RecipientAllowlistSet`. Revoke a payee with
    /// [`Self::remove_recipient_allowlist`].
    pub fn set_recipient_allowlist(&mut self, task_id: TaskId, recipients: Vec<String>) {
        require!(env::predecessor_account_id() == self.owner, MSG_ONLY_OWNER);
        require!(self.tasks.contains_key(&task_id), MSG_NO_SUCH_TASK);
        for r in &recipients {
            let acct = r
                .parse::<AccountId>()
                .unwrap_or_else(|_| env::panic_str(MSG_INVALID_RECIPIENT));
            self.allowlist.insert((task_id.clone(), acct), true);
        }
        PurserEvent::RecipientAllowlistSet {
            task_id,
            recipients,
        }
        .emit();
    }

    /// Remove recipients from a task's payee allowlist (owner-gated) — honest revocation of a payee
    /// (compromised / rotated / fat-fingered account). Each recipient is parsed to an `AccountId`
    /// and its allowlist entry deleted; idempotent (removing an absent recipient is a no-op). After
    /// removal the next `propose_payment` to that recipient is refused deny-by-default. Emits one
    /// `RecipientAllowlistRemoved`.
    ///
    /// HONEST REVOCATION (Rule 6): this blocks FUTURE payments to the recipient; like delegate
    /// revocation it cannot recall a transfer already executed, and it does not touch commitments
    /// already `Reserved`/`Signed` for that recipient — those settle via the normal lifecycle.
    pub fn remove_recipient_allowlist(&mut self, task_id: TaskId, recipients: Vec<String>) {
        require!(env::predecessor_account_id() == self.owner, MSG_ONLY_OWNER);
        require!(self.tasks.contains_key(&task_id), MSG_NO_SUCH_TASK);
        for r in &recipients {
            let acct = r
                .parse::<AccountId>()
                .unwrap_or_else(|_| env::panic_str(MSG_INVALID_RECIPIENT));
            self.allowlist.remove(&(task_id.clone(), acct)); // idempotent: None if absent
        }
        PurserEvent::RecipientAllowlistRemoved {
            task_id,
            recipients,
        }
        .emit();
    }

    // ---- delegate-gated payment flow (Prompt 4; TECHNICAL §5–§6, TRD §4–§5) ------

    /// Propose a NEAR-native payment: the load-bearing reserve-before-sign flow.
    ///
    /// The whole concurrency guarantee lives in the SYNCHRONOUS PREFIX below — auth, tri-state
    /// idempotency, validation, and the atomic admit+reserve+idempotency write all complete
    /// before any `Promise` is created. NEAR commits state at the first Promise boundary, so two
    /// concurrent calls serialize: the second sees committed `outstanding` (→ "exceeds task
    /// budget") or `Pending` (→ "in-flight"), and can never both pass admission.
    ///
    /// Returns `PromiseOrValue<CommitmentId>`: a fresh call resolves to the `cid` via the
    /// settlement callback; a `Committed` replay returns the prior `cid` immediately (exactly-once,
    /// no second transfer). A failed transfer still returns the `cid` — the caller learns the
    /// outcome from `get_commitment(cid).state` / the `payment_failed` event, not an error.
    ///
    /// `#[payable]` is retained for forward-compat with the deferred NEP-145 storage-deposit guard
    /// (P-11); no deposit is required in the MVP.
    #[payable]
    pub fn propose_payment(
        &mut self,
        task: TaskId,
        intent: PaymentIntent,
        request_id: RequestId,
    ) -> PromiseOrValue<CommitmentId> {
        let caller = env::predecessor_account_id();

        // bound task + request_id (boundary guards; mirror create_task's task_id check) — input
        // hygiene before the value is used as a map key / idempotency key (S8 amplifier).
        require!(
            !task.is_empty() && task.len() <= MAX_TASK_ID_LEN,
            MSG_INVALID_TASK_ID
        );
        require!(
            !request_id.is_empty() && request_id.len() <= MAX_REQUEST_ID_LEN,
            MSG_INVALID_REQUEST_ID
        );

        // (a) AUTH — predecessor must be an active delegate of the task.
        self.assert_delegate_authorized(&task, &caller);

        // (b) IDEMPOTENCY (tri-state, synchronous), namespaced by (predecessor, request_id).
        let idem_key = (caller.clone(), request_id.clone());
        match classify(self.idempotency.get(&idem_key)) {
            IdemDecision::Replay { commitment_id } => return PromiseOrValue::Value(commitment_id),
            IdemDecision::InFlight => env::panic_str(MSG_IN_FLIGHT),
            IdemDecision::AlreadyFailed => env::panic_str(MSG_ALREADY_FAILED),
            IdemDecision::Fresh => {}
        }

        // (c) VALIDATE + CONSTRUCT PAYLOAD + DENY-BY-DEFAULT ALLOWLIST. The constructed-payload
        // audit hash is built from these same validated fields inside `open_reservation` (it needs
        // the about-to-be-assigned `commitment_id`), so "hashed == executed".
        let task_token = self
            .tasks
            .get(&task)
            .unwrap_or_else(|| env::panic_str(MSG_NO_SUCH_TASK))
            .token
            .clone();
        let payload = build_near_payload(&task_token, &intent, MAX_MEMO_LEN)
            .unwrap_or_else(|e| env::panic_str(&e.to_string())); // recipient parsed here, reused in (d)+(e)
        self.assert_allowlisted(&task, &payload.recipient); // fail-closed: deny-by-default

        // (d) ATOMIC ADMIT + RESERVE + PAYLOAD-HASH + IDEMPOTENCY WRITE — synchronous, before any Promise.
        let now = env::block_timestamp();
        let (cid, payload_hash, payload_version) = self.open_reservation(
            &task,
            caller.clone(),
            &intent,
            &request_id,
            &payload.recipient,
            now,
        );
        self.idempotency.insert(idem_key, IdemState::Pending);
        // NEP-297: emitted AFTER the reserve+idempotency writes; the following Promise does NO
        // synchronous state write, so this is the only correct place — do NOT move it below.
        PurserEvent::PaymentReserved {
            task_id: task,
            commitment_id: cid,
            delegate: caller,
            // emit the PARSED/validated recipient (what the transfer targets), not the raw input.
            recipient: payload.recipient.to_string(),
            amount: intent.amount,
            request_id: request_id.clone(),
            // the contract-constructed audit anchor + the scheme version it was computed under, so
            // an event-only indexer hydrates both without a `get_commitment` follow-up (same
            // `[u8;32]` shape the view returns; re-derive via `payload_scheme()`).
            payload_hash,
            payload_version,
        }
        .emit();

        // ---- NO ASYNC ABOVE THIS LINE ----
        // Reserve-before-sign is NEAR's withdrawal/reentrancy defense: any public method (incl.
        // another propose_payment) can run between the transfer Promise and on_near_settled, but
        // the reserve + Pending are already committed, so a racing call is refused.

        // (e) NEAR-native transfer + settlement callback.
        PromiseOrValue::Promise(
            Promise::new(payload.recipient)
                .transfer(intent.amount)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_near_settled(cid, request_id),
                ),
        )
    }

    /// Settlement callback. `PromiseResult` is binary for a native transfer (`Successful`/`Failed`,
    /// no `NotReady` in 5.30), so there is no `Unknown` arm here — that is an EVM/relayer concept
    /// (Prompt 12). Uses `#[callback_result]` (the deprecated `env::promise_result` would fail
    /// the repo's `-D warnings` lint).
    ///
    /// Returns the `CommitmentId` on both branches so the fresh-path `PromiseOrValue` arm resolves
    /// to the same type as the `Committed` replay. The expected-failure path does NOT panic (it
    /// settles gracefully); a panic here can only come from a core `Err` (a broken invariant),
    /// which correctly rolls the callback back, leaving `Reserved`+`Pending` (no release on silence).
    ///
    /// RESIDUAL (documented): if this callback is gas-starved or panics AFTER a successful transfer,
    /// funds are gone but the commitment is stuck `Reserved` and the budget is locked until a future
    /// owner reconcile entrypoint. Mitigated by bounded inputs (deterministic cost) + `CALLBACK_GAS`.
    #[private]
    pub fn on_near_settled(
        &mut self,
        cid: CommitmentId,
        request_id: RequestId,
        #[callback_result] res: Result<(), PromiseError>,
    ) -> CommitmentId {
        let now = env::block_timestamp();
        // Read task id + delegate (immutable borrows dropped), then two disjoint &mut borrows of
        // DIFFERENT maps (self.tasks, self.commitments). DO NOT hoist this body into a
        // `&mut self` helper — that would collapse the two field borrows into one whole-self borrow.
        let commitment = self
            .commitments
            .get(&cid)
            .expect("callback cid always exists");
        let task_id = commitment.task.clone();
        let caller = commitment.delegate.clone();
        let b = self
            .tasks
            .get_mut(&task_id)
            .expect("task of a live commitment exists");
        let c = self
            .commitments
            .get_mut(&cid)
            .expect("callback cid always exists");
        match res {
            Ok(()) => {
                // native transfer succeeded → Reserved → Signed → Confirmed (actual == reserved).
                let reserved = c.reserved_amount;
                authorize(c, now).unwrap_or_else(|e| env::panic_str(&e.to_string()));
                settle_confirmed(b, c, reserved, now)
                    .unwrap_or_else(|e| env::panic_str(&e.to_string()));
                self.idempotency.insert(
                    (caller, request_id.clone()),
                    IdemState::Committed { commitment_id: cid },
                );
                PurserEvent::PaymentConfirmed {
                    task_id,
                    commitment_id: cid,
                    request_id,
                    actual_spent: reserved,
                }
                .emit();
            }
            Err(_) => {
                // transfer failed → value refunded to the contract → safe to release.
                release_failed(b, c, now).unwrap_or_else(|e| env::panic_str(&e.to_string()));
                self.idempotency
                    .insert((caller, request_id.clone()), IdemState::Failed);
                PurserEvent::PaymentFailed {
                    task_id,
                    commitment_id: cid,
                    request_id,
                    reason: "transfer failed".to_string(),
                }
                .emit();
            }
        }
        assert_invariant(b); // defense-in-depth backstop after the settle/release mutation
        cid
    }

    /// Owner-only recovery for a commitment stuck in `Reserved` because its settlement callback
    /// never completed (gas-starved / died *after* a successful transfer — the documented
    /// `on_near_settled` residual). Without this, the budget stays locked and the `request_id`
    /// wedged at `Pending` forever.
    ///
    /// HONEST RECONCILIATION (Rule 4 — reclaim only on proof, never on silence): the owner attests
    /// the ACTUAL on-chain transfer outcome, verified off-chain (explorer / receipt), and passes it
    /// as `confirmed` — that attestation IS the proof, not silence. `confirmed = true` → the
    /// transfer landed → force `Reserved → Signed → Confirmed` and settle. `confirmed = false` →
    /// the owner proved it did not land (funds refunded) → safe-release `Reserved → Failed`.
    ///
    /// Only a `Reserved` commitment is reconcilable: in the happy path a commitment settles within
    /// the same transaction as its callback, so a `Reserved` that persists into a later owner
    /// transaction is, by construction, a lost-callback case. Any other state rejects.
    pub fn reconcile(&mut self, commitment_id: CommitmentId, confirmed: bool) {
        require!(env::predecessor_account_id() == self.owner, MSG_ONLY_OWNER);
        let now = env::block_timestamp();
        let (task_id, delegate, request_id, reserved, state) = {
            let c = self
                .commitments
                .get(&commitment_id)
                .unwrap_or_else(|| env::panic_str(MSG_NO_SUCH_COMMITMENT));
            (
                c.task.clone(),
                c.delegate.clone(),
                c.request_id.clone(),
                c.reserved_amount,
                c.state,
            )
        };
        require!(state == ReservationState::Reserved, MSG_NOT_RECONCILABLE);

        let b = self
            .tasks
            .get_mut(&task_id)
            .expect("task of a live commitment exists");
        let c = self
            .commitments
            .get_mut(&commitment_id)
            .expect("commitment presence checked above");
        if confirmed {
            authorize(c, now).unwrap_or_else(|e| env::panic_str(&e.to_string()));
            settle_confirmed(b, c, reserved, now)
                .unwrap_or_else(|e| env::panic_str(&e.to_string()));
            self.idempotency.insert(
                (delegate, request_id.clone()),
                IdemState::Committed { commitment_id },
            );
        } else {
            release_failed(b, c, now).unwrap_or_else(|e| env::panic_str(&e.to_string()));
            self.idempotency
                .insert((delegate, request_id.clone()), IdemState::Failed);
        }
        assert_invariant(b);
        PurserEvent::PaymentReconciled {
            task_id,
            commitment_id,
            request_id,
            confirmed,
        }
        .emit();
    }

    /// The delegate-authorization gate `propose_payment` calls: the predecessor (`caller`) must be
    /// an ACTIVE delegate of the task. Shares the single `delegates::is_authorized` predicate with
    /// the public `is_delegate_authorized` view.
    pub(crate) fn assert_delegate_authorized(&self, task_id: &TaskId, caller: &AccountId) {
        require!(
            delegates::is_authorized(&self.delegates, task_id, caller),
            MSG_DELEGATE_NOT_AUTHORIZED
        );
    }

    /// Deny-by-default recipient check (fail-closed). Reads the owner-managed allowlist, keyed by
    /// the PARSED recipient (so the checked value is exactly the account the transfer targets).
    fn assert_allowlisted(&self, task: &TaskId, recipient: &AccountId) {
        require!(
            self.allowlist
                .get(&(task.clone(), recipient.clone()))
                .copied()
                .unwrap_or(false),
            MSG_RECIPIENT_NOT_ALLOWED
        );
    }

    /// Allocate the next `CommitmentId`, run the invariant admission check + reserve via the pure
    /// core, record the contract-constructed `payload_hash` onto the `Commitment`, and persist it.
    /// Panics (rolls back) on refusal: `ExceedsBudget` → "exceeds task budget"; `ZeroAmount` →
    /// "amount must be positive". On refusal nothing is persisted and the `cid` is not consumed.
    ///
    /// The hash is built AFTER `try_reserve` admits (so a zero/over-budget refusal never does hash
    /// work) and from the just-assigned `cid` plus the parsed `recipient` (the exact account the
    /// caller's `Promise` targets) and `intent.amount` (the exact transfer value) — "never
    /// blind-sign": a digest of the action the contract constructed, never a client-supplied hash.
    ///
    /// Returns `(cid, payload_hash, payload_version)` so the caller can resolve the commitment and
    /// emit the hash + its scheme version on the `PaymentReserved` event (event-only indexers
    /// hydrate both without a view call).
    fn open_reservation(
        &mut self,
        task: &TaskId,
        delegate: AccountId,
        intent: &PaymentIntent,
        request_id: &RequestId,
        recipient: &AccountId,
        now: u64,
    ) -> (CommitmentId, [u8; 32], u16) {
        let cid = self.next_commitment_id;
        let b = self
            .tasks
            .get_mut(task)
            .unwrap_or_else(|| env::panic_str(MSG_NO_SUCH_TASK)); // defense-in-depth (checked in (c))
        let mut commitment = try_reserve(
            b,
            cid,
            task.clone(),
            delegate,
            intent.clone(),
            request_id.clone(),
            now,
        )
        .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        assert_invariant(b); // defense-in-depth backstop (try_reserve already guarantees it)

        // Chain-scoped hashing: the NEAR-native scheme (sha256 over the domain-separated borsh
        // preimage, built in the pure `payload` core) is applied ONLY to `NearNative`. The `env`
        // call lives here, at the single boundary. Matching `intent.chain` keeps the scheme-selection
        // local to the hash site — so the EVM path (Prompt 12, un-prefixed keccak256(RLP)) MUST add
        // its own arm here rather than silently inheriting the NEAR scheme via the distant
        // `build_near_payload` chain-reject. The `Evm` arm is unreachable today (that reject fires
        // before reserve); it is defensive so a future relaxation cannot mislabel a digest.
        let (payload_hash, payload_version) = match intent.chain {
            Chain::NearNative => {
                let bytes =
                    canonical_payload_bytes(task, cid, recipient, intent.amount.as_yoctonear());
                (env::sha256_array(&bytes), PAYLOAD_VERSION)
            }
            Chain::Evm { .. } => env::panic_str(MSG_UNSUPPORTED_CHAIN),
        };
        // Record the digest AND the scheme version it was computed under, so the anchor stays
        // re-derivable across a future PAYLOAD_VERSION bump (`Some` together, by construction).
        commitment.payload_hash = Some(payload_hash);
        commitment.payload_version = Some(payload_version);
        self.commitments.insert(cid, commitment); // `b` borrow ended (NLL) — disjoint field
        self.next_commitment_id += 1; // monotonic; first cid = 0
        (cid, payload_hash, payload_version)
    }

    // ---- views (read-only; power the dashboard + off-chain cache) --------------

    /// The task budget, or `None` if unknown. `TaskBudget` serializes to JSON, so the
    /// dashboard reads `cap`/`completed`/`outstanding`/`active_crew` directly; the derived
    /// "remaining" number has its own view ([`Self::remaining_budget`]).
    pub fn get_task(&self, task_id: TaskId) -> Option<TaskBudget> {
        self.tasks.get(&task_id).cloned()
    }

    /// Unspent headroom `cap - (completed + outstanding)`, floored at ZERO; `ZERO` for an
    /// unknown task. Single source of the "remaining" math ([`budget::remaining`]).
    pub fn remaining_budget(&self, task_id: TaskId) -> NearToken {
        self.tasks
            .get(&task_id)
            .map(remaining)
            .unwrap_or(NearToken::ZERO)
    }

    /// A page of a task's delegates (active and revoked), for the dashboard crew view —
    /// skip `from_index` matches, return up to `limit`. Paginated so the returned set and
    /// the per-call work stay bounded as the registry grows (revoked rows are never pruned;
    /// re-adding a revoked account is refused, so churn accumulates entries). `[]` for an
    /// unknown task or an out-of-range page.
    ///
    /// NOTE: `derivation_path` is surfaced here. It is opaque/unused in the MVP
    /// (`public_key` is always `None`); when Chain Signatures lands (Prompt 5) a derivation
    /// path maps to a derived address — redact it from this public view then.
    pub fn list_delegates(&self, task_id: TaskId, from_index: u32, limit: u32) -> Vec<Delegate> {
        self.delegates
            .iter()
            .filter(|(key, _)| key.0 == task_id)
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|(_, d)| d.clone())
            .collect()
    }

    /// Public mirror of the authorization predicate: is `account_id` an active delegate of
    /// `task_id`? Lets agents/tests verify auth before `propose_payment` lands.
    pub fn is_delegate_authorized(&self, task_id: TaskId, account_id: AccountId) -> bool {
        delegates::is_authorized(&self.delegates, &task_id, &account_id)
    }

    /// A page of task ids — skip `from_index`, return up to `limit`. The off-chain indexer
    /// and dashboard enumerate tasks from here; an agent discovers its scope via
    /// `list_task_ids` + [`Self::is_delegate_authorized`]. Paginated so the result stays
    /// bounded as the task set grows.
    pub fn list_task_ids(&self, from_index: u32, limit: u32) -> Vec<TaskId> {
        self.tasks
            .keys()
            .skip(from_index as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    /// One commitment by id (clone), or `None`. Powers the dashboard payment detail and the
    /// indexer's point lookups. NOTE: `near_tx` is ALWAYS `None` on-chain — the contract cannot
    /// read its own receipt id in near-sdk 5.30; the off-chain indexer backfills it. Treat this
    /// view as authoritative for state/accounting, NOT for the tx hash.
    pub fn get_commitment(&self, commitment_id: CommitmentId) -> Option<Commitment> {
        self.commitments.get(&commitment_id).cloned()
    }

    /// Request status for a given `(account_id, request_id)` — O(1), reuses the idempotency map.
    /// Lets an autonomous proposer (and the dashboard's duplicate/in-flight view) distinguish
    /// `Pending` / `Committed` / `Failed` WITHOUT firing a second `propose_payment` that panics.
    pub fn get_idempotency(
        &self,
        account_id: AccountId,
        request_id: RequestId,
    ) -> Option<IdemState> {
        self.idempotency.get(&(account_id, request_id)).cloned()
    }

    /// A page of a task's commitments. ⚠️ O(TOTAL ledger): this deserializes every commitment to
    /// filter by `task` — unlike `list_delegates`, commitments are the highest-cardinality,
    /// monotonically-growing collection, so this view has a practical scan ceiling (~a few thousand
    /// rows before the view-call gas limit). The off-chain indexer (events → its own DB) is the
    /// real scale path; the reserved `StorageKey::TaskCommitments` per-task index is the on-chain
    /// fix if/when needed. Per-delegate / per-state filtering is intentionally client-side.
    pub fn list_commitments(
        &self,
        task_id: TaskId,
        from_index: u32,
        limit: u32,
    ) -> Vec<Commitment> {
        self.commitments
            .values()
            .filter(|c| c.task == task_id)
            .skip(from_index as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }
}
