export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Value is not JSON serializable");
  }

  return JSON.parse(serialized) as JsonValue;
}

export function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json === null || Array.isArray(json) || typeof json !== "object") {
    throw new TypeError("Value must serialize to a JSON object");
  }
  return json as JsonObject;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}
