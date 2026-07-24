import { domainError, type DomainError } from "./error.js";
import { err, ok, type Result } from "./result.js";

declare const utcTimestampBrand: unique symbol;

export type UtcTimestamp = string & {
  readonly [utcTimestampBrand]: "UtcTimestamp";
};

export type InvalidUtcTimestampError = DomainError<
  "invalid_utc_timestamp",
  {
    readonly expected: "yyyy-mm-ddThh:mm:ss.sssZ";
  }
>;

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalidUtcTimestamp(): InvalidUtcTimestampError {
  return domainError(
    "invalid_utc_timestamp",
    "Timestamp must be a valid UTC instant with millisecond precision",
    { expected: "yyyy-mm-ddThh:mm:ss.sssZ" },
  );
}

export function parseUtcTimestamp(
  value: string,
): Result<UtcTimestamp, InvalidUtcTimestampError> {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) {
    return err(invalidUtcTimestamp());
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return err(invalidUtcTimestamp());
  }

  return ok(value as UtcTimestamp);
}

export function utcTimestampFromDate(
  value: Date,
): Result<UtcTimestamp, InvalidUtcTimestampError> {
  if (!Number.isFinite(value.getTime())) {
    return err(invalidUtcTimestamp());
  }

  return parseUtcTimestamp(value.toISOString());
}
