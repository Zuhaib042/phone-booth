CREATE FUNCTION reject_ruleset_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ruleset snapshots are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER rulesets_are_immutable
BEFORE UPDATE OR DELETE ON rulesets
FOR EACH ROW EXECUTE FUNCTION reject_ruleset_mutation();
