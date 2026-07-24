import assert from "node:assert/strict";
import test from "node:test";

import {
  drawRandomIndex,
  parseEntityId,
  parseUtcTimestamp,
  utcTimestampFromDate,
  type Clock,
  type RandomSource,
  type UserId,
} from "../src/index.js";

test("entity identifiers validate RFC 9562 UUIDs and normalize case", () => {
  const result = parseEntityId("user", "550E8400-E29B-41D4-A716-446655440000");

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  const userId: UserId = result.value;
  assert.equal(userId, "550e8400-e29b-41d4-a716-446655440000");

  assert.deepEqual(parseEntityId("match", "not-a-uuid"), {
    ok: false,
    error: {
      code: "invalid_identifier",
      message: "match identifier must be an RFC 9562 UUID",
      details: { entity: "match", expected: "rfc9562_uuid" },
    },
  });
});

test("UTC timestamps use one canonical millisecond-precision format", () => {
  const canonical = "2026-07-23T10:15:30.123Z";

  assert.deepEqual(parseUtcTimestamp(canonical), {
    ok: true,
    value: canonical,
  });
  assert.equal(parseUtcTimestamp("2026-07-23T15:15:30.123+05:00").ok, false);
  assert.equal(parseUtcTimestamp("2026-02-30T10:15:30.123Z").ok, false);
  assert.equal(parseUtcTimestamp("2026-07-23T10:15:30Z").ok, false);
  assert.deepEqual(utcTimestampFromDate(new Date("2026-07-23T10:15:30.123Z")), {
    ok: true,
    value: canonical,
  });
  assert.equal(utcTimestampFromDate(new Date(Number.NaN)).ok, false);
  assert.equal(utcTimestampFromDate(new Date(253_402_300_800_000)).ok, false);
});

test("an injected clock returns deterministic time", () => {
  const timestamp = parseUtcTimestamp("2026-07-23T10:15:30.123Z");
  assert.equal(timestamp.ok, true);
  if (!timestamp.ok) {
    return;
  }

  const clock: Clock = {
    now: () => timestamp.value,
  };

  assert.equal(clock.now(), timestamp.value);
  assert.equal(clock.now(), timestamp.value);
});

test("an injected random source produces deterministic bounded indexes", () => {
  const samples = [0, 0.499, 0.999_999];
  let nextSample = 0;
  const source: RandomSource = {
    nextUnitInterval(): number {
      const sample = samples[nextSample];
      nextSample += 1;
      if (sample === undefined) {
        throw new Error("test random source ran out of samples");
      }
      return sample;
    },
  };

  assert.deepEqual(drawRandomIndex(source, 4), { ok: true, value: 0 });
  assert.deepEqual(drawRandomIndex(source, 4), { ok: true, value: 1 });
  assert.deepEqual(drawRandomIndex(source, 4), { ok: true, value: 3 });
});

test("random bounds and samples fail as structured domain errors", () => {
  const unusedSource: RandomSource = {
    nextUnitInterval(): number {
      throw new Error("source must not be called for an invalid bound");
    },
  };

  assert.deepEqual(drawRandomIndex(unusedSource, 0), {
    ok: false,
    error: {
      code: "invalid_random_bound",
      message: "Random upper bound must be a positive safe integer",
      details: { upperExclusive: 0 },
    },
  });
  assert.deepEqual(drawRandomIndex({ nextUnitInterval: () => 1 }, 2), {
    ok: false,
    error: {
      code: "invalid_random_sample",
      message: "Random sample must be in the interval [0, 1)",
      details: { sample: 1 },
    },
  });
});
