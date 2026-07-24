import { domainError, type DomainError } from "./error.js";
import { err, ok, type Result } from "./result.js";

export interface RandomSource {
  nextUnitInterval(): number;
}

export type InvalidRandomBoundError = DomainError<
  "invalid_random_bound",
  {
    readonly upperExclusive: number;
  }
>;

export type InvalidRandomSampleError = DomainError<
  "invalid_random_sample",
  {
    readonly sample: number;
  }
>;

export function drawRandomIndex(
  source: RandomSource,
  upperExclusive: number,
): Result<number, InvalidRandomBoundError | InvalidRandomSampleError> {
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive <= 0) {
    return err(
      domainError(
        "invalid_random_bound",
        "Random upper bound must be a positive safe integer",
        { upperExclusive },
      ),
    );
  }

  const sample = source.nextUnitInterval();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    return err(
      domainError(
        "invalid_random_sample",
        "Random sample must be in the interval [0, 1)",
        { sample },
      ),
    );
  }

  return ok(Math.floor(sample * upperExclusive));
}
