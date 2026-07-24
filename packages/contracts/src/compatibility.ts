import type { JsonObject, JsonValue } from "./realtime.js";

export type ContractCompatibilityIssueKind = "removed" | "narrowed" | "changed";

export interface ContractCompatibilityIssue {
  readonly kind: ContractCompatibilityIssueKind;
  readonly path: string;
  readonly message: string;
}

const ANNOTATION_KEYS = new Set([
  "$comment",
  "description",
  "example",
  "examples",
  "externalDocs",
  "summary",
  "title",
]);

const UNORDERED_ARRAY_KEYS = new Set([
  "allOf",
  "anyOf",
  "enum",
  "oneOf",
  "required",
  "security",
  "tags",
]);

const ADDITIVE_ARRAY_KEYS = new Set(["security", "tags"]);

const ADDITIVE_CONTAINERS = new Set([
  "$defs",
  "components",
  "content",
  "headers",
  "parameters",
  "paths",
  "properties",
  "responses",
  "schemas",
  "securitySchemes",
  "webhooks",
]);

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

const MINIMUM_KEYWORDS = new Set([
  "exclusiveMinimum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
]);

const MAXIMUM_KEYWORDS = new Set([
  "exclusiveMaximum",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
]);

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequired(value: JsonObject): boolean {
  return (
    (value as JsonObject & { readonly required?: JsonValue }).required === true
  );
}

function stableJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function pointer(path: readonly string[]): string {
  if (path.length === 0) {
    return "/";
  }

  return `/${path
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

export function createCompatibilitySurface(
  value: JsonValue,
  path: readonly string[] = [],
): JsonValue {
  if (Array.isArray(value)) {
    const items = value.map((item) => createCompatibilitySurface(item, path));
    return UNORDERED_ARRAY_KEYS.has(path.at(-1) ?? "")
      ? items.toSorted((left, right) =>
          stableJson(left).localeCompare(stableJson(right)),
        )
      : items;
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const projected: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).toSorted()) {
    if ((path.length === 0 && key === "info") || ANNOTATION_KEYS.has(key)) {
      continue;
    }

    const child = value[key];
    if (child !== undefined) {
      projected[key] = createCompatibilitySurface(child, [...path, key]);
    }
  }

  return projected;
}

function isAllowedAddition(
  path: readonly string[],
  key: string,
  value: JsonValue,
): boolean {
  const container = path.at(-1);
  if (container !== undefined && ADDITIVE_CONTAINERS.has(container)) {
    return true;
  }
  if (path.length === 2 && path[0] === "paths" && HTTP_METHODS.has(key)) {
    return true;
  }
  if (key === "parameters" && Array.isArray(value)) {
    return value.every(
      (parameter) => !isJsonObject(parameter) || !isRequired(parameter),
    );
  }
  if (key === "requestBody" && isJsonObject(value)) {
    return !isRequired(value);
  }

  return false;
}

function changedKind(
  path: readonly string[],
  baseline: JsonValue,
  candidate: JsonValue,
): ContractCompatibilityIssueKind {
  const keyword = path.at(-1) ?? "";
  if (
    typeof baseline === "number" &&
    typeof candidate === "number" &&
    ((MINIMUM_KEYWORDS.has(keyword) && candidate > baseline) ||
      (MAXIMUM_KEYWORDS.has(keyword) && candidate < baseline))
  ) {
    return "narrowed";
  }
  if (
    keyword === "enum" &&
    Array.isArray(baseline) &&
    Array.isArray(candidate)
  ) {
    const candidateValues = new Set(candidate.map(stableJson));
    if (baseline.some((item) => !candidateValues.has(stableJson(item)))) {
      return "narrowed";
    }
  }
  if (
    keyword === "required" &&
    Array.isArray(baseline) &&
    Array.isArray(candidate) &&
    candidate.length > baseline.length
  ) {
    return "narrowed";
  }

  return "changed";
}

function compare(
  baseline: JsonValue,
  candidate: JsonValue,
  path: readonly string[],
  issues: ContractCompatibilityIssue[],
): void {
  if (Array.isArray(baseline) || Array.isArray(candidate)) {
    const keyword = path.at(-1) ?? "";
    if (Array.isArray(baseline) && Array.isArray(candidate)) {
      const candidateItems = new Set(candidate.map(stableJson));
      if (
        ADDITIVE_ARRAY_KEYS.has(keyword) &&
        baseline.every((item) => candidateItems.has(stableJson(item)))
      ) {
        return;
      }
    }
    if (
      !Array.isArray(baseline) ||
      !Array.isArray(candidate) ||
      stableJson(baseline) !== stableJson(candidate)
    ) {
      const kind = changedKind(path, baseline, candidate);
      issues.push({
        kind,
        path: pointer(path),
        message: `Contract ${kind} at ${pointer(path)}`,
      });
    }
    return;
  }

  if (isJsonObject(baseline) && isJsonObject(candidate)) {
    for (const [key, baselineValue] of Object.entries(baseline)) {
      const candidateValue = candidate[key];
      if (candidateValue === undefined) {
        issues.push({
          kind: "removed",
          path: pointer([...path, key]),
          message: `Contract member removed at ${pointer([...path, key])}`,
        });
      } else {
        compare(baselineValue, candidateValue, [...path, key], issues);
      }
    }

    for (const [key, candidateValue] of Object.entries(candidate)) {
      if (
        baseline[key] === undefined &&
        !isAllowedAddition(path, key, candidateValue)
      ) {
        issues.push({
          kind: "narrowed",
          path: pointer([...path, key]),
          message: `New constraint requires a versioned contract at ${pointer([
            ...path,
            key,
          ])}`,
        });
      }
    }
    return;
  }

  if (baseline !== candidate) {
    const kind = changedKind(path, baseline, candidate);
    issues.push({
      kind,
      path: pointer(path),
      message: `Contract ${kind} at ${pointer(path)}`,
    });
  }
}

export function findBreakingContractChanges(
  baseline: JsonValue,
  candidate: JsonValue,
): readonly ContractCompatibilityIssue[] {
  const issues: ContractCompatibilityIssue[] = [];
  compare(
    createCompatibilitySurface(baseline),
    createCompatibilitySurface(candidate),
    [],
    issues,
  );
  return issues;
}
