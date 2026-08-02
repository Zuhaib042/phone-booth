CREATE TABLE coin_accounts (
  id uuid PRIMARY KEY,
  owner_user_id uuid UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
  account_kind text NOT NULL CHECK (account_kind IN ('player', 'system')),
  system_key text UNIQUE,
  spendable_balance bigint NOT NULL DEFAULT 0,
  reserved_balance bigint NOT NULL DEFAULT 0,
  pending_balance bigint NOT NULL DEFAULT 0,
  restricted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (account_kind = 'player' AND owner_user_id IS NOT NULL AND system_key IS NULL)
    OR
    (account_kind = 'system' AND owner_user_id IS NULL AND system_key IS NOT NULL)
  ),
  CHECK (
    account_kind = 'system'
    OR (
      spendable_balance >= 0
      AND reserved_balance >= 0
      AND pending_balance >= 0
    )
  )
);

INSERT INTO coin_accounts (
  id,
  account_kind,
  system_key,
  created_at,
  updated_at
)
VALUES
  (
    '01980000-0000-7000-8000-000000000001',
    'system',
    'issuance',
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '01980000-0000-7000-8000-000000000002',
    'system',
    'cosmetic_sink',
    clock_timestamp(),
    clock_timestamp()
  );

CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY,
  transaction_kind text NOT NULL CHECK (
    transaction_kind IN (
      'grant',
      'cosmetic_sink',
      'bucket_reserve',
      'bucket_release',
      'bribe_accept',
      'bribe_settle',
      'bribe_reverse'
    )
  ),
  source_operation text NOT NULL CHECK (length(source_operation) BETWEEN 1 AND 64),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 512),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object'
  ),
  created_at timestamptz NOT NULL,
  UNIQUE (source_operation, source_key)
);

CREATE TABLE ledger_entries (
  transaction_id uuid NOT NULL REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
  sequence smallint NOT NULL CHECK (sequence >= 0),
  coin_account_id uuid NOT NULL REFERENCES coin_accounts (id) ON DELETE RESTRICT,
  bucket text NOT NULL CHECK (bucket IN ('spendable', 'reserved', 'pending')),
  amount bigint NOT NULL CHECK (amount <> 0),
  PRIMARY KEY (transaction_id, sequence)
);

CREATE INDEX ledger_entries_account_idx
  ON ledger_entries (coin_account_id, transaction_id, sequence);

CREATE FUNCTION reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger history is immutable' USING ERRCODE = '23000';
END;
$$;

CREATE TRIGGER ledger_transactions_are_immutable
BEFORE UPDATE OR DELETE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER ledger_entries_are_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE FUNCTION verify_ledger_transaction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_count bigint;
  transaction_total numeric;
BEGIN
  SELECT count(*), COALESCE(sum(amount), 0)
  INTO entry_count, transaction_total
  FROM ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  IF entry_count < 2 OR transaction_total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced', NEW.transaction_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transactions_must_balance
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_ledger_transaction();

CREATE FUNCTION verify_coin_account_cached_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_spendable numeric;
  expected_reserved numeric;
  expected_pending numeric;
  actual coin_accounts%ROWTYPE;
BEGIN
  SELECT * INTO actual FROM coin_accounts WHERE id = NEW.coin_account_id;
  SELECT
    COALESCE(sum(amount) FILTER (WHERE bucket = 'spendable'), 0),
    COALESCE(sum(amount) FILTER (WHERE bucket = 'reserved'), 0),
    COALESCE(sum(amount) FILTER (WHERE bucket = 'pending'), 0)
  INTO expected_spendable, expected_reserved, expected_pending
  FROM ledger_entries
  WHERE coin_account_id = NEW.coin_account_id;

  IF
    actual.spendable_balance <> expected_spendable
    OR actual.reserved_balance <> expected_reserved
    OR actual.pending_balance <> expected_pending
  THEN
    RAISE EXCEPTION 'coin account % cached balance diverged from ledger', NEW.coin_account_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER coin_account_balances_follow_ledger
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_coin_account_cached_balance();

CREATE FUNCTION verify_updated_coin_account_cached_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_spendable numeric;
  expected_reserved numeric;
  expected_pending numeric;
  actual coin_accounts%ROWTYPE;
BEGIN
  SELECT * INTO actual FROM coin_accounts WHERE id = NEW.id;
  SELECT
    COALESCE(sum(amount) FILTER (WHERE bucket = 'spendable'), 0),
    COALESCE(sum(amount) FILTER (WHERE bucket = 'reserved'), 0),
    COALESCE(sum(amount) FILTER (WHERE bucket = 'pending'), 0)
  INTO expected_spendable, expected_reserved, expected_pending
  FROM ledger_entries
  WHERE coin_account_id = NEW.id;

  IF
    actual.spendable_balance <> expected_spendable
    OR actual.reserved_balance <> expected_reserved
    OR actual.pending_balance <> expected_pending
  THEN
    RAISE EXCEPTION 'coin account % cached balance diverged from ledger', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER coin_account_updates_follow_ledger
AFTER UPDATE OF spendable_balance, reserved_balance, pending_balance ON coin_accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_updated_coin_account_cached_balance();

CREATE TABLE coin_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  grant_key text NOT NULL CHECK (grant_key ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  amount bigint NOT NULL CHECK (amount > 0),
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions (id),
  granted_at timestamptz NOT NULL,
  UNIQUE (user_id, grant_key, source_key)
);

CREATE TABLE cosmetic_purchases (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  cosmetic_key text NOT NULL CHECK (
    cosmetic_key ~ '^[a-z][a-z0-9_.-]{0,63}$'
  ),
  amount bigint NOT NULL CHECK (amount > 0),
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions (id),
  purchased_at timestamptz NOT NULL,
  UNIQUE (user_id, cosmetic_key)
);

CREATE TABLE inventory_items (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  cosmetic_key text NOT NULL,
  purchase_id uuid NOT NULL UNIQUE REFERENCES cosmetic_purchases (id),
  acquired_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, cosmetic_key)
);

CREATE TABLE match_coin_allowances (
  match_id uuid NOT NULL,
  player_id uuid NOT NULL,
  outflow_cap bigint NOT NULL CHECK (outflow_cap > 0),
  accepted_outflow bigint NOT NULL DEFAULT 0 CHECK (
    accepted_outflow >= 0 AND accepted_outflow <= outflow_cap
  ),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (match_id, player_id),
  FOREIGN KEY (match_id, player_id)
    REFERENCES match_players (match_id, player_id) ON DELETE CASCADE
);

CREATE TABLE bribe_offers (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE RESTRICT,
  round_number integer NOT NULL CHECK (round_number > 0),
  sender_user_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  requested_target_user_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  filtered_message text CHECK (length(filtered_message) BETWEEN 1 AND 240),
  state text NOT NULL CHECK (
    state IN ('pending', 'declined', 'expired', 'accepted', 'reversed', 'settled')
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  resolved_at timestamptz,
  accepted_ledger_transaction_id uuid UNIQUE REFERENCES ledger_transactions (id),
  resolved_ledger_transaction_id uuid UNIQUE REFERENCES ledger_transactions (id),
  FOREIGN KEY (match_id, sender_user_id)
    REFERENCES match_players (match_id, player_id) ON DELETE RESTRICT,
  FOREIGN KEY (match_id, recipient_user_id)
    REFERENCES match_players (match_id, player_id) ON DELETE RESTRICT,
  FOREIGN KEY (match_id, requested_target_user_id)
    REFERENCES match_players (match_id, player_id) ON DELETE RESTRICT,
  CHECK (sender_user_id <> recipient_user_id),
  CHECK (
    (state = 'pending' AND resolved_at IS NULL
      AND accepted_ledger_transaction_id IS NULL
      AND resolved_ledger_transaction_id IS NULL)
    OR
    (state IN ('declined', 'expired') AND resolved_at IS NOT NULL
      AND accepted_ledger_transaction_id IS NULL
      AND resolved_ledger_transaction_id IS NULL)
    OR
    (state = 'accepted' AND resolved_at IS NULL
      AND accepted_ledger_transaction_id IS NOT NULL
      AND resolved_ledger_transaction_id IS NULL)
    OR
    (state IN ('reversed', 'settled') AND resolved_at IS NOT NULL
      AND accepted_ledger_transaction_id IS NOT NULL
      AND resolved_ledger_transaction_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX bribe_offers_one_pending_pair_idx
  ON bribe_offers (
    match_id,
    round_number,
    sender_user_id,
    recipient_user_id
  )
  WHERE state = 'pending';

CREATE INDEX bribe_offers_recipient_resolution_idx
  ON bribe_offers (match_id, round_number, recipient_user_id, id)
  WHERE state = 'accepted';

CREATE INDEX bribe_offers_dossier_idx
  ON bribe_offers (match_id, round_number, created_at, id);
