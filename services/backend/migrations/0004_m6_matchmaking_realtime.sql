CREATE TABLE matchmaking_safety (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  matchmaking_allowed boolean NOT NULL DEFAULT true,
  restriction_pool text NOT NULL DEFAULT 'standard'
    CHECK (restriction_pool ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE blocks (
  blocker_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX blocks_blocked_user_idx
  ON blocks (blocked_user_id, blocker_user_id);

CREATE TABLE matchmaking_proposals (
  id uuid PRIMARY KEY,
  ruleset_id uuid NOT NULL,
  ruleset_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'matched', 'expired')),
  ready_deadline timestamptz NOT NULL,
  match_id uuid UNIQUE REFERENCES matches (id),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  FOREIGN KEY (ruleset_id, ruleset_version)
    REFERENCES rulesets (id, version),
  CHECK (
    (status = 'pending' AND match_id IS NULL AND resolved_at IS NULL)
    OR
    (status = 'matched' AND match_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR
    (status = 'expired' AND match_id IS NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX matchmaking_proposals_deadline_idx
  ON matchmaking_proposals (ready_deadline, id)
  WHERE status = 'pending';

CREATE TABLE matchmaking_tickets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ruleset_id uuid NOT NULL,
  ruleset_version integer NOT NULL,
  region text NOT NULL CHECK (region ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(?:-[A-Z]{2})?$'),
  compatibility_version integer NOT NULL CHECK (compatibility_version > 0),
  restriction_pool text NOT NULL
    CHECK (restriction_pool ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  queue_key text NOT NULL CHECK (length(queue_key) BETWEEN 1 AND 256),
  status text NOT NULL CHECK (
    status IN ('queued', 'proposed', 'matched', 'cancelled')
  ),
  proposal_id uuid REFERENCES matchmaking_proposals (id),
  ready_at timestamptz,
  match_id uuid REFERENCES matches (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  FOREIGN KEY (ruleset_id, ruleset_version)
    REFERENCES rulesets (id, version),
  CHECK (
    (status = 'queued' AND proposal_id IS NULL AND ready_at IS NULL
      AND match_id IS NULL AND cancelled_at IS NULL)
    OR
    (status = 'proposed' AND proposal_id IS NOT NULL AND match_id IS NULL
      AND cancelled_at IS NULL)
    OR
    (status = 'matched' AND proposal_id IS NOT NULL AND match_id IS NOT NULL
      AND ready_at IS NOT NULL AND cancelled_at IS NULL)
    OR
    (status = 'cancelled' AND proposal_id IS NULL AND ready_at IS NULL
      AND match_id IS NULL AND cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX matchmaking_tickets_one_active_per_user_idx
  ON matchmaking_tickets (user_id)
  WHERE status IN ('queued', 'proposed');

CREATE INDEX matchmaking_tickets_queue_idx
  ON matchmaking_tickets (queue_key, created_at, id)
  WHERE status = 'queued';

CREATE INDEX matchmaking_tickets_proposal_idx
  ON matchmaking_tickets (proposal_id, id)
  WHERE proposal_id IS NOT NULL;

CREATE TABLE recent_pairings (
  first_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  second_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_matched_at timestamptz NOT NULL,
  match_count integer NOT NULL DEFAULT 1 CHECK (match_count > 0),
  PRIMARY KEY (first_user_id, second_user_id),
  CHECK (first_user_id::text < second_user_id::text)
);

CREATE TABLE recipient_streams (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  last_cursor bigint NOT NULL DEFAULT 0 CHECK (last_cursor >= 0)
);

CREATE TABLE recipient_events (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_cursor bigint NOT NULL CHECK (recipient_cursor > 0),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(event_type) > 0),
  occurred_at timestamptz NOT NULL,
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  match_version bigint NOT NULL CHECK (match_version > 0),
  audience text NOT NULL CHECK (
    audience IN ('player', 'participants', 'active')
  ),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (user_id, recipient_cursor),
  UNIQUE (user_id, event_id)
);

CREATE INDEX recipient_events_match_idx
  ON recipient_events (user_id, match_id, recipient_cursor);
