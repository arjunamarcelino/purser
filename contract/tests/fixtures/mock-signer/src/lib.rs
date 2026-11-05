//! Mock MPC signer: a TEST-ONLY stand-in for `v1.signer-prod.testnet` (near/mpc 3.18.0).
//!
//! It exposes the two surfaces Purser uses: `sign` (really ECDSA-signs the 32-byte payload with the
//! derived key, in the real response shape) and the `derived_public_key` / `public_key` views, using
//! the real tweak formula. The root key is a PUBLIC, FAKE constant: this contract protects nothing and
//! must never be deployed outside a near-workspaces sandbox. See README.md.
//!
//! Differences from the real signer, on purpose: `sign` answers synchronously (the real one is a
//! yield/resume that can also time out into an `Err` callback; `Mode::Err` stands in for that), and
//! there is no MPC, domain table or attached-deposit accounting beyond the minimum checks.

use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar, U256};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault};
use sha3::{Digest, Sha3_256};

/// Domain separator of the real signer's key derivation.
const TWEAK_PREFIX: &str = "near-mpc-recovery v0.1.0 epsilon derivation:";
/// Live `sign_call_gas_attachment_requirement_tera_gas` of the real signer.
const MIN_SIGN_GAS: Gas = Gas::from_tgas(15);

/// FAKE root scalar (32 x 0x42). Public by design.
const ROOT_SK_BYTES: [u8; 32] = [0x42; 32];
/// FAKE alternate scalar used by `Mode::WrongKey`.
const OTHER_SK_BYTES: [u8; 32] = [0x43; 32];

/// How `sign` behaves. Set with `set_mode`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Correct signature with the derived key.
    Ok,
    /// `sign` panics (the callback sees `Err`).
    Err,
    /// Valid-looking signature made with a different key: ecrecover yields the wrong public key.
    WrongKey,
    /// Right lengths but `recovery_id` = 2 (the real shape allows 0..=3; Purser must accept only 0/1).
    Garbled,
    /// Malformed lengths: `s.scalar` is 62 hex chars and `big_r` is truncated.
    GarbledShort,
}

#[near(serializers = [json])]
pub enum Payload {
    Ecdsa(String),
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
pub struct AffinePointJson {
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct ScalarJson {
    pub scalar: String,
}

/// Exactly the real signer's `Secp256k1` signature response.
#[near(serializers = [json])]
pub struct SignResponse {
    pub scheme: String,
    pub big_r: AffinePointJson,
    pub s: ScalarJson,
    pub recovery_id: u8,
}

/// `root_pk + tweak(predecessor, path) * G`, as 64 uncompressed bytes (no 0x04 prefix).
pub fn derive_public_key(root_pk: &[u8; 64], predecessor: &str, path: &str) -> [u8; 64] {
    let mut sec1 = [4u8; 65];
    sec1[1..].copy_from_slice(root_pk);
    let ep = EncodedPoint::from_bytes(sec1).expect("root pk encoding");
    let root: AffinePoint =
        Option::from(AffinePoint::from_encoded_point(&ep)).expect("root pk is not on the curve");
    let derived =
        ProjectivePoint::from(root) + ProjectivePoint::GENERATOR * tweak(predecessor, path);
    let enc = derived.to_affine().to_encoded_point(false);
    let mut out = [0u8; 64];
    out.copy_from_slice(&enc.as_bytes()[1..]);
    out
}

/// `SHA3-256(prefix + predecessor + "," + path)` reduced mod n.
pub fn tweak(predecessor: &str, path: &str) -> Scalar {
    let mut h = Sha3_256::new();
    h.update(TWEAK_PREFIX.as_bytes());
    h.update(predecessor.as_bytes());
    h.update(b",");
    h.update(path.as_bytes());
    let digest: [u8; 32] = h.finalize().into();
    <Scalar as Reduce<U256>>::reduce_bytes(&FieldBytes::from(digest))
}

fn scalar_of(bytes: &[u8; 32]) -> Scalar {
    Option::from(Scalar::from_repr(FieldBytes::from(*bytes))).expect("fake scalar is in range")
}

/// Secret that signs for `(predecessor, path)`: `root + tweak`.
fn derived_signing_key(root: &[u8; 32], predecessor: &str, path: &str) -> SigningKey {
    let sk = scalar_of(root) + tweak(predecessor, path);
    SigningKey::from_bytes(&sk.to_bytes()).expect("derived scalar is non-zero")
}

/// Uncompressed 64-byte public key of the fake root.
pub fn root_public_key() -> [u8; 64] {
    let sk = SigningKey::from_bytes(&scalar_of(&ROOT_SK_BYTES).to_bytes()).expect("root");
    let enc = sk.verifying_key().to_encoded_point(false);
    let mut out = [0u8; 64];
    out.copy_from_slice(&enc.as_bytes()[1..]);
    out
}

fn near_pk(raw64: &[u8; 64]) -> String {
    format!("secp256k1:{}", near_sdk::bs58::encode(raw64).into_string())
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hex_decode32(s: &str) -> [u8; 32] {
    require!(s.len() == 64, "payload_v2.Ecdsa must be 64 hex chars");
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16)
            .unwrap_or_else(|_| env::panic_str("payload_v2.Ecdsa is not hex"));
    }
    out
}

/// Sign `payload` (prehash) with `key`, low-s normalized, returning `(r, s, recovery_id)`.
pub fn sign_prehash(key: &SigningKey, payload: &[u8; 32]) -> ([u8; 32], [u8; 32], u8) {
    let (sig, rid): (Signature, RecoveryId) = key.sign_prehash_recoverable(payload).expect("sign");
    let (sig, rid) = match sig.normalize_s() {
        Some(low) => (low, RecoveryId::new(!rid.is_y_odd(), rid.is_x_reduced())),
        None => (sig, rid),
    };
    let (r, s) = sig.split_bytes();
    (r.into(), s.into(), rid.to_byte())
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    owner: AccountId,
    mode: Mode,
}

#[near]
impl MockSigner {
    /// The deployer (predecessor) becomes the owner; starts in `Mode::Ok`.
    #[init]
    pub fn new() -> Self {
        Self {
            owner: env::predecessor_account_id(),
            mode: Mode::Ok,
        }
    }

    /// Owner-only: choose how the next `sign` calls behave.
    pub fn set_mode(&mut self, mode: Mode) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.mode = mode;
    }

    pub fn get_mode(&self) -> Mode {
        self.mode
    }

    /// Same requirements the real signer's live config imposes: >= 1 yocto and >= 15 Tgas prepaid.
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> SignResponse {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "attach at least 1 yoctoNEAR"
        );
        require!(
            env::prepaid_gas() >= MIN_SIGN_GAS,
            "attach at least 15 Tgas"
        );
        require!(
            request.domain_id == 0,
            "only domain_id 0 (Secp256k1) is supported"
        );
        let Payload::Ecdsa(hex) = &request.payload_v2;
        let payload = hex_decode32(hex);
        require!(
            Option::<Scalar>::from(Scalar::from_repr(FieldBytes::from(payload))).is_some(),
            "payload is not a valid secp256k1 scalar"
        );
        if self.mode == Mode::Err {
            env::panic_str("mock-signer: Err mode");
        }
        let predecessor = env::predecessor_account_id();
        let root = if self.mode == Mode::WrongKey {
            &OTHER_SK_BYTES
        } else {
            &ROOT_SK_BYTES
        };
        let key = derived_signing_key(root, predecessor.as_str(), &request.path);
        let (r, s, mut rid) = sign_prehash(&key, &payload);
        let prefix = if rid & 1 == 0 { "02" } else { "03" };
        let mut big_r = format!("{prefix}{}", hex_encode(&r));
        let mut s_hex = hex_encode(&s);
        match self.mode {
            Mode::Garbled => rid = 2,
            Mode::GarbledShort => {
                s_hex.truncate(62);
                big_r.truncate(60);
            }
            _ => {}
        }
        SignResponse {
            scheme: "Secp256k1".into(),
            big_r: AffinePointJson {
                affine_point: big_r,
            },
            s: ScalarJson { scalar: s_hex },
            recovery_id: rid,
        }
    }

    pub fn public_key(&self, domain_id: Option<u64>) -> String {
        require!(
            domain_id.unwrap_or(0) == 0,
            "only domain_id 0 (Secp256k1) is supported"
        );
        near_pk(&root_public_key())
    }

    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String {
        require!(
            domain_id.unwrap_or(0) == 0,
            "only domain_id 0 (Secp256k1) is supported"
        );
        let predecessor = predecessor.unwrap_or_else(env::predecessor_account_id);
        near_pk(&derive_public_key(
            &root_public_key(),
            predecessor.as_str(),
            &path,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::VerifyingKey;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// Real v1.signer-prod.testnet root key, read via `public_key({"domain_id":0})` (docs/EVM-PROBES.md).
    /// PUBLIC data: it lets us test the derivation function against the live signer without any secret.
    const REAL_ROOT: &str = "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";
    /// The signer's own `derived_public_key` answer for ("x", purser.arjuna-purser.testnet, domain 0).
    const REAL_DERIVED: &str = "secp256k1:67756ZjiVxANYvYhQagGaWj2APpo1C1UMq2ebVWoy3GMU3zmYaM9ho6DNyDxRjo1Uzo2UDMkmeutgZFKQhgpnd1W";
    const PURSER: &str = "purser.arjuna-purser.testnet";

    fn decode_pk(s: &str) -> [u8; 64] {
        let raw = near_sdk::bs58::decode(s.strip_prefix("secp256k1:").unwrap())
            .into_vec()
            .unwrap();
        raw.try_into().unwrap()
    }

    fn ctx(pred: &str, deposit: u128, gas: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(pred.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(gas))
            .build());
    }

    fn req(path: &str, payload: [u8; 32]) -> SignRequest {
        SignRequest {
            path: path.into(),
            payload_v2: Payload::Ecdsa(hex_encode(&payload)),
            domain_id: 0,
        }
    }

    fn payload() -> [u8; 32] {
        let mut p = [0u8; 32];
        for (i, b) in p.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7).wrapping_add(1);
        }
        p
    }

    fn recover(resp: &SignResponse, payload: &[u8; 32]) -> Option<[u8; 64]> {
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&hex_decode32(&resp.big_r.affine_point[2..]));
        rs[32..].copy_from_slice(&hex_decode32(&resp.s.scalar));
        let sig = Signature::from_slice(&rs).ok()?;
        let rid = RecoveryId::from_byte(resp.recovery_id)?;
        let vk = VerifyingKey::recover_from_prehash(payload, &sig, rid).ok()?;
        let mut out = [0u8; 64];
        out.copy_from_slice(&vk.to_encoded_point(false).as_bytes()[1..]);
        Some(out)
    }

    #[test]
    fn derivation_matches_the_real_signer_vector() {
        let got = derive_public_key(&decode_pk(REAL_ROOT), PURSER, "x");
        assert_eq!(near_pk(&got), REAL_DERIVED);
    }

    #[test]
    fn evm_address_of_the_real_vector() {
        use sha3::Keccak256;
        let h = Keccak256::digest(decode_pk(REAL_DERIVED));
        assert_eq!(
            hex_encode(&h[12..]),
            "0f3798297b9500b6c63ecc6c8101a7d6fae81e02"
        );
    }

    #[test]
    fn sign_verifies_against_the_derived_view_key() {
        ctx(PURSER, 1, 300);
        let mut c = MockSigner::new();
        let p = payload();
        let resp = c.sign(req("m/0", p));
        assert_eq!(resp.scheme, "Secp256k1");
        assert!(resp.recovery_id <= 1);
        assert!(
            resp.big_r.affine_point.starts_with("02") || resp.big_r.affine_point.starts_with("03")
        );
        assert_eq!(
            (resp.big_r.affine_point.len(), resp.s.scalar.len()),
            (66, 64)
        );
        let want =
            decode_pk(&c.derived_public_key("m/0".into(), Some(PURSER.parse().unwrap()), Some(0)));
        assert_eq!(recover(&resp, &p), Some(want));
        // big_r parity prefix agrees with the recovery id
        assert_eq!(
            &resp.big_r.affine_point[..2],
            if resp.recovery_id == 0 { "02" } else { "03" }
        );
        // the near-sdk host ecrecover (what Purser uses on-chain) agrees as well
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&hex_decode32(&resp.big_r.affine_point[2..]));
        rs[32..].copy_from_slice(&hex_decode32(&resp.s.scalar));
        assert_eq!(env::ecrecover(&p, &rs, resp.recovery_id, true), Some(want));
    }

    #[test]
    fn s_is_always_low() {
        ctx(PURSER, 1, 300);
        let mut c = MockSigner::new();
        for i in 0..40u8 {
            let mut p = payload();
            p[0] = i;
            let resp = c.sign(req("lows", p));
            let s = hex_decode32(&resp.s.scalar);
            let sig = Signature::from_scalars(
                FieldBytes::from(hex_decode32(&resp.big_r.affine_point[2..])),
                FieldBytes::from(s),
            )
            .unwrap();
            assert!(
                sig.normalize_s().is_none(),
                "s must already be low for payload {i}"
            );
        }
    }

    #[test]
    fn derived_key_depends_on_predecessor_and_path() {
        ctx(PURSER, 1, 300);
        let c = MockSigner::new();
        let a = c.derived_public_key("a".into(), Some(PURSER.parse().unwrap()), Some(0));
        let b = c.derived_public_key("b".into(), Some(PURSER.parse().unwrap()), Some(0));
        let o = c.derived_public_key("a".into(), Some("other.testnet".parse().unwrap()), Some(0));
        assert!(a != b && a != o && b != o);
    }

    #[test]
    fn sign_uses_the_predecessor_in_the_tweak() {
        ctx("caller-a.testnet", 1, 300);
        let mut c = MockSigner::new();
        let p = payload();
        let resp = c.sign(req("x", p));
        let want = decode_pk(&c.derived_public_key(
            "x".into(),
            Some("caller-a.testnet".parse().unwrap()),
            None,
        ));
        assert_eq!(recover(&resp, &p), Some(want));
    }

    #[test]
    fn wrong_key_mode_recovers_a_different_key() {
        ctx(PURSER, 1, 300);
        let mut c = MockSigner::new();
        c.set_mode(Mode::WrongKey);
        let p = payload();
        let resp = c.sign(req("x", p));
        let want =
            decode_pk(&c.derived_public_key("x".into(), Some(PURSER.parse().unwrap()), None));
        let got = recover(&resp, &p).expect("still a well-formed signature");
        assert_ne!(got, want);
    }

    #[test]
    fn garbled_modes() {
        ctx(PURSER, 1, 300);
        let mut c = MockSigner::new();
        c.set_mode(Mode::Garbled);
        assert_eq!(c.sign(req("x", payload())).recovery_id, 2);
        c.set_mode(Mode::GarbledShort);
        let r = c.sign(req("x", payload()));
        assert!(r.s.scalar.len() < 64 && r.big_r.affine_point.len() < 66);
    }

    #[test]
    #[should_panic(expected = "Err mode")]
    fn err_mode_panics() {
        ctx(PURSER, 1, 300);
        let mut c = MockSigner::new();
        c.set_mode(Mode::Err);
        c.sign(req("x", payload()));
    }

    #[test]
    #[should_panic(expected = "at least 1 yoctoNEAR")]
    fn needs_a_deposit() {
        ctx(PURSER, 0, 300);
        MockSigner::new().sign(req("x", payload()));
    }

    #[test]
    #[should_panic(expected = "15 Tgas")]
    fn needs_gas() {
        ctx(PURSER, 1, 14);
        MockSigner::new().sign(req("x", payload()));
    }

    #[test]
    #[should_panic(expected = "not a valid secp256k1 scalar")]
    fn rejects_payload_at_or_above_n() {
        ctx(PURSER, 1, 300);
        MockSigner::new().sign(req("x", [0xff; 32]));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_owner_sets_mode() {
        ctx(PURSER, 1, 300);
        let mut c = MockSigner::new();
        ctx("attacker.testnet", 0, 300);
        c.set_mode(Mode::Err);
    }

    #[test]
    fn request_json_shape_is_the_real_one() {
        let r: SignRequest = near_sdk::serde_json::from_str(
            r#"{"path":"p","payload_v2":{"Ecdsa":"0000000000000000000000000000000000000000000000000000000000000001"},"domain_id":0}"#,
        )
        .unwrap();
        assert_eq!(r.path, "p");
        let out = near_sdk::serde_json::to_value(SignResponse {
            scheme: "Secp256k1".into(),
            big_r: AffinePointJson {
                affine_point: "02".into(),
            },
            s: ScalarJson {
                scalar: "00".into(),
            },
            recovery_id: 1,
        })
        .unwrap();
        assert_eq!(out["big_r"]["affine_point"], "02");
        assert_eq!(out["s"]["scalar"], "00");
        assert_eq!(out["recovery_id"], 1);
    }
}
