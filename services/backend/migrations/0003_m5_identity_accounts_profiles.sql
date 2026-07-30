ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deletion_pending', 'deleted')),
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT users_deletion_state_is_consistent CHECK (
    (status = 'active' AND deletion_requested_at IS NULL AND deleted_at IS NULL)
    OR
    (
      status = 'deletion_pending'
      AND deletion_requested_at IS NOT NULL
      AND deleted_at IS NULL
    )
    OR
    (
      status = 'deleted'
      AND deletion_requested_at IS NOT NULL
      AND deleted_at IS NOT NULL
    )
  );

CREATE TABLE user_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('development', 'apple')),
  provider_subject text NOT NULL CHECK (
    length(provider_subject) BETWEEN 1 AND 255
  ),
  created_at timestamptz NOT NULL,
  last_authenticated_at timestamptz NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE INDEX user_identities_user_idx
  ON user_identities (user_id, provider);

CREATE TABLE provider_credentials (
  credential_hash text PRIMARY KEY CHECK (
    credential_hash ~ '^[0-9a-f]{64}$'
  ),
  identity_id uuid NOT NULL REFERENCES user_identities (id) ON DELETE CASCADE,
  consumed_at timestamptz NOT NULL
);

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 3 AND 24),
  avatar_key text NOT NULL DEFAULT 'avatar.default' CHECK (
    length(avatar_key) BETWEEN 1 AND 64
  ),
  progression_level integer NOT NULL DEFAULT 1 CHECK (progression_level > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'test')),
  app_version text CHECK (
    app_version IS NULL OR length(app_version) BETWEEN 1 AND 64
  ),
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  UNIQUE (user_id, installation_id)
);

CREATE INDEX devices_installation_idx
  ON devices (installation_id, user_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices (id) ON DELETE SET NULL,
  access_token_hash text NOT NULL UNIQUE CHECK (
    access_token_hash ~ '^[0-9a-f]{64}$'
  ),
  access_expires_at timestamptz NOT NULL,
  refresh_token_hash text NOT NULL UNIQUE CHECK (
    refresh_token_hash ~ '^[0-9a-f]{64}$'
  ),
  refresh_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  reuse_detected_at timestamptz,
  CHECK (access_expires_at > created_at),
  CHECK (refresh_expires_at > access_expires_at),
  CHECK (reuse_detected_at IS NULL OR revoked_at IS NOT NULL)
);

CREATE INDEX sessions_user_active_idx
  ON sessions (user_id, refresh_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE session_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  rotated_at timestamptz NOT NULL
);

CREATE TABLE account_deletion_requests (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  status text NOT NULL CHECK (
    status IN ('pending', 'processing', 'completed')
  ),
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (
    (status IN ('pending', 'processing') AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
  )
);
