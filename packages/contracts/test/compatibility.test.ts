import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCompatibilitySurface,
  findBreakingContractChanges,
  PROTOCOL_ERROR_V1_SCHEMA,
  SERVER_EVENT_ENVELOPE_V1_SCHEMA,
  type ContractCompatibilityIssueKind,
  type JsonObject,
  type JsonValue,
} from "../src/index.js";

interface ContractSet extends JsonObject {
  readonly openapi: JsonValue;
  readonly protocolError: JsonValue;
  readonly serverEvent: JsonValue;
}

interface BreakingCase {
  readonly name: string;
  readonly contract: "openapi" | "protocolError" | "serverEvent";
  readonly operation: "remove" | "replace";
  readonly path: readonly string[];
  readonly value?: JsonValue;
  readonly expectedKind: ContractCompatibilityIssueKind;
}

async function readJson(url: URL): Promise<JsonValue> {
  return JSON.parse(await readFile(url, "utf8")) as JsonValue;
}

function asContractSet(value: JsonValue): ContractSet {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as ContractSet;
}

function applyBreakingCase(
  source: JsonValue,
  breakingCase: BreakingCase,
): JsonValue {
  const changed = structuredClone(source);
  let parent = changed;
  for (const segment of breakingCase.path.slice(0, -1)) {
    assert.equal(
      typeof parent === "object" && parent !== null && !Array.isArray(parent),
      true,
    );
    parent = (parent as Record<string, JsonValue>)[segment] as JsonValue;
  }

  assert.equal(
    typeof parent === "object" && parent !== null && !Array.isArray(parent),
    true,
  );
  const property = breakingCase.path.at(-1);
  assert.notEqual(property, undefined);
  const record = parent as Record<string, JsonValue>;
  if (breakingCase.operation === "remove") {
    Reflect.deleteProperty(record, property as string);
  } else {
    record[property as string] = breakingCase.value as JsonValue;
  }
  return changed;
}

const baselineUrl = new URL(
  "../../compatibility/baselines/contracts.v1.json",
  import.meta.url,
);
const currentOpenApiUrl = new URL(
  "../compatibility/openapi.current.json",
  import.meta.url,
);
const breakingCasesUrl = new URL(
  "../../test/fixtures/breaking-compatibility-v1.json",
  import.meta.url,
);

test("current OpenAPI and realtime contracts preserve the baseline", async () => {
  const baseline = asContractSet(await readJson(baselineUrl));
  const current: ContractSet = {
    openapi: createCompatibilitySurface(await readJson(currentOpenApiUrl)),
    protocolError: createCompatibilitySurface(PROTOCOL_ERROR_V1_SCHEMA),
    serverEvent: createCompatibilitySurface(SERVER_EVENT_ENVELOPE_V1_SCHEMA),
  };

  for (const contract of ["openapi", "protocolError", "serverEvent"] as const) {
    assert.deepEqual(
      findBreakingContractChanges(baseline[contract], current[contract]),
      [],
    );
  }
});

test("deliberately breaking removals and narrowing fail compatibility", async () => {
  const baseline = asContractSet(await readJson(baselineUrl));
  const fixture = asContractSet(await readJson(breakingCasesUrl));
  const cases = (fixture as ContractSet & { readonly cases?: JsonValue })
    .cases as unknown as readonly BreakingCase[];

  for (const breakingCase of cases) {
    const candidate = applyBreakingCase(
      baseline[breakingCase.contract],
      breakingCase,
    );
    const issues = findBreakingContractChanges(
      baseline[breakingCase.contract],
      candidate,
    );

    assert.equal(
      issues.some((issue) => issue.kind === breakingCase.expectedKind),
      true,
      breakingCase.name,
    );
  }
});

test("new paths, responses, components, and optional properties stay additive", () => {
  const additiveContainers = [
    ["paths", "/v1/example"],
    ["responses", "201"],
    ["schemas", "Example"],
    ["properties", "optionalField"],
  ] as const;

  for (const [container, key] of additiveContainers) {
    const baseline = { [container]: {} };
    const candidate = { [container]: { [key]: { type: "string" } } };
    assert.deepEqual(findBreakingContractChanges(baseline, candidate), []);
  }

  assert.deepEqual(
    findBreakingContractChanges(
      { tags: [{ name: "Health" }] },
      { tags: [{ name: "Health" }, { name: "Matches" }] },
    ),
    [],
  );
});
