export interface Success<Value> {
  readonly ok: true;
  readonly value: Value;
}

export interface Failure<ErrorValue> {
  readonly ok: false;
  readonly error: ErrorValue;
}

export type Result<Value, ErrorValue> = Success<Value> | Failure<ErrorValue>;

export function ok<Value>(value: Value): Success<Value> {
  return { ok: true, value };
}

export function err<ErrorValue>(error: ErrorValue): Failure<ErrorValue> {
  return { ok: false, error };
}
