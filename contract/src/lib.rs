//! Purser contract crate root — the `#[near]` entrypoint/state boundary.
//!
//! This is the ONLY layer that reads `env::*`, touches the `near_sdk::store` collections,
//! emits events, and panics-to-roll-back. It composes the pure, `env`-free cores —
//! [`budget`] (accounting, BACKEND-SCHEMA §1.3), [`reservation`] (state machine), and
//! [`idempotency`] (replay guard) — behind the owner-gated control plane (task + delegate
//! registry; APP-FLOW §3/§4/§9, BACKEND-SCHEMA §1.4/§1.5). The `propose_payment`
//! reserve-before-sign path lands in Prompt 4. See the per-module banners for details.

use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault};

mod budget;
mod delegates;
mod error;
mod events;
mod idempotency;
mod reservation;
mod types;

pub use budget::{
    assert_invariant, authorize, cancel, mark_unknown, release_failed, remaining, settle_confirmed,
    try_reserve,
};
pub use error::{
    PurserError, MSG_CAP_POSITIVE, MSG_CREW_CAP_MIN, MSG_CREW_CAP_REACHED, MSG_DELEGATE_EXISTS,
    MSG_DELEGATE_NOT_AUTHORIZED, MSG_INVALID_PATH, MSG_INVALID_TASK_ID, MSG_NO_SUCH_DELEGATE,
    MSG_NO_SUCH_TASK, MSG_ONLY_OWNER, MSG_TASK_EXISTS,
};
pub use events::PurserEvent;
pub use idempotency::{classify, IdemDecision};
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
/// superseded by the flat `Delegates` map) and `TaskCommitments` (Prompt 4, whose nested
/// per-task `Vector` WILL need its own appended field-carrying variant then —
/// e.g. `TaskCommitmentsPerTask { task_id }` — never a reuse of another per-task prefix).
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
    // Prompt 3 (appended — Borsh layout is append-only): the delegate (crew) registry
    // and the recipient allowlist. `delegates` is a single flat composite-key map (no
    // secondary index — D-6). `allowlist` is wired now but written in Prompt 5.
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

    /// The delegate-authorization gate `propose_payment` (Prompt 4) will call: the
    /// predecessor (`caller`, injected by the entrypoint) must be an ACTIVE delegate of
    /// the task. Shares the single `delegates::is_authorized` predicate with the public
    /// `is_delegate_authorized` view.
    #[allow(dead_code)] // wired into propose_payment in Prompt 4; mirrors the StorageKey precedent
    pub(crate) fn assert_delegate_authorized(&self, task_id: &TaskId, caller: &AccountId) {
        require!(
            delegates::is_authorized(&self.delegates, task_id, caller),
            MSG_DELEGATE_NOT_AUTHORIZED
        );
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
}
