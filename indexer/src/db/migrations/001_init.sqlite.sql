-- Derived cache of the Purser contract. Never authoritative: nothing here may authorize or release funds.
-- Numerics are canonical decimal TEXT (no sign, no leading zeros, <= 39 digits); never compare them numerically in SQL.

CREATE TABLE task (
  task_id             TEXT PRIMARY KEY,
  owner               TEXT NOT NULL,
  token               TEXT NOT NULL,
  cap                 TEXT NOT NULL CHECK (cap NOT GLOB '*[^0-9]*' AND length(cap) BETWEEN 1 AND 39 AND (cap = '0' OR cap NOT GLOB '0*')),
  completed_cached    TEXT NOT NULL DEFAULT '0' CHECK (completed_cached NOT GLOB '*[^0-9]*' AND length(completed_cached) BETWEEN 1 AND 39 AND (completed_cached = '0' OR completed_cached NOT GLOB '0*')),
  outstanding_cached  TEXT NOT NULL DEFAULT '0' CHECK (outstanding_cached NOT GLOB '*[^0-9]*' AND length(outstanding_cached) BETWEEN 1 AND 39 AND (outstanding_cached = '0' OR outstanding_cached NOT GLOB '0*')),
  crew_cap            INTEGER NOT NULL CHECK (crew_cap >= 0),
  frozen              INTEGER NOT NULL CHECK (frozen IN (0, 1)),
  missing_since_height INTEGER CHECK (missing_since_height IS NULL OR missing_since_height >= 0),
  as_of_height        INTEGER NOT NULL CHECK (as_of_height >= 0),
  synced_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per commitment_id: a state mirror (latest state wins), not an event log.
CREATE TABLE commitment_event (
  commitment_id   INTEGER PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES task(task_id),
  delegate        TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  reserved_amount TEXT NOT NULL CHECK (reserved_amount NOT GLOB '*[^0-9]*' AND length(reserved_amount) BETWEEN 1 AND 39 AND (reserved_amount = '0' OR reserved_amount NOT GLOB '0*')),
  actual_spent    TEXT CHECK (actual_spent NOT GLOB '*[^0-9]*' AND length(actual_spent) BETWEEN 1 AND 39 AND (actual_spent = '0' OR actual_spent NOT GLOB '0*')),
  state           TEXT NOT NULL CHECK (state IN ('Reserved','Signed','Confirmed','Unknown','Failed','Cancelled')),
  request_id      TEXT NOT NULL,
  payload_hash    TEXT,
  near_tx         TEXT,
  evm_tx          TEXT,
  tx_status       TEXT NOT NULL DEFAULT 'pending' CHECK (tx_status IN ('resolved','pending','unavailable')),
  as_of_height    INTEGER NOT NULL CHECK (as_of_height >= 0),
  observed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- on-chain key is (delegate, request_id) per task; a global UNIQUE(request_id) would wedge the poll
  UNIQUE (task_id, delegate, request_id),
  CHECK ((tx_status = 'resolved') = (near_tx IS NOT NULL))
);
CREATE INDEX commitment_event_task_id_idx ON commitment_event (task_id, commitment_id DESC);

CREATE TABLE delegate_snapshot (
  task_id      TEXT NOT NULL REFERENCES task(task_id),
  account_id   TEXT NOT NULL,
  active       INTEGER NOT NULL CHECK (active IN (0, 1)),
  as_of_height INTEGER NOT NULL CHECK (as_of_height >= 0),
  observed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (task_id, account_id)
);

-- Created per spec, never written or read by this package.
-- token_digest is a hash, never a token; there is deliberately no raw-token column.
CREATE TABLE attestation (
  id            INTEGER PRIMARY KEY,
  commitment_id INTEGER REFERENCES commitment_event(commitment_id),
  provider      TEXT NOT NULL,
  token_digest  TEXT NOT NULL CHECK (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  verified      INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Created per spec (EVM relayer, later prompt), never written or read by this package.
CREATE TABLE relayer_job (
  id            INTEGER PRIMARY KEY,
  commitment_id INTEGER NOT NULL REFERENCES commitment_event(commitment_id),
  chain         TEXT NOT NULL,
  signed_tx     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','broadcast','confirmed','stuck','cancel_sent','cancelled','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
