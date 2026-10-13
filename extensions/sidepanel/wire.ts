export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | readonly JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

export type WireValue =
  | object
  | string
  | number
  | boolean
  | null
  | undefined;

export function decodeWireValue(
  value: WireValue,
): JsonValue | undefined {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const decoded: JsonValue[] = [];
    for (const item of value) {
      const next = decodeWireValue(item as WireValue);
      if (next === undefined) return undefined;
      decoded.push(next);
    }
    return decoded;
  }
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object String]") return String(value);
  if (tag === "[object Number]") {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (tag === "[object Boolean]") return Boolean(value);
  if (tag !== "[object Object]") return undefined;
  const decoded: JsonObject = {};
  for (const [key, item] of Object.entries(
    value as { [key: string]: WireValue },
  )) {
    const next = decodeWireValue(item);
    if (next === undefined) return undefined;
    decoded[key] = next;
  }
  return decoded;
}

export function jsonObject(
  value: JsonValue | undefined,
): JsonObject | undefined {
  if (
    value === null ||
    value === undefined ||
    Array.isArray(value) ||
    Object.prototype.toString.call(value) !==
      "[object Object]"
  )
    return undefined;
  return value as JsonObject;
}

export function jsonString(
  value: JsonValue | undefined,
): string | undefined {
  return Object.prototype.toString.call(value) ===
    "[object String]"
    ? String(value)
    : undefined;
}

export function jsonNumber(
  value: JsonValue | undefined,
): number | undefined {
  if (
    Object.prototype.toString.call(value) !==
    "[object Number]"
  )
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
