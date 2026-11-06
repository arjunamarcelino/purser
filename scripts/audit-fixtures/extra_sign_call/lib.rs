// Minimal clean fixture: satisfies every rule in audit-security.sh.
#[near]
impl Purser {
    /// doc comment between attrs and fn
    #[private]
    #[allow(
        clippy::too_many_arguments
    )]
    pub fn on_signed(&mut self, id: u64) {}

    pub fn create_task(&mut self, t: u64) {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner, "only owner");
    }

    pub fn set_thing(&mut self) {
        self.assert_owner();
    }

    pub fn propose_payment(&mut self, t: u64) {
        self.assert_delegate_authorized(&t);
        self.open_reservation(t);
        Promise::new(x).transfer(y);
    }

    pub fn view(&self) -> u64 { 0 }
}

impl Purser {
    fn propose_evm(&mut self, t: u64) {
        self.open_reservation(t);
        self.sign_promise("p", &d);
    }
    fn sneaky(&self) {
        self.sign_promise("p", &d);
    }
    fn request_cancel(&mut self) {
        self.sign_promise("p", &d);
    }
    fn sign_promise(&self, path: &str, d: &[u8; 32]) -> Promise {
        // "sign" in a comment is ignored
        Promise::new(s).function_call("sign".to_string(), a, d, g)
    }
}
