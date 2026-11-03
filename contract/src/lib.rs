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
    MSG_DELEGATE_EXISTS, MSG_DELEGATE_NOT_AUTHORIZED, MSG_EXCEEDS_BUDGET, MSG_INVALID_MEMO,
    MSG_INVALID_PATH, MSG_INVALID_RECIPIENT, MSG_INVALID_REQUEST_ID, MSG_INVALID_TASK_ID,
    MSG_IN_FLIGHT, MSG_NO_SUCH_DELEGATE, MSG_NO_SUCH_TASK, MSG_ONLY_OWNER,
    MSG_RECIPIENT_NOT_ALLOWED, MSG_TASK_EXISTS, MSG_UNSUPPORTED_CHAIN, MSG_UNSUPPORTED_TOKEN,
    MSG_ZERO_AMOUNT,
};
pub use events::PurserEvent;
pub use idempotency::{classify, IdemDecision};
pub use payload::{build_near_payload, NearPayload};
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
/// APPEND-ONLY: `BorshStorageKey` turns each variant's position into the on-chain
/// prefix byte. After the first stateful deploy, inserting, reordering, or removing
/// a variant reshuffles prefixes and orphans existing state — so only ever APPEND;
/// never insert or reorder. Declared up front in backend-schema order to lock it now.
///
/// Prompt 3 constructs `Delegates` (a single `IterableMap<(TaskId, AccountId), Delegate>`,
/// no secondary index) and `Allowlist`. `DelegateIndex` is now **unused** — the delegate
/// registry is one flat composite-key map, so no per-task nested `Vector` (and no
/// runtime sub-prefix) is needed — but the variant is kept reserved (append-only).
///
/// `#[allow(dead_code)]` stays for the still-reserved variants: `DelegateIndex` (unused —
/// superseded by the flat `Delegates` map) and `TaskCommitments` (also **unused for the MVP**:
/// Prompt 4's `list_commitments` filters the flat `Commitments` map per D-6, so no per-task
/// index is built; the variant stays reserved as the scale fix for when the ledger outgrows the
/// view's scan ceiling — then as its own appended field-carrying variant, never a prefix reuse).
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
/// ⚠️ Borsh layout: the struct is **final as of Prompt 4** — Prompt 4 added no new field (the
/// payment flow reuses the Prompt-2 `commitments`/`idempotency`/`next_commitment_id`). The only
/// Prompt-4 change is the `idempotency` **key type** (now `(AccountId, RequestId)` — see below),
/// a free pre-stateful-deploy change since nothing is `new()`-initialized on a funded account yet.
/// Append-only still governs any future field. Do NOT `new()`/stateful-init on testnet until the
/// demo deploy, or you owe a hand-written `#[init(ignore_state)]` migrate.
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
    /// confinement ("never blind-sign"); Prompt 5 adds the constructed-payload tamper check and
    /// any removal/replace semantics. Emits one `RecipientAllowlistSet`.
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

        // (c) VALIDATE + CONSTRUCT PAYLOAD + DENY-BY-DEFAULT ALLOWLIST (full payload hash: Prompt 5).
        let task_token = self
            .tasks
            .get(&task)
            .unwrap_or_else(|| env::panic_str(MSG_NO_SUCH_TASK))
            .token
            .clone();
        let payload = build_near_payload(&task_token, &intent, MAX_MEMO_LEN)
            .unwrap_or_else(|e| env::panic_str(&e.to_string())); // recipient parsed here, reused in (e)
        self.assert_allowlisted(&task, &payload.recipient); // fail-closed: deny-by-default

        // (d) ATOMIC ADMIT + RESERVE + IDEMPOTENCY WRITE — synchronous, before any Promise.
        let now = env::block_timestamp();
        let cid = self.open_reservation(
            &task,
            caller.clone(),
            &intent,
            &request_id,
            payload.payload_hash,
            now,
        );
        self.idempotency.insert(idem_key, IdemState::Pending);
        // NEP-297: emitted AFTER the reserve+idempotency writes; the following Promise does NO
        // synchronous state write, so this is the only correct place — do NOT move it below.
        PurserEvent::PaymentReserved {
            task_id: task,
            commitment_id: cid,
            delegate: caller,
            recipient: intent.recipient.clone(),
            amount: intent.amount,
            request_id: request_id.clone(),
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
        cid
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
    /// core, thread the (Prompt-5) payload hash onto the `Commitment`, and persist it. Panics
    /// (rolls back) on refusal: `ExceedsBudget` → "exceeds task budget"; `ZeroAmount` → "amount
    /// must be positive". On refusal nothing is persisted and the `cid` is not consumed.
    fn open_reservation(
        &mut self,
        task: &TaskId,
        delegate: AccountId,
        intent: &PaymentIntent,
        request_id: &RequestId,
        payload_hash: Option<[u8; 32]>,
        now: u64,
    ) -> CommitmentId {
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
        commitment.payload_hash = payload_hash; // None now; Prompt 5 → Some(hash), zero-churn
        self.commitments.insert(cid, commitment); // `b` borrow ended (NLL) — disjoint field
        self.next_commitment_id += 1; // monotonic; first cid = 0
        cid
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
