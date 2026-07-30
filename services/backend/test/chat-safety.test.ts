import assert from "node:assert/strict";
import test from "node:test";

import { filterTypedMessage, normalizeChatText } from "../src/chat/filter.js";
import {
  classifyWithTimeout,
  decideModerationPolicy,
  DeterministicModerationProvider,
  ModerationProviderFailure,
} from "../src/chat/moderation.js";

test("M7 deterministic chat filters resist common Unicode and contact bypasses", () => {
  const fixtures = [
    {
      input: "visit example [dot] com",
      reason: "link",
    },
    {
      input: "name (at) example dot com",
      reason: "contact_details",
    },
    {
      input: "call +1 (415) 555-0199",
      reason: "contact_details",
    },
    {
      input: "k\u200by\u200bs",
      reason: "prohibited_self_harm",
    },
    {
      input: "b.1.t.c.h",
      reason: "prohibited_harassment",
    },
    {
      input: "I will kіll you",
      reason: "prohibited_threat",
    },
  ] as const;

  for (const fixture of fixtures) {
    const result = filterTypedMessage(fixture.input);
    assert.equal(result.action, "block", fixture.input);
    assert.equal(result.reasons.includes(fixture.reason), true, fixture.input);
  }
  assert.equal(filterTypedMessage("Let us compare notes.").action, "allow");
  assert.equal(filterTypedMessage("A spicy skyscraper.").action, "allow");
  assert.equal(
    filterTypedMessage("🙂".repeat(240)).action,
    "allow",
    "length is counted as Unicode code points",
  );
  assert.equal(
    filterTypedMessage("🙂".repeat(241)).reasons.includes("too_long"),
    true,
  );
  assert.equal(normalizeChatText("  hello\u200b   there  "), "hello there");
});

test("M7 moderation policy covers allow, block, urgent, failure, and timeout", async () => {
  const allowed = await new DeterministicModerationProvider("allow").classify(
    "hello",
  );
  assert.deepEqual(decideModerationPolicy(allowed), {
    action: "allow",
    reasonCodes: [],
  });

  const blocked = await new DeterministicModerationProvider("block").classify(
    "fixture",
  );
  assert.equal(decideModerationPolicy(blocked).action, "block");

  const urgent = await new DeterministicModerationProvider(
    "urgent_review",
  ).classify("fixture");
  assert.equal(decideModerationPolicy(urgent).action, "urgent_review");

  await assert.rejects(
    new DeterministicModerationProvider("failure").classify("fixture"),
    (error: unknown) =>
      error instanceof ModerationProviderFailure && error.kind === "failure",
  );
  await assert.rejects(
    classifyWithTimeout(
      new DeterministicModerationProvider("timeout"),
      "fixture",
      10,
    ),
    (error: unknown) =>
      error instanceof ModerationProviderFailure && error.kind === "timeout",
  );
});
