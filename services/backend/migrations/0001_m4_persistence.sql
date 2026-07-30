CREATE TABLE users (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE rulesets (
  id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id, version)
);

CREATE TABLE matches (
  id uuid PRIMARY KEY,
  ruleset_id uuid NOT NULL,
  ruleset_version integer NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  phase text NOT NULL CHECK (
    phase IN (
      'lobby',
      'negotiation',
      'voting',
      'tally',
      'runoff_negotiation',
      'runoff_voting',
      'elimination',
      'final_plea',
      'jury_voting',
      'complete',
      'cancelled'
    )
  ),
  phase_deadline timestamptz,
  state_snapshot jsonb NOT NULL CHECK (jsonb_typeof(state_snapshot) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT matches_ruleset_fk
    FOREIGN KEY (ruleset_id, ruleset_version)
    REFERENCES rulesets (id, version),
  CONSTRAINT terminal_matches_have_no_deadline CHECK (
    phase NOT IN ('complete', 'cancelled') OR phase_deadline IS NULL
  )
);

CREATE INDEX matches_active_deadline_idx
  ON matches (phase_deadline, id)
  WHERE phase NOT IN ('complete', 'cancelled');

CREATE TABLE match_players (
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES users (id),
  roster_position smallint NOT NULL CHECK (roster_position >= 0),
  status text NOT NULL CHECK (status IN ('active', 'eliminated')),
  ready boolean NOT NULL DEFAULT false,
  PRIMARY KEY (match_id, player_id),
  UNIQUE (match_id, roster_position)
);

CREATE INDEX match_players_player_idx ON match_players (player_id, match_id);

CREATE TABLE rounds (
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  round_number integer NOT NULL CHECK (round_number > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (match_id, round_number)
);

CREATE TABLE match_events (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  match_version bigint NOT NULL CHECK (match_version > 0),
  sequence integer NOT NULL CHECK (sequence >= 0),
  event_type text NOT NULL CHECK (length(event_type) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  UNIQUE (match_id, match_version, sequence)
);

CREATE INDEX match_events_stream_idx
  ON match_events (match_id, match_version, sequence);

CREATE TABLE idempotency_keys (
  account_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (length(operation) > 0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_headers jsonb CHECK (
    response_headers IS NULL OR jsonb_typeof(response_headers) = 'object'
  ),
  response_body jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (account_id, operation, idempotency_key),
  CONSTRAINT idempotency_completion_is_atomic CHECK (
    (completed_at IS NULL AND response_status IS NULL AND response_headers IS NULL AND response_body IS NULL)
    OR
    (completed_at IS NOT NULL AND response_status IS NOT NULL AND response_headers IS NOT NULL AND response_body IS NOT NULL)
  )
);

CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (length(aggregate_type) > 0),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(event_type) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token uuid,
  claimed_by text,
  claim_until timestamptz,
  published_at timestamptz,
  last_error text,
  CONSTRAINT outbox_claim_is_complete CHECK (
    (claim_token IS NULL AND claimed_by IS NULL AND claim_until IS NULL)
    OR
    (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND claim_until IS NOT NULL)
  )
);

CREATE INDEX outbox_claim_idx
  ON outbox_events (available_at, occurred_at, id)
  WHERE published_at IS NULL;

CREATE TABLE scheduled_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (length(kind) > 0),
  deduplication_key text NOT NULL UNIQUE CHECK (length(deduplication_key) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 25 CHECK (max_attempts > 0),
  claim_token uuid,
  claimed_by text,
  claim_until timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT scheduled_job_claim_is_complete CHECK (
    (claim_token IS NULL AND claimed_by IS NULL AND claim_until IS NULL)
    OR
    (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND claim_until IS NOT NULL)
  )
);

CREATE INDEX scheduled_jobs_claim_idx
  ON scheduled_jobs (run_at, id)
  WHERE status IN ('pending', 'processing');
