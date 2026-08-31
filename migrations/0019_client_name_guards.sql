-- Existing credentials and audit labels stay untouched. Only verified enrollment
-- may reconcile a singleton alias before rotating its token in the same batch.
CREATE TRIGGER caller_tokens_canonical_insert
BEFORE INSERT ON caller_tokens
BEGIN
  SELECT RAISE(ABORT, 'client_name_noncanonical')
  WHERE NEW.client_name <> trim(NEW.client_name)
    OR (length(NEW.client_name) > 6 AND lower(substr(NEW.client_name, -6)) = '.local');
  SELECT RAISE(ABORT, 'client_name_ambiguous')
  WHERE EXISTS (
    SELECT 1 FROM caller_tokens
    WHERE caller_id = NEW.caller_id
      AND client_name <> NEW.client_name
      AND substr(client_name, 1, length(NEW.client_name)) = NEW.client_name
      AND replace(lower(substr(client_name, length(NEW.client_name) + 1)), '.local', '') = ''
  );
END;

CREATE TRIGGER caller_tokens_canonical_update
BEFORE UPDATE OF caller_id, client_name ON caller_tokens
BEGIN
  SELECT RAISE(ABORT, 'client_name_noncanonical')
  WHERE NEW.client_name <> trim(NEW.client_name)
    OR (length(NEW.client_name) > 6 AND lower(substr(NEW.client_name, -6)) = '.local');
  SELECT RAISE(ABORT, 'client_name_ambiguous')
  WHERE EXISTS (
    SELECT 1 FROM caller_tokens
    WHERE caller_id = NEW.caller_id AND id <> OLD.id
      AND substr(client_name, 1, length(NEW.client_name)) = NEW.client_name
      AND replace(lower(substr(client_name, length(NEW.client_name) + 1)), '.local', '') = ''
  );
END;
