//! The governed EVM payment path's `#[near]` surface (Prompt 12; docs/plans/2026-11-06-feat-evm-governed-payment-path-plan.md).
//!
//! A second `#[near] impl Purser` block (near-sdk generates the `PurserExt` callback builder once per
//! struct, and every impl block adds its methods to it, so the ABI and `Self::ext(..)` see both blocks).
//! This module is the EVM half of the `env` boundary: it reads `env::*`, calls the MPC signer, verifies the
//! returned signature with `env::ecrecover`, and applies the pure cores ([`crate::evm_tx`], [`crate::budget`],
//! [`crate::reservation`]) to the stored state. It lives apart from `lib.rs` only to keep that file readable;
//! the private-field access works because this is a descendant module of the crate root that defines `Purser`.
//!
//! TRUST MODEL, in one paragraph. The contract cannot read EVM state. A single named RELAYER tells it what
//! happened on the EVM chain; the contract matches every report against hashes it signed itself, and
//! releases budget only on the OWNER's `confirm_release` (two-key). A lying relayer can over-count one lane
//! (conservative) or withhold reports (the reservation stays held); it cannot release budget or attest a
//! hash the contract did not sign. See the plan's trust-model table.
//!
//! CALLBACK TOTALITY. `on_signed` and `on_cancel_signed` never panic on a signer outcome and always leave a
//! consistent state: every post-reserve `Err` is `Unknown` (never a release), because the MPC nodes'
//! `respond` transaction carries the signature in public args even after the yield timed out.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue,
};

use crate::budget::{self, authorize, cancel, mark_ambiguous, settle_confirmed};
use crate::error::*;
use crate::events::PurserEvent;
use crate::evm_tx::{self, Eip1559Unsigned};
use crate::types::*;
use crate::{assert_invariant_unless_frozen, core_panic, Purser, PurserExt, MAX_MEMO_LEN};

/// Gas attached to the signer's `sign` call. Measured on testnet 2026-11-06 (v1.signer-prod.testnet, txs in
/// docs/EVM-PROBES.md): `sign` 4.27 + `return_signature_and_clean_state_on_success` 3.46 = 7.74 Tgas burnt,
/// so 50 leaves 6.5x headroom (the signer itself requires at least 15 attached).
pub const SIGN_GAS: Gas = Gas::from_tgas(50);
/// Static gas of `on_signed` / `on_cancel_signed`: verify a signature (one `ecrecover`), a few `store`
/// writes and one event. Measured on testnet 2026-11-06: `on_signed` 3.15 Tgas (9.5x headroom).
pub const ON_SIGNED_GAS: Gas = Gas::from_tgas(30);
/// Minimum prepaid gas a proposal (or cancel request) must arrive with, checked BEFORE anything is
/// reserved: the sign and callback gas above plus this call's own execution, with headroom. Measured on
/// testnet 2026-11-06: the synchronous part of `propose_payment` burnt 3.94 Tgas, so 2 x 3.94 + 50 + 30 = 88
/// fits in 100.
pub const EVM_MIN_PREPAID: Gas = Gas::from_tgas(100);
/// Gas for the signer's `derived_public_key` view call and for its `on_derived_key` callback. Measured on
/// testnet 2026-11-06: the signer's `derived_public_key` 5.37 Tgas (2.8x headroom), `on_derived_key` 1.97
/// Tgas (5.1x).
pub const KEY_VIEW_GAS: Gas = Gas::from_tgas(15);
pub const KEY_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Storage a proposal may add (the `EvmMeta`, the commitment, the idempotency key), as a byte budget the
/// spendable-balance preflight keeps free so the call cannot fail on a storage-stake shortfall mid-flight.
const EVM_STORAGE_HEADROOM_BYTES: u128 = 3_000;
/// The signer's domain for secp256k1 (`domain_id` 0; domain 3 is ForeignTx and is rejected).
const SIGNER_DOMAIN_ID: u64 = 0;

// ---- view / argument DTOs (JSON only; every u64/u128 is a decimal string) --------------------------

/// What an attestation says happened on the EVM chain.
#[near(serializers = [json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ExternalOutcome {
    /// The transaction was mined. `success` is the receipt status (a reverted transfer burns the nonce but
    /// moves no value). `block_number` / `block_hash` are audit-only: the contract cannot verify them.
    /// `signature` is only for the unknown-without-signature case: the relayer read `(r, s, yParity)` off
    /// the chain, and the contract accepts it only after `ecrecover` against the cached derived key.
    Landed {
        success: bool,
        finality: Finality,
        block_number: U64,
        block_hash: String,
        signature: Option<SignatureInput>,
    },
}

/// How final the reported landing is. Only `Finalized` changes state; `Safe` is recorded as an event.
#[near(serializers = [json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Finality {
    Finalized,
    Safe,
}

/// `(r, s, yParity)` as hex (`r`, `s`: 64 digits; optional `0x`).
#[near(serializers = [json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SignatureInput {
    pub r: String,
    pub s: String,
    pub y_parity: u8,
}

/// The EVM payload scheme, surfaced by [`Purser::evm_payload_scheme`] (a SEPARATE view: changing
/// `payload_scheme()`'s return type would break `packages/types`, the indexer and the app).
#[near(serializers = [json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EvmPayloadScheme {
    pub chain: String,
    pub version: u16,
    pub hash_algorithm: String,
    pub encoding: String,
    pub preimage: String,
}

/// The owner-set EVM configuration plus the fixed constants a client needs.
#[near(serializers = [json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EvmCfgView {
    pub chain_id: U64,
    pub max_fee_ceiling: U128,
    pub max_priority_ceiling: U128,
    pub min_value: U128,
    pub min_unknown_age_ns: U64,
    /// `Reserved` EVM commitments older than this may be marked Unknown (Ambiguous).
    pub reserved_ambiguous_min_age_ns: U64,
    pub gas_limit: U64,
    pub cancel_bump_bps: U64,
}

/// A derived-address lane.
#[near(serializers = [json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LaneView {
    pub path: String,
    pub chain_id: U64,
    /// `0x` + 40 hex (the address the operator funds).
    pub address: String,
    /// The cached 64-byte uncompressed key, hex.
    pub pubkey: String,
    /// `None` until seeded.
    pub next_nonce: Option<U64>,
    pub in_flight: Option<CommitmentId>,
}

/// One built transaction (original or cancel) as the relayer needs it.
#[near(serializers = [json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EvmTxView {
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub to: String,
    pub value: U128,
    /// The digest that was signed.
    pub sighash: String,
    /// `0x02 || rlp(...)` with the signature; `None` until a verified signature is recorded.
    pub raw_tx: Option<String>,
    pub tx_hash: Option<String>,
}

/// Everything EVM about one commitment ([`Purser::get_signed_tx`]).
#[near(serializers = [json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SignedTxView {
    pub commitment_id: CommitmentId,
    pub state: ReservationState,
    pub path: String,
    pub chain_id: U64,
    pub nonce: U64,
    pub from: String,
    pub signed_at_ns: Option<U64>,
    pub original: EvmTxView,
    pub cancel: Option<EvmTxView>,
    /// `cancel_landed` | `original_reverted` once the relayer attested release evidence.
    pub evidence: Option<String>,
}

// ---- pure helpers over stored values ----------------------------------------------------------------

fn keccak(b: &[u8]) -> [u8; 32] {
    env::keccak256_array(b)
}

fn original_tx(m: &EvmMeta) -> Eip1559Unsigned {
    Eip1559Unsigned {
        chain_id: m.chain_id,
        nonce: m.nonce,
        max_priority_fee_per_gas: m.tip,
        max_fee_per_gas: m.max_fee,
        gas_limit: evm_tx::GAS_LIMIT,
        to: m.to,
        value: m.value,
    }
}

fn cancel_tx(m: &EvmMeta, c: &CancelMeta) -> Eip1559Unsigned {
    Eip1559Unsigned {
        chain_id: m.chain_id,
        nonce: m.nonce,
        max_priority_fee_per_gas: c.tip,
        max_fee_per_gas: c.max_fee,
        gas_limit: evm_tx::GAS_LIMIT,
        to: m.from,
        value: 0,
    }
}

/// `ecrecover(digest, r || s, yParity, reject-high-s) == the cached derived key`. The only place a
/// signature is trusted.
fn recovers_to(sig: &EvmSig, digest: &[u8; 32], pubkey: &[u8; 64]) -> bool {
    if sig.y_parity > 1 {
        return false;
    }
    let mut rs = [0u8; 64];
    rs[..32].copy_from_slice(&sig.r);
    rs[32..].copy_from_slice(&sig.s);
    env::ecrecover(digest, &rs, sig.y_parity, true) == Some(*pubkey)
}

/// Parse the signer's response `{"scheme":"Secp256k1","big_r":{"affine_point":"02|03+64hex"},
/// "s":{"scalar":"64hex"},"recovery_id":0|1}` into `(r, s, yParity)`. `None` for anything else (a wrong
/// scheme, a short or non-hex field, `recovery_id` 2/3, a zero `r` or `s`): unparseable is never trusted.
pub(crate) fn parse_sign_response(v: &Value) -> Option<EvmSig> {
    if v.get("scheme")?.as_str()? != "Secp256k1" {
        return None;
    }
    let point = evm_tx::from_hex::<33>(v.get("big_r")?.get("affine_point")?.as_str()?)?;
    if point[0] != 2 && point[0] != 3 {
        return None;
    }
    let mut r = [0u8; 32];
    r.copy_from_slice(&point[1..]);
    let s = evm_tx::from_hex::<32>(v.get("s")?.get("scalar")?.as_str()?)?;
    let y = v.get("recovery_id")?.as_u64()?;
    if y > 1 || r == [0u8; 32] || s == [0u8; 32] {
        return None;
    }
    Some(EvmSig {
        r,
        s,
        y_parity: y as u8,
    })
}

/// The signer's `derived_public_key` answer `"secp256k1:<base58>"` -> exactly 64 bytes (x || y).
pub(crate) fn parse_derived_key(s: &str) -> Option<[u8; 64]> {
    let key: near_sdk::PublicKey = s.parse().ok()?;
    if key.curve_type() != near_sdk::CurveType::SECP256K1 {
        return None;
    }
    key.as_bytes().get(1..)?.try_into().ok()
}

/// What a signer outcome amounts to, for the totality tables.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SignOutcome {
    /// `Ok` and `ecrecover` equals the cached key.
    Valid(EvmSig),
    /// `Ok` that does not parse, or does not recover to the cached key.
    Invalid,
    /// The promise failed (signer panic, timeout, gas/deposit failure after queueing).
    Err,
}

fn classify_sign(
    res: &Result<Value, PromiseError>,
    digest: &[u8; 32],
    pubkey: &[u8; 64],
) -> SignOutcome {
    match res {
        Err(_) => SignOutcome::Err,
        Ok(v) => match parse_sign_response(v) {
            Some(sig) if recovers_to(&sig, digest, pubkey) => SignOutcome::Valid(sig),
            _ => SignOutcome::Invalid,
        },
    }
}

fn evidence_name(e: ReleaseEvidence) -> &'static str {
    match e {
        ReleaseEvidence::CancelLanded => "cancel_landed",
        ReleaseEvidence::OriginalReverted => "original_reverted",
    }
}

fn finality_name(f: Finality) -> &'static str {
    match f {
        Finality::Finalized => "finalized",
        Finality::Safe => "safe",
    }
}

/// Which of the two stored transactions an attested hash names.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Original,
    Cancel,
}

fn tx_view(tx: &Eip1559Unsigned, sighash: &[u8; 32], sig: &Option<EvmSig>) -> EvmTxView {
    EvmTxView {
        max_fee_per_gas: U128(tx.max_fee_per_gas),
        max_priority_fee_per_gas: U128(tx.max_priority_fee_per_gas),
        to: evm_tx::to_hex0x(&tx.to),
        value: U128(tx.value),
        sighash: evm_tx::to_hex0x(sighash),
        raw_tx: sig.map(|s| evm_tx::to_hex0x(&evm_tx::encode_signed(tx, &s))),
        tx_hash: sig.map(|s| evm_tx::to_hex0x(&evm_tx::tx_hash(tx, &s, keccak))),
    }
}

impl Purser {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, MSG_ONLY_OWNER);
    }

    fn assert_owner_or_relayer(&self) -> AccountId {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner || self.relayer_id.as_ref() == Some(&caller),
            MSG_ONLY_OWNER_OR_RELAYER
        );
        caller
    }

    /// The EVM configuration, or the "not configured" refusal.
    fn evm_cfg_or_panic(&self) -> EvmCfg {
        self.evm_cfg
            .unwrap_or_else(|| env::panic_str(MSG_EVM_NOT_CONFIGURED))
    }

    /// An EVM commitment's task and request id, or the refusal when `cid` is unknown or not EVM.
    fn evm_commitment(&self, cid: CommitmentId) -> (TaskId, RequestId, ReservationState) {
        let c = self
            .commitments
            .get(&cid)
            .unwrap_or_else(|| env::panic_str(MSG_NO_SUCH_COMMITMENT));
        require!(self.evm_meta.contains_key(&cid), MSG_NOT_EVM_COMMITMENT);
        (c.task.clone(), c.request_id.clone(), c.state)
    }

    /// Preflight shared by a proposal and a cancel request, run BEFORE anything is reserved or stored: the
    /// call must carry enough prepaid gas for the sign + callback chain, and the contract must be able to
    /// pay the signer's 1 yocto deposit and the storage this call adds without touching its storage stake.
    fn evm_preflight(&self) {
        require!(env::prepaid_gas() >= EVM_MIN_PREPAID, MSG_EVM_LOW_GAS);
        let byte_cost = env::storage_byte_cost().as_yoctonear();
        let staked = (env::storage_usage() as u128).saturating_mul(byte_cost);
        let spendable = env::account_balance().as_yoctonear().saturating_sub(staked);
        let need = byte_cost
            .saturating_mul(EVM_STORAGE_HEADROOM_BYTES)
            .saturating_add(1);
        require!(spendable >= need, MSG_EVM_LOW_BALANCE);
    }

    /// The MPC `sign` call for `digest` on `path`. THE ONLY `sign` CALL SITE for an EVM path: the digest
    /// is built in-contract from stored fields, the path comes from the stored delegate, the predecessor
    /// is implicitly this contract. 1 yoctoNEAR (the signer refunds the excess).
    fn sign_promise(&self, path: &str, digest: &[u8; 32]) -> Promise {
        let args = json!({
            "request": {
                "path": path,
                "payload_v2": { "Ecdsa": evm_tx::to_hex(digest) },
                "domain_id": SIGNER_DOMAIN_ID,
            }
        });
        Promise::new(self.signer_id.clone()).function_call(
            "sign".to_string(),
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            SIGN_GAS,
        )
    }

    /// The EVM arm of `propose_payment`. Called from the synchronous prefix after authorization,
    /// idempotency classification and the frozen check; everything up to the returned `Promise` is
    /// synchronous state, so NEAR's commit-at-first-promise serializes concurrent proposals exactly as it
    /// does for a NEAR-native payment (a second proposal sees the lane in flight and the committed
    /// `outstanding`).
    ///
    /// Order: lane seeded and free -> preflight -> build + validate the tx -> sighash -> reserve ->
    /// store `EvmMeta` + hold the lane -> idempotency `Pending` -> event -> THEN the sign promise.
    pub(crate) fn propose_evm(
        &mut self,
        task: TaskId,
        intent: PaymentIntent,
        request_id: RequestId,
        caller: AccountId,
    ) -> PromiseOrValue<CommitmentId> {
        let cfg = self.evm_cfg_or_panic();
        // An EVM task takes only the configured EVM chain, denominated in the task's own (wei) unit.
        let Chain::Evm { chain_id } = intent.chain else {
            env::panic_str(MSG_UNSUPPORTED_CHAIN)
        };
        require!(chain_id == cfg.chain_id, MSG_UNSUPPORTED_CHAIN);
        require!(intent.token == TokenSpec::NearNative, MSG_UNSUPPORTED_TOKEN);
        if let Some(memo) = &intent.memo {
            require!(memo.len() <= MAX_MEMO_LEN, MSG_MEMO_TOO_LONG);
        }
        let to = evm_tx::parse_address(&intent.recipient)
            .unwrap_or_else(|| env::panic_str(MSG_INVALID_RECIPIENT));

        let path = self
            .delegates
            .get(&(task.clone(), caller.clone()))
            .map(|d| d.derivation_path.clone())
            .unwrap_or_else(|| env::panic_str(MSG_DELEGATE_NOT_AUTHORIZED));
        let lane = self
            .evm_lanes
            .get(&path)
            .unwrap_or_else(|| env::panic_str(MSG_EVM_KEY_NOT_CACHED));
        require!(lane.chain_id == cfg.chain_id, MSG_UNSUPPORTED_CHAIN);
        let address = lane.address;
        let nonce = evm_tx::lane_peek(lane).unwrap_or_else(core_panic);

        self.evm_preflight();

        // Build + validate BEFORE any digest exists; nothing below the validation can be refused for a
        // reason that was knowable here.
        let value = intent.amount.as_yoctonear();
        let tx =
            evm_tx::build_original(&cfg, chain_id, nonce, to, value).unwrap_or_else(core_panic);
        let sighash = evm_tx::checked_sighash(&tx, keccak).unwrap_or_else(core_panic);

        let now = env::block_timestamp();
        let (cid, payload_hash, payload_version) = self.open_reservation(
            &task,
            caller.clone(),
            &intent,
            &request_id,
            crate::PayloadAnchor::Evm(sighash),
            now,
        );
        self.evm_meta.insert(
            cid,
            EvmMeta {
                path: path.clone(),
                nonce,
                sighash,
                from: address,
                to,
                value,
                chain_id,
                max_fee: tx.max_fee_per_gas,
                tip: tx.max_priority_fee_per_gas,
                sig: None,
                tx_hash: None,
                signed_at_ns: None,
                cancel: None,
                evidence: None,
            },
        );
        let lane = self
            .evm_lanes
            .get_mut(&path)
            .expect("lane presence checked above");
        evm_tx::lane_hold(lane, cid).unwrap_or_else(core_panic);
        self.idempotency
            .insert((caller.clone(), request_id.clone()), IdemState::Pending);
        PurserEvent::PaymentReserved {
            task_id: task,
            commitment_id: cid,
            delegate: caller,
            recipient: evm_tx::to_hex0x(&to),
            amount: intent.amount,
            request_id: request_id.clone(),
            payload_hash,
            payload_version,
        }
        .emit();

        // ---- NO ASYNC ABOVE THIS LINE ----
        // The reservation, the lane hold and `Pending` are committed before the signer is called.
        PromiseOrValue::Promise(
            self.sign_promise(&path, &sighash).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_SIGNED_GAS)
                    .on_signed(cid, request_id),
            ),
        )
    }
}

#[near]
impl Purser {
    // ---- owner-gated EVM setup -----------------------------------------------------------------

    /// Store the EVM configuration (owner-only). `chain_id` must be a testnet id (Sepolia); the fee fields
    /// are `maxFeePerGas` / `maxPriorityFeePerGas` CEILINGS (an original is priced AT the ceiling, a
    /// cancel anywhere between its bump and the ceiling); `min_value` is the smallest wei an original may
    /// carry; `min_unknown_age_ns` (>= 5 minutes) is how long a `Signed` commitment waits before
    /// `mark_unknown`. A change never alters an already-built transaction (its fees are copied into
    /// `EvmMeta`).
    pub fn set_evm_cfg(
        &mut self,
        chain_id: U64,
        max_fee_ceiling: U128,
        max_priority_ceiling: U128,
        min_value: U128,
        min_unknown_age_ns: U64,
    ) {
        self.assert_owner();
        let cfg = EvmCfg {
            chain_id: chain_id.0,
            max_fee_ceiling: max_fee_ceiling.0,
            max_priority_ceiling: max_priority_ceiling.0,
            min_value: min_value.0,
            min_unknown_age_ns: min_unknown_age_ns.0,
        };
        require!(evm_tx::validate_cfg(&cfg), MSG_EVM_BAD_CFG);
        // Lanes are bound to one chain (nonces are per chain per address).
        require!(
            self.evm_cfg.is_none_or(|c| c.chain_id == cfg.chain_id),
            MSG_EVM_BAD_CFG
        );
        self.evm_cfg = Some(cfg);
        PurserEvent::EvmCfgSet {
            chain_id,
            max_fee_ceiling,
            max_priority_ceiling,
            min_value,
            min_unknown_age_ns,
        }
        .emit();
    }

    /// Mark an EMPTY NEAR-denominated task as an EVM task (owner-only, irreversible). Its amounts are wei
    /// in the same `u128`; it accepts only `Chain::Evm`, and every other task accepts only
    /// `Chain::NearNative`, so wei and yocto never share a cap. "Empty" means it has never had a
    /// delegate (a revoked delegate stays in the registry, and a proposal needs one, so no delegate
    /// entry means no commitment ever existed).
    pub fn enable_evm_task(&mut self, task_id: TaskId) {
        self.assert_owner();
        let b = self
            .tasks
            .get(&task_id)
            .unwrap_or_else(|| env::panic_str(MSG_NO_SUCH_TASK));
        require!(b.token == TokenSpec::NearNative, MSG_UNSUPPORTED_TOKEN);
        require!(
            !self.delegates.keys().any(|k| k.0 == task_id),
            MSG_EVM_TASK_NOT_EMPTY
        );
        self.evm_tasks.insert(task_id.clone());
        PurserEvent::EvmTaskEnabled { task_id }.emit();
    }

    /// Fetch and cache the derived public key of a delegate's lane (owner-only). The path is read from the
    /// STORED delegate (never an argument) and the predecessor is this contract (never an argument), so
    /// the owner cannot make the contract trust a key for a path it does not govern. The answer is
    /// cached write-once by [`Self::on_derived_key`] and creates the lane, bound to the task and chain.
    pub fn cache_derived_key(
        &mut self,
        task_id: TaskId,
        account_id: AccountId,
    ) -> PromiseOrValue<bool> {
        self.assert_owner();
        let cfg = self.evm_cfg_or_panic();
        require!(self.evm_tasks.contains(&task_id), MSG_NOT_EVM_TASK);
        let path = self
            .delegates
            .get(&(task_id, account_id))
            .map(|d| d.derivation_path.clone())
            .unwrap_or_else(|| env::panic_str(MSG_NO_SUCH_DELEGATE));
        require!(!self.evm_lanes.contains_key(&path), MSG_EVM_KEY_CACHED);
        let args = json!({
            "path": path,
            "predecessor": env::current_account_id(),
            "domain_id": SIGNER_DOMAIN_ID,
        });
        PromiseOrValue::Promise(
            Promise::new(self.signer_id.clone())
                .function_call(
                    "derived_public_key".to_string(),
                    args.to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    KEY_VIEW_GAS,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(KEY_CALLBACK_GAS)
                        .on_derived_key(path, cfg.chain_id.into()),
                ),
        )
    }

    /// Cache callback. Requires the answer to parse as `secp256k1:<base58>` of exactly 64 bytes and is
    /// WRITE-ONCE: a differing value emits an event and writes nothing. Never panics on a signer answer
    /// (a failed or malformed one is an event, so the owner can retry).
    #[private]
    pub fn on_derived_key(
        &mut self,
        path: String,
        chain_id: U64,
        #[callback_result] res: Result<String, PromiseError>,
    ) -> bool {
        let reject = |reason: &str| {
            PurserEvent::DerivedKeyCached {
                path: path.clone(),
                address: String::new(),
                cached: false,
                reason: reason.to_string(),
            }
            .emit();
            false
        };
        let Ok(raw) = res else {
            return reject("signer_error");
        };
        let Some(pubkey) = parse_derived_key(&raw) else {
            return reject("invalid_key");
        };
        let address = evm_tx::address_of(&pubkey, keccak);
        if let Some(existing) = self.evm_lanes.get(&path) {
            let (same, addr) = (existing.pubkey == pubkey, existing.address);
            PurserEvent::DerivedKeyCached {
                path,
                address: evm_tx::to_hex0x(&addr),
                cached: false,
                reason: if same { "already_cached" } else { "conflict" }.to_string(),
            }
            .emit();
            return false;
        }
        self.evm_lanes.insert(
            path.clone(),
            Lane {
                path: path.clone(),
                chain_id: chain_id.0,
                pubkey,
                address,
                next_nonce: None,
                in_flight: None,
            },
        );
        PurserEvent::DerivedKeyCached {
            path,
            address: evm_tx::to_hex0x(&address),
            cached: true,
            reason: String::new(),
        }
        .emit();
        true
    }

    /// Seed (or raise) a lane's next nonce (owner-only). One-shot while unseeded; afterwards only while the
    /// lane is empty and the value is not lower (a lowered nonce would reuse a burnt one). The value comes
    /// from `eth_getTransactionCount(address, 'finalized')`; proposals are refused until the lane is seeded.
    pub fn seed_evm_nonce(&mut self, path: String, nonce: U64) {
        self.assert_owner();
        let lane = self
            .evm_lanes
            .get_mut(&path)
            .unwrap_or_else(|| env::panic_str(MSG_EVM_KEY_NOT_CACHED));
        evm_tx::lane_seed(lane, nonce.0).unwrap_or_else(core_panic);
        PurserEvent::EvmNonceSeeded {
            path,
            next_nonce: nonce,
        }
        .emit();
    }

    /// Set the single relayer (owner-only). `owner != relayer` is a hard check (two-key release), and the
    /// relayer cannot be changed while any EVM commitment is `Signed` or `Unknown` (a swap mid-flight would
    /// orphan the attestations in progress). O(ledger) scan; this is a rare owner action.
    pub fn set_relayer(&mut self, relayer: AccountId) {
        self.assert_owner();
        require!(relayer != self.owner, MSG_RELAYER_IS_OWNER);
        require!(
            !self.commitments.values().any(|c| {
                matches!(c.intent.chain, Chain::Evm { .. })
                    && matches!(
                        c.state,
                        ReservationState::Signed | ReservationState::Unknown
                    )
            }),
            MSG_RELAYER_BUSY
        );
        self.relayer_id = Some(relayer.clone());
        PurserEvent::RelayerSet { relayer }.emit();
    }

    // ---- signer callbacks --------------------------------------------------------------------

    /// `sign` callback. TOTAL: never panics on a signer outcome (see the module note and the plan's table).
    ///
    /// | state on arrival | `Ok` + valid | `Ok` + invalid | `Err` |
    /// |---|---|---|---|
    /// | Reserved | -> Signed | -> Unknown | -> Unknown |
    /// | Unknown | record (sig, hash), state unchanged | event only | no-op |
    /// | Signed / Confirmed / Cancelled / Failed | record the hash if not yet known | event only | no-op |
    ///
    /// "Valid" means `ecrecover` equals the cached derived key. An `Err` is NOT proof that no signature
    /// exists, so it never releases budget. Uses `#[callback_result]` with a lenient `Value`, so a garbled
    /// but well-formed JSON answer is `Ok` + invalid (a non-JSON answer would fail inside near-sdk before
    /// this runs; the signer contract only returns JSON, and `mark_unknown` is the recovery for a stuck
    /// `Reserved`).
    #[private]
    pub fn on_signed(
        &mut self,
        cid: CommitmentId,
        request_id: RequestId,
        #[callback_result] res: Result<Value, PromiseError>,
    ) -> CommitmentId {
        let now = env::block_timestamp();
        let commitment = self
            .commitments
            .get(&cid)
            .expect("callback cid always exists");
        let task_id = commitment.task.clone();
        let caller = commitment.delegate.clone();
        let mut meta = self
            .evm_meta
            .get(&cid)
            .cloned()
            .expect("an EVM commitment has meta");
        let pubkey = self
            .evm_lanes
            .get(&meta.path)
            .expect("an EVM commitment has a lane")
            .pubkey;
        let outcome = classify_sign(&res, &meta.sighash, &pubkey);
        let b = self
            .tasks
            .get_mut(&task_id)
            .expect("task of a live commitment exists");
        let c = self
            .commitments
            .get_mut(&cid)
            .expect("callback cid always exists");
        let state = c.state;
        let mut recorded = false;
        match (state, outcome) {
            (ReservationState::Reserved, SignOutcome::Valid(sig)) => {
                authorize(c, now).unwrap_or_else(core_panic);
                meta.signed_at_ns = Some(now);
                Self::record_original_sig(&mut meta, c, sig);
                self.idempotency.insert(
                    (caller, request_id.clone()),
                    IdemState::Committed { commitment_id: cid },
                );
                recorded = true;
            }
            (ReservationState::Reserved, other) => {
                // Err or an unverifiable Ok: a signature may exist in public, so hold the reservation.
                budget::mark_ambiguous(c, now).unwrap_or_else(core_panic);
                self.idempotency.insert(
                    (caller, request_id.clone()),
                    IdemState::Committed { commitment_id: cid },
                );
                let reason = if other == SignOutcome::Err {
                    "signer_error"
                } else {
                    "invalid_signature"
                };
                PurserEvent::PaymentUnknown {
                    task_id: task_id.clone(),
                    commitment_id: cid,
                    request_id: request_id.clone(),
                    reason: reason.to_string(),
                    state: c.state,
                }
                .emit();
            }
            (_, SignOutcome::Valid(sig)) => {
                // Unknown / Signed / terminal: record what a late signature proves so attestations and
                // contradictions can match it; never move the state.
                if meta.sig.is_none() {
                    meta.signed_at_ns.get_or_insert(now);
                    Self::record_original_sig(&mut meta, c, sig);
                    recorded = true;
                    if state == ReservationState::Failed {
                        // `Failed` + `Ok`: the premise "Err means no signature" broke. Flag it.
                        PurserEvent::PaymentUnknown {
                            task_id: task_id.clone(),
                            commitment_id: cid,
                            request_id: request_id.clone(),
                            reason: "signature_after_failed".to_string(),
                            state,
                        }
                        .emit();
                    }
                }
            }
            (_, SignOutcome::Invalid) => {
                PurserEvent::PaymentUnknown {
                    task_id: task_id.clone(),
                    commitment_id: cid,
                    request_id: request_id.clone(),
                    reason: "late_invalid_signature".to_string(),
                    state,
                }
                .emit();
            }
            (_, SignOutcome::Err) => {} // a late Err on an already-resolved commitment: nothing to learn
        }
        if recorded {
            PurserEvent::PaymentSigned {
                task_id,
                commitment_id: cid,
                request_id,
                tx_hash: evm_tx::to_hex0x(&meta.tx_hash.expect("recorded implies a hash")),
                nonce: U64(meta.nonce),
                from: evm_tx::to_hex0x(&meta.from),
                to: evm_tx::to_hex0x(&meta.to),
                late: state != ReservationState::Reserved,
                state: c.state,
            }
            .emit();
        }
        assert_invariant_unless_frozen(b); // defense-in-depth backstop after the mutation
        self.evm_meta.insert(cid, meta);
        cid
    }

    /// `sign` callback for the cancel slot; the same discipline as [`Self::on_signed`], keyed to
    /// `EvmMeta.cancel`. The natural state is `Unknown` (a cancel is only requested from there):
    /// a valid signature is recorded, an invalid one or an `Err` leaves the commitment `Unknown` with its
    /// budget locked (safe) and emits an event so the operator learns the cancel did not sign. A valid
    /// signature that arrives in any other state is still recorded so the cancel's hash can be matched.
    #[private]
    pub fn on_cancel_signed(
        &mut self,
        cid: CommitmentId,
        #[callback_result] res: Result<Value, PromiseError>,
    ) -> CommitmentId {
        let commitment = self
            .commitments
            .get(&cid)
            .expect("callback cid always exists");
        let (task_id, request_id, state) = (
            commitment.task.clone(),
            commitment.request_id.clone(),
            commitment.state,
        );
        let mut meta = self
            .evm_meta
            .get(&cid)
            .cloned()
            .expect("an EVM commitment has meta");
        let Some(mut cm) = meta.cancel else {
            return cid; // unreachable: the slot is written before the promise is created
        };
        let pubkey = self
            .evm_lanes
            .get(&meta.path)
            .expect("an EVM commitment has a lane")
            .pubkey;
        match classify_sign(&res, &cm.sighash, &pubkey) {
            SignOutcome::Valid(sig) => {
                if cm.sig.is_none() {
                    let hash = evm_tx::tx_hash(&cancel_tx(&meta, &cm), &sig, keccak);
                    cm.sig = Some(sig);
                    cm.tx_hash = Some(hash);
                    meta.cancel = Some(cm);
                    self.evm_meta.insert(cid, meta);
                    PurserEvent::CancelSigned {
                        task_id,
                        commitment_id: cid,
                        tx_hash: evm_tx::to_hex0x(&hash),
                        max_fee: U128(cm.max_fee),
                        tip: U128(cm.tip),
                        late: state != ReservationState::Unknown,
                    }
                    .emit();
                }
            }
            SignOutcome::Invalid => {
                Self::free_unsigned_cancel_slot(&mut meta, &cm);
                self.evm_meta.insert(cid, meta);
                PurserEvent::PaymentUnknown {
                    task_id,
                    commitment_id: cid,
                    request_id,
                    reason: "cancel_invalid_signature".to_string(),
                    state,
                }
                .emit()
            }
            SignOutcome::Err => {
                Self::free_unsigned_cancel_slot(&mut meta, &cm);
                self.evm_meta.insert(cid, meta);
                if state == ReservationState::Unknown {
                    PurserEvent::PaymentUnknown {
                        task_id,
                        commitment_id: cid,
                        request_id,
                        reason: "cancel_signer_error".to_string(),
                        state,
                    }
                    .emit();
                }
            }
        }
        cid
    }

    /// A cancel whose `sign` answer failed (Err or unverifiable) and that holds NO verified signature
    /// never produced a transaction, so its slot is freed and `request_cancel` can be retried. This is
    /// the only place the slot is cleared, and each request has exactly one callback, so the
    /// compare-and-set holds: while the callback is pending the slot is occupied (a second request is
    /// refused), and a verified signature (callback or attested recovery) is never cleared. A signature
    /// recovered through `attest_external` for the cleared attempt is still matched if the retry used
    /// the same fees (identical digest); a different-fee retry replaces the digest, which is safe because
    /// only one cancel digest is ever eligible at a time.
    fn free_unsigned_cancel_slot(meta: &mut EvmMeta, cm: &CancelMeta) {
        if cm.sig.is_none() {
            meta.cancel = None;
        }
    }

    // ---- relayer / owner flow --------------------------------------------------------------------

    /// Move a stuck EVM commitment to `Unknown` (owner or relayer only; never permissionless). A `Signed`
    /// commitment older than `cfg.min_unknown_age_ns` becomes Unknown (Timeout); a `Reserved` one older than
    /// `RESERVED_AMBIGUOUS_MIN_AGE_NS` (1 h, longer than the signer's yield timeout) becomes Unknown
    /// (Ambiguous). NO accounting change: Unknown stays reserved. Returns `false` (a no-op, so a blind
    /// resend is safe) when the commitment has already left Reserved/Signed; refuses too-early calls.
    pub fn mark_unknown(&mut self, commitment_id: CommitmentId) -> bool {
        self.assert_owner_or_relayer();
        let (task_id, request_id, state) = self.evm_commitment(commitment_id);
        let now = env::block_timestamp();
        let meta = self
            .evm_meta
            .get(&commitment_id)
            .expect("presence checked above");
        let c = self
            .commitments
            .get_mut(&commitment_id)
            .expect("presence checked above");
        let reason = match state {
            ReservationState::Signed => {
                let cfg = self
                    .evm_cfg
                    .unwrap_or_else(|| env::panic_str(MSG_EVM_NOT_CONFIGURED));
                let signed_at = meta.signed_at_ns.unwrap_or(c.created_at);
                require!(
                    now >= signed_at.saturating_add(cfg.min_unknown_age_ns),
                    MSG_TOO_EARLY_UNKNOWN
                );
                budget::mark_unknown(c, now).unwrap_or_else(core_panic);
                "timeout"
            }
            ReservationState::Reserved => {
                require!(
                    now >= c
                        .created_at
                        .saturating_add(evm_tx::RESERVED_AMBIGUOUS_MIN_AGE_NS),
                    MSG_TOO_EARLY_UNKNOWN
                );
                mark_ambiguous(c, now).unwrap_or_else(core_panic);
                // Same as `on_signed`'s ambiguous path: the first of Reserved->Signed / Reserved->Unknown
                // moves idempotency to Committed, so a retried request_id replays the cid.
                self.idempotency.insert(
                    (c.delegate.clone(), request_id.clone()),
                    IdemState::Committed { commitment_id },
                );
                "ambiguous"
            }
            _ => return false,
        };
        PurserEvent::PaymentUnknown {
            task_id,
            commitment_id,
            request_id,
            reason: reason.to_string(),
            state: ReservationState::Unknown,
        }
        .emit();
        true
    }

    /// The relayer's (or owner's) report of what happened on the EVM chain to a hash this contract signed.
    ///
    /// `kind` (original vs cancel) is DERIVED from which stored hash matches, never caller-supplied. A hash
    /// the contract did not sign is refused, except in the one recovery case where the signature itself was
    /// lost (`Unknown`, no signature recorded): the outcome may carry `(r, s, yParity)`, which is accepted
    /// only if `ecrecover(stored sighash)` equals the cached key and the recomputed hash equals `tx_hash`.
    ///
    /// TOTAL and IDEMPOTENT (works on frozen tasks; never panics on a state combination):
    /// - Original, success, `Finalized`: `Signed | Unknown -> Confirmed` (`spent = value`); the lane
    ///   advances. After a release (`Cancelled`) it is a CONTRADICTION: the spend is recorded
    ///   (`Cancelled -> Confirmed`) and the task freezes if that breaks (I).
    /// - Original, reverted, `Finalized`: the nonce burned and no value moved. Evidence is recorded
    ///   (`Signed` becomes `Unknown`); only the owner's `confirm_release` frees the budget.
    /// - Cancel landed, `Finalized`: evidence is recorded in `Unknown`; the owner releases.
    /// - `Safe` is recorded as an event and changes nothing.
    /// - The same outcome on a settled state is a silent no-op.
    pub fn attest_external(
        &mut self,
        commitment_id: CommitmentId,
        tx_hash: String,
        outcome: ExternalOutcome,
    ) {
        self.assert_owner_or_relayer();
        let ExternalOutcome::Landed {
            success,
            finality,
            block_number,
            block_hash,
            signature,
        } = outcome;
        let hash =
            evm_tx::from_hex::<32>(&tx_hash).unwrap_or_else(|| env::panic_str(MSG_INVALID_TX_HASH));
        let block_hash = evm_tx::from_hex::<32>(&block_hash)
            .unwrap_or_else(|| env::panic_str(MSG_INVALID_TX_HASH));
        let (task_id, request_id, state) = self.evm_commitment(commitment_id);
        let now = env::block_timestamp();
        let mut meta = self
            .evm_meta
            .get(&commitment_id)
            .cloned()
            .expect("presence checked above");
        let pubkey = self
            .evm_lanes
            .get(&meta.path)
            .expect("an EVM commitment has a lane")
            .pubkey;
        let sig_input = signature.map(|s| {
            let r = evm_tx::from_hex::<32>(&s.r);
            let sv = evm_tx::from_hex::<32>(&s.s);
            match (r, sv) {
                (Some(r), Some(s2)) => EvmSig {
                    r,
                    s: s2,
                    y_parity: s.y_parity,
                },
                _ => env::panic_str(MSG_INVALID_TX_HASH),
            }
        });
        let delegate = self
            .commitments
            .get(&commitment_id)
            .expect("presence checked above")
            .delegate
            .clone();

        // 1. Which stored transaction does this hash name?
        let kind = if meta.tx_hash == Some(hash) {
            Kind::Original
        } else if meta.cancel.and_then(|c| c.tx_hash) == Some(hash) {
            Kind::Cancel
        } else if let Some(sig) = sig_input {
            // Recovery: the signature was lost (garbled or failed callback) but the transaction landed.
            let from_orig = (state == ReservationState::Unknown && meta.sig.is_none())
                .then(|| {
                    let tx = original_tx(&meta);
                    (recovers_to(&sig, &meta.sighash, &pubkey)
                        && evm_tx::tx_hash(&tx, &sig, keccak) == hash)
                        .then_some(tx)
                })
                .flatten();
            if from_orig.is_some() {
                meta.signed_at_ns.get_or_insert(now);
                let c = self
                    .commitments
                    .get_mut(&commitment_id)
                    .expect("presence checked above");
                Self::record_original_sig(&mut meta, c, sig);
                Kind::Original
            } else if let Some(mut cm) = meta.cancel.filter(|cm| cm.sig.is_none()) {
                let tx = cancel_tx(&meta, &cm);
                if recovers_to(&sig, &cm.sighash, &pubkey)
                    && evm_tx::tx_hash(&tx, &sig, keccak) == hash
                {
                    cm.sig = Some(sig);
                    cm.tx_hash = Some(hash);
                    meta.cancel = Some(cm);
                    Kind::Cancel
                } else {
                    env::panic_str(MSG_UNKNOWN_TX_HASH)
                }
            } else {
                env::panic_str(MSG_UNKNOWN_TX_HASH)
            }
        } else {
            env::panic_str(MSG_UNKNOWN_TX_HASH)
        };

        // 2. Apply it. Disjoint field borrows (tasks / commitments / lanes), as in `on_near_settled`.
        let b = self
            .tasks
            .get_mut(&task_id)
            .expect("task of a live commitment exists");
        let c = self
            .commitments
            .get_mut(&commitment_id)
            .expect("presence checked above");
        let finalized = finality == Finality::Finalized;
        let reserved = c.reserved_amount;
        let mut contradicted = false;
        let mut emit = true;
        match (kind, success) {
            (Kind::Original, true) => match state {
                ReservationState::Signed | ReservationState::Unknown if finalized => {
                    settle_confirmed(b, c, reserved, now).unwrap_or_else(core_panic);
                    let lane = self
                        .evm_lanes
                        .get_mut(&meta.path)
                        .expect("an EVM commitment has a lane");
                    evm_tx::lane_release(lane, commitment_id, meta.nonce)
                        .unwrap_or_else(core_panic);
                    self.idempotency.insert(
                        (delegate, request_id.clone()),
                        IdemState::Committed { commitment_id },
                    );
                    PurserEvent::PaymentConfirmed {
                        task_id: task_id.clone(),
                        commitment_id,
                        request_id: request_id.clone(),
                        actual_spent: reserved,
                    }
                    .emit();
                }
                ReservationState::Cancelled if finalized => {
                    // The release was wrong: the original landed. Record the spend, freeze if over cap.
                    // The nonce is the one the cancel burnt, so the lane neither re-holds nor re-advances.
                    budget::contradict_cancelled(b, c, reserved, now).unwrap_or_else(core_panic);
                    self.idempotency.insert(
                        (delegate, request_id.clone()),
                        IdemState::Committed { commitment_id },
                    );
                    contradicted = true;
                }
                ReservationState::Confirmed => emit = false, // idempotent
                _ => {} // `Safe`, or a state this report cannot move: recorded as an event only
            },
            (Kind::Original, false) => match state {
                _ if !finalized => {}
                ReservationState::Signed => {
                    budget::mark_unknown(c, now).unwrap_or_else(core_panic);
                    meta.evidence
                        .get_or_insert(ReleaseEvidence::OriginalReverted);
                    PurserEvent::PaymentUnknown {
                        task_id: task_id.clone(),
                        commitment_id,
                        request_id: request_id.clone(),
                        reason: "reverted_original".to_string(),
                        state: c.state,
                    }
                    .emit();
                }
                ReservationState::Unknown => {
                    meta.evidence
                        .get_or_insert(ReleaseEvidence::OriginalReverted);
                }
                ReservationState::Confirmed => contradicted = true, // finalized success vs finalized revert
                ReservationState::Cancelled => emit = false,        // agrees with the release
                _ => {}
            },
            (Kind::Cancel, _) => match state {
                _ if !finalized => {}
                ReservationState::Unknown => {
                    // the cancel burnt the nonce, whatever its own receipt status
                    meta.evidence = Some(ReleaseEvidence::CancelLanded);
                }
                ReservationState::Confirmed => contradicted = true,
                ReservationState::Cancelled => emit = false, // idempotent
                _ => env::panic_str(MSG_UNKNOWN_TX_HASH), // a cancel hash against Reserved/Signed/Failed
            },
        }
        if emit {
            PurserEvent::ExternalAttested {
                task_id,
                commitment_id,
                kind: match kind {
                    Kind::Original => "original",
                    Kind::Cancel => "cancel",
                }
                .to_string(),
                tx_hash: evm_tx::to_hex0x(&hash),
                success,
                finality: finality_name(finality).to_string(),
                block_number,
                block_hash: evm_tx::to_hex0x(&block_hash),
                contradicted,
                frozen: b.frozen,
                state: c.state,
            }
            .emit();
        }
        assert_invariant_unless_frozen(b);
        self.evm_meta.insert(commitment_id, meta);
    }

    /// Request the single nonce-burn cancel of an `Unknown` commitment (owner or relayer). Builds, from
    /// stored fields only, the same nonce, `to = lane address`, `value = 0`, `gas = 21000`; the fees are
    /// explicit but must be `>= ceil(1.125 x original)` on BOTH fields and within the ceilings (a +12.5%
    /// bump cannot unstick a transaction priced below the base fee, so the caller may go up to the
    /// ceiling). The slot is claimed synchronously BEFORE the sign promise, which is the compare-and-set: a
    /// duplicate request simply fails. There is one cancel in v1 (no escalation): a cancel that is itself
    /// stuck leaves the commitment `Unknown` with its budget locked, which is safe. A cancel whose `sign`
    /// failed with no verified signature frees the slot in `on_cancel_signed`, so it can be requested again. Allowed on a frozen
    /// task (it is the way out).
    pub fn request_cancel(
        &mut self,
        commitment_id: CommitmentId,
        max_fee: U128,
        tip: U128,
    ) -> PromiseOrValue<CommitmentId> {
        self.assert_owner_or_relayer();
        let cfg = self.evm_cfg_or_panic();
        let (_task, _req, state) = self.evm_commitment(commitment_id);
        require!(state == ReservationState::Unknown, MSG_NOT_CANCELLABLE);
        let meta = self
            .evm_meta
            .get(&commitment_id)
            .expect("presence checked above");
        require!(meta.cancel.is_none(), MSG_CANCEL_EXISTS);
        self.evm_preflight();
        let tx = evm_tx::build_cancel(
            &cfg,
            meta.chain_id,
            meta.nonce,
            meta.from,
            meta.max_fee,
            meta.tip,
            max_fee.0,
            tip.0,
        )
        .unwrap_or_else(core_panic);
        let sighash = evm_tx::checked_sighash(&tx, keccak).unwrap_or_else(core_panic);
        let path = meta.path.clone();
        let meta = self
            .evm_meta
            .get_mut(&commitment_id)
            .expect("presence checked above");
        meta.cancel = Some(CancelMeta {
            max_fee: tx.max_fee_per_gas,
            tip: tx.max_priority_fee_per_gas,
            sighash,
            sig: None,
            tx_hash: None,
        });
        // ---- NO ASYNC ABOVE THIS LINE ----
        PromiseOrValue::Promise(
            self.sign_promise(&path, &sighash).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_SIGNED_GAS)
                    .on_cancel_signed(commitment_id),
            ),
        )
    }

    /// Release an `Unknown` commitment on attested evidence (owner-only: the second key). Requires that
    /// the relayer attested a landed cancel or a reverted original (`Finalized`); then `Unknown ->
    /// Cancelled`, the reservation returns to the budget, and the lane advances past the burnt nonce.
    /// Allowed on a frozen task. If the original later lands anyway, `attest_external` records the
    /// contradiction and freezes the task.
    pub fn confirm_release(&mut self, commitment_id: CommitmentId) {
        self.assert_owner();
        let (task_id, request_id, state) = self.evm_commitment(commitment_id);
        require!(state == ReservationState::Unknown, MSG_NOT_CANCELLABLE);
        let now = env::block_timestamp();
        let meta = self
            .evm_meta
            .get(&commitment_id)
            .expect("presence checked above");
        let evidence = meta
            .evidence
            .unwrap_or_else(|| env::panic_str(MSG_NO_RELEASE_EVIDENCE));
        let (path, nonce) = (meta.path.clone(), meta.nonce);
        let b = self
            .tasks
            .get_mut(&task_id)
            .expect("task of a live commitment exists");
        let c = self
            .commitments
            .get_mut(&commitment_id)
            .expect("presence checked above");
        cancel(b, c, now).unwrap_or_else(core_panic);
        let delegate = c.delegate.clone();
        let lane = self
            .evm_lanes
            .get_mut(&path)
            .expect("an EVM commitment has a lane");
        evm_tx::lane_release(lane, commitment_id, nonce).unwrap_or_else(core_panic);
        self.idempotency
            .insert((delegate, request_id.clone()), IdemState::Failed);
        assert_invariant_unless_frozen(b);
        PurserEvent::PaymentCancelled {
            task_id,
            commitment_id,
            request_id,
            evidence: evidence_name(evidence).to_string(),
        }
        .emit();
    }

    // ---- views ---------------------------------------------------------------------------------

    /// The EVM configuration and its fixed constants, or `None` until the owner sets it.
    pub fn get_evm_cfg(&self) -> Option<EvmCfgView> {
        self.evm_cfg.map(|c| EvmCfgView {
            chain_id: U64(c.chain_id),
            max_fee_ceiling: U128(c.max_fee_ceiling),
            max_priority_ceiling: U128(c.max_priority_ceiling),
            min_value: U128(c.min_value),
            min_unknown_age_ns: U64(c.min_unknown_age_ns),
            reserved_ambiguous_min_age_ns: U64(evm_tx::RESERVED_AMBIGUOUS_MIN_AGE_NS),
            gas_limit: U64(evm_tx::GAS_LIMIT),
            cancel_bump_bps: U64(evm_tx::CANCEL_BUMP_BPS as u64),
        })
    }

    /// The single relayer, if set.
    pub fn get_relayer(&self) -> Option<AccountId> {
        self.relayer_id.clone()
    }

    /// The EVM `payload_hash` scheme (a sibling of [`Self::payload_scheme`], which is unchanged). A
    /// commitment's `payload_version` identifies it.
    pub fn evm_payload_scheme(&self) -> EvmPayloadScheme {
        EvmPayloadScheme {
            chain: evm_tx::EVM_PAYLOAD_CHAIN_TAG.to_string(),
            version: evm_tx::EVM_PAYLOAD_VERSION,
            hash_algorithm: evm_tx::EVM_PAYLOAD_HASH_ALG.to_string(),
            encoding: evm_tx::EVM_PAYLOAD_ENCODING.to_string(),
            preimage: evm_tx::EVM_PAYLOAD_PREIMAGE_SPEC.to_string(),
        }
    }

    /// The unit of a task's amounts: `"wei"` for an EVM task, `"yocto"` for any other known task, `None`
    /// for an unknown one. Lets a UI label the same `u128` correctly.
    pub fn task_unit(&self, task_id: TaskId) -> Option<String> {
        if !self.tasks.contains_key(&task_id) {
            return None;
        }
        Some(
            if self.evm_tasks.contains(&task_id) {
                "wei"
            } else {
                "yocto"
            }
            .to_string(),
        )
    }

    /// A derived-address lane by derivation path, or `None` until its key is cached.
    pub fn evm_lane(&self, path: String) -> Option<LaneView> {
        self.evm_lanes.get(&path).map(|l| LaneView {
            path: l.path.clone(),
            chain_id: U64(l.chain_id),
            address: evm_tx::to_hex0x(&l.address),
            pubkey: evm_tx::to_hex(&l.pubkey),
            next_nonce: l.next_nonce.map(U64),
            in_flight: l.in_flight,
        })
    }

    /// The built transaction(s) of an EVM commitment, with the raw signed bytes and hashes once a verified
    /// signature is recorded: the relayer broadcasts `raw_tx` as given (it validates, it never re-encodes).
    /// Anyone can read this, so anyone can broadcast the original at any time; strategies must assume so.
    pub fn get_signed_tx(&self, commitment_id: CommitmentId) -> Option<SignedTxView> {
        let c = self.commitments.get(&commitment_id)?;
        let m = self.evm_meta.get(&commitment_id)?;
        Some(SignedTxView {
            commitment_id,
            state: c.state,
            path: m.path.clone(),
            chain_id: U64(m.chain_id),
            nonce: U64(m.nonce),
            from: evm_tx::to_hex0x(&m.from),
            signed_at_ns: m.signed_at_ns.map(U64),
            original: tx_view(&original_tx(m), &m.sighash, &m.sig),
            cancel: m
                .cancel
                .as_ref()
                .map(|cm| tx_view(&cancel_tx(m, cm), &cm.sighash, &cm.sig)),
            evidence: m.evidence.map(|e| evidence_name(e).to_string()),
        })
    }
}

impl Purser {
    /// Record a verified signature on the original: hash, `Commitment.evm_tx`. Pure bookkeeping.
    fn record_original_sig(meta: &mut EvmMeta, c: &mut Commitment, sig: EvmSig) {
        let hash = evm_tx::tx_hash(&original_tx(meta), &sig, keccak);
        meta.sig = Some(sig);
        meta.tx_hash = Some(hash);
        c.evm_tx = Some(evm_tx::to_hex0x(&hash));
    }
}

#[cfg(test)]
mod tests;
