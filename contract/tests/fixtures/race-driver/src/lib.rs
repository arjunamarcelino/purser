//! Race driver — a TEST-ONLY fan-out contract for the Purser attack suite.
//!
//! `fire` turns a list of calls into function-call promises joined with `and`. NEAR delivers the
//! outgoing receipts of one receipt together in the next block, in creation order, so every
//! forwarded `propose_payment` reaches Purser in the same block, before any settlement callback.
//! That is what makes the concurrency and in-flight-retry cases deterministic. Deploying the
//! driver on several delegate accounts and firing them from one coordinator yields a same-block
//! race across distinct delegates.
//!
//! Callers are restricted to the hosting account and the coordinator fixed at init: the driver
//! acts AS its host, so an open `fire` would let anyone propose payments as that delegate.

use near_sdk::json_types::Base64VecU8;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

/// One forwarded function call.
#[near(serializers = [json])]
pub struct Call {
    pub receiver: AccountId,
    pub method: String,
    pub args: Base64VecU8,
    pub gas: Gas,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RaceDriver {
    coordinator: AccountId,
}

#[near]
impl RaceDriver {
    #[init]
    pub fn new(coordinator: AccountId) -> Self {
        Self { coordinator }
    }

    /// Schedule every call as one joined batch. Returns nothing: a joint promise cannot be a
    /// return value, and the test reads each leaf's outcome from the transaction's receipts.
    pub fn fire(&mut self, calls: Vec<Call>) {
        let caller = env::predecessor_account_id();
        require!(
            caller == env::current_account_id() || caller == self.coordinator,
            "only the host or the coordinator may fire"
        );
        let batch = calls
            .into_iter()
            .map(|c| {
                Promise::new(c.receiver).function_call(c.method, c.args.0, NearToken::ZERO, c.gas)
            })
            .reduce(Promise::and);
        require!(batch.is_some(), "no calls");
    }
}
