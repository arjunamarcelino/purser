-- Derived cache of the Purser contract. Never authoritative: nothing here may authorize or release funds.

CREATE TABLE task (
  task_id             text PRIMARY KEY,
  owner               text NOT NULL,
  token               text NOT NULL,
  cap                 numeric(39,0) NOT NULL CHECK (cap >= 0),
  completed_cached    numeric(39,0) NOT NULL DEFAULT 0 CHECK (completed_cached >= 0),
  outstanding_cached  numeric(39,0) NOT NULL DEFAULT 0 CHECK (outstanding_cached >= 0),
  crew_cap            integer NOT NULL CHECK (crew_cap >= 0),
  frozen              boolean NOT NULL,
  missing_since_height bigint CHECK (missing_since_height IS NULL OR missing_since_height >= 0),
  as_of_height        bigint NOT NULL CHECK (as_of_height >= 0),
  synced_at           timestamptz NOT NULL DEFAULT now()
);

-- One row per commitment_id: a state mirror (latest state wins), not an event log.
CREATE TABLE commitment_event (
  commitment_id   bigint PRIMARY KEY,
  task_id         text NOT NULL REFERENCES task(task_id) DEFERRABLE INITIALLY DEFERRED,
  delegate        text NOT NULL,
  recipient       text NOT NULL,
  reserved_amount numeric(39,0) NOT NULL CHECK (reserved_amount >= 0),
  actual_spent    numeric(39,0) CHECK (actual_spent >= 0),
  state           text NOT NULL CHECK (state IN ('Reserved','Signed','Confirmed','Unknown','Failed','Cancelled')),
  request_id      text NOT NULL,
  payload_hash    text,
  near_tx         text,
  evm_tx          text,
  tx_status       text NOT NULL DEFAULT 'pending' CHECK (tx_status IN ('resolved','pending','unavailable')),
  as_of_height    bigint NOT NULL CHECK (as_of_height >= 0),
  observed_at     timestamptz NOT NULL DEFAULT now(),
  -- on-chain key is (delegate, request_id) per task; a global UNIQUE(request_id) would wedge the poll
  UNIQUE (task_id, delegate, request_id),
  CHECK ((tx_status = 'resolved') = (near_tx IS NOT NULL))
);
CREATE INDEX commitment_event_task_id_idx ON commitment_event (task_id, commitment_id DESC);

CREATE TABLE delegate_snapshot (
  task_id      text NOT NULL REFERENCES task(task_id) DEFERRABLE INITIALLY DEFERRED,
  account_id   text NOT NULL,
  active       boolean NOT NULL,
  as_of_height bigint NOT NULL CHECK (as_of_height >= 0),
  observed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, account_id)
);

-- Created per spec, never written or read by this package.
-- token_digest is a hash, never a token; there is deliberately no raw-token column.
CREATE TABLE attestation (
  id            bigserial PRIMARY KEY,
  commitment_id bigint REFERENCES commitment_event(commitment_id) DEFERRABLE INITIALLY DEFERRED,
  provider      text NOT NULL,
  token_digest  text NOT NULL CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  verified      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Created per spec (EVM relayer, later prompt), never written or read by this package.
CREATE TABLE relayer_job (
  id            bigserial PRIMARY KEY,
  commitment_id bigint NOT NULL REFERENCES commitment_event(commitment_id) DEFERRABLE INITIALLY DEFERRED,
  chain         text NOT NULL,
  signed_tx     text NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','broadcast','confirmed','stuck','cancel_sent','cancelled','failed')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
