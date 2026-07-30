ALTER TABLE matchmaking_safety
  ADD COLUMN chat_allowed boolean NOT NULL DEFAULT true;

CREATE TABLE chat_threads (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  first_user_id uuid NOT NULL,
  second_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (id, match_id),
  UNIQUE (match_id, first_user_id, second_user_id),
  FOREIGN KEY (match_id, first_user_id)
    REFERENCES match_players (match_id, player_id) ON DELETE CASCADE,
  FOREIGN KEY (match_id, second_user_id)
    REFERENCES match_players (match_id, player_id) ON DELETE CASCADE,
  CHECK (first_user_id::text < second_user_id::text)
);

CREATE INDEX chat_threads_first_user_idx
  ON chat_threads (first_user_id, match_id);

CREATE INDEX chat_threads_second_user_idx
  ON chat_threads (second_user_id, match_id);

INSERT INTO chat_threads (
  id,
  match_id,
  first_user_id,
  second_user_id,
  created_at
)
SELECT
  (
    substr(pair.digest, 1, 8)
    || '-'
    || substr(pair.digest, 9, 4)
    || '-'
    || '4'
    || substr(pair.digest, 14, 3)
    || '-'
    || 'a'
    || substr(pair.digest, 18, 3)
    || '-'
    || substr(pair.digest, 21, 12)
  )::uuid,
  first.match_id,
  least(first.player_id::text, second.player_id::text)::uuid,
  greatest(first.player_id::text, second.player_id::text)::uuid,
  matches.created_at
FROM match_players AS first
JOIN match_players AS second
  ON second.match_id = first.match_id
  AND second.roster_position > first.roster_position
JOIN matches ON matches.id = first.match_id
CROSS JOIN LATERAL (
  SELECT md5(
    first.match_id::text
    || least(first.player_id::text, second.player_id::text)
    || greatest(first.player_id::text, second.player_id::text)
  ) AS digest
) AS pair
ON CONFLICT (match_id, first_user_id, second_user_id) DO NOTHING;

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL,
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('typed', 'quick_phrase')),
  quick_phrase_key text,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2048),
  normalized_body text NOT NULL CHECK (length(normalized_body) BETWEEN 1 AND 2048),
  delivery_status text NOT NULL CHECK (
    delivery_status IN (
      'delivered',
      'blocked',
      'urgent_review',
      'provider_unavailable',
      'rate_limited',
      'recipient_unavailable'
    )
  ),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL,
  delivered_at timestamptz,
  UNIQUE (id, match_id),
  FOREIGN KEY (thread_id, match_id)
    REFERENCES chat_threads (id, match_id) ON DELETE CASCADE,
  FOREIGN KEY (match_id, sender_user_id)
    REFERENCES match_players (match_id, player_id),
  FOREIGN KEY (match_id, recipient_user_id)
    REFERENCES match_players (match_id, player_id),
  CHECK (sender_user_id <> recipient_user_id),
  CHECK (
    (kind = 'typed' AND quick_phrase_key IS NULL)
    OR (
      kind = 'quick_phrase'
      AND quick_phrase_key IS NOT NULL
      AND quick_phrase_key ~ '^[a-z][a-z0-9_]{0,63}$'
    )
  ),
  CHECK (
    (delivery_status = 'delivered' AND delivered_at IS NOT NULL)
    OR (delivery_status <> 'delivered' AND delivered_at IS NULL)
  )
);

CREATE INDEX messages_thread_created_idx
  ON messages (thread_id, created_at, id);

CREATE INDEX messages_sender_recent_idx
  ON messages (sender_user_id, created_at DESC);

CREATE TABLE message_filter_results (
  message_id uuid PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  normalization_version text NOT NULL,
  deterministic_action text NOT NULL CHECK (
    deterministic_action IN ('allow', 'block')
  ),
  deterministic_reasons text[] NOT NULL DEFAULT '{}',
  provider_name text NOT NULL,
  provider_outcome text NOT NULL CHECK (
    provider_outcome IN (
      'not_called',
      'allow',
      'block',
      'urgent_review',
      'timeout',
      'failure'
    )
  ),
  provider_categories jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(provider_categories) = 'object'
  ),
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE mutes (
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  muter_user_id uuid NOT NULL,
  muted_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (match_id, muter_user_id, muted_user_id),
  FOREIGN KEY (match_id, muter_user_id)
    REFERENCES match_players (match_id, player_id),
  FOREIGN KEY (match_id, muted_user_id)
    REFERENCES match_players (match_id, player_id),
  CHECK (muter_user_id <> muted_user_id)
);

CREATE TABLE reports (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('message', 'user')),
  reporter_user_id uuid NOT NULL REFERENCES users (id),
  subject_user_id uuid NOT NULL REFERENCES users (id),
  match_id uuid NOT NULL REFERENCES matches (id),
  message_id uuid,
  category text NOT NULL CHECK (
    category IN (
      'harassment',
      'hate',
      'sexual',
      'self_harm',
      'spam',
      'threat',
      'other'
    )
  ),
  severity text NOT NULL CHECK (severity IN ('standard', 'urgent')),
  evidence_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_snapshot) = 'object'
  ),
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'reviewing', 'resolved')
  ),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (message_id, match_id)
    REFERENCES messages (id, match_id),
  CHECK (reporter_user_id <> subject_user_id),
  CHECK (
    (kind = 'message' AND message_id IS NOT NULL)
    OR (kind = 'user' AND message_id IS NULL)
  )
);

CREATE INDEX reports_queue_idx
  ON reports (
    (CASE severity WHEN 'urgent' THEN 0 ELSE 1 END),
    created_at,
    id
  )
  WHERE status = 'queued';

CREATE TABLE moderation_reviews (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
  priority text NOT NULL CHECK (priority IN ('urgent', 'standard')),
  reason_codes text[] NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'reviewing', 'resolved')
  ),
  created_at timestamptz NOT NULL
);

CREATE INDEX moderation_reviews_queue_idx
  ON moderation_reviews (
    (CASE priority WHEN 'urgent' THEN 0 ELSE 1 END),
    created_at,
    id
  )
  WHERE status = 'queued';
