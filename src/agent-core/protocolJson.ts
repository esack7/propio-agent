import type { JsonValue } from "../policy/index.js";

/** Detach JSON data without invoking getters or toJSON. Bound recursion on input. */
export function copyJson(
  value: unknown,
  replace: boolean,
): { value: JsonValue; replacedValues: number } {
  const ancestors = new Set<object>();
  let replacedValues = 0;
  const invalid = (label: string): string => {
    if (!replace) throw new TypeError(`Not JSON: ${label}`);
    replacedValues++;
    return `[${label}]`;
  };
  const visit = (
    input: unknown,
    depth: number,
    keepUndefined = false,
  ): JsonValue => {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return input;
    if (typeof input === "number")
      return Number.isFinite(input) ? input : invalid("non-finite number");
    if (typeof input !== "object") return invalid(typeof input);
    return visitObject(input, depth, keepUndefined);
  };
  const visitObject = (
    input: object,
    depth: number,
    keepUndefined: boolean,
  ): JsonValue => {
    if (depth > 100) return invalid("maximum depth");
    if (ancestors.has(input)) return invalid("circular reference");
    if (!Array.isArray(input) && !isPlainObject(input))
      return invalid("non-plain object");
    ancestors.add(input);
    try {
      if (Array.isArray(input))
        return Array.from({ length: input.length }, (_, i) =>
          readProperty(
            Object.getOwnPropertyDescriptor(input, String(i)),
            depth,
            keepUndefined,
          ),
        );
      return Object.fromEntries(
        Object.entries(Object.getOwnPropertyDescriptors(input))
          .filter(
            ([, descriptor]) =>
              descriptor.enumerable &&
              (!replace ||
                keepUndefined ||
                !("value" in descriptor) ||
                descriptor.value !== undefined),
          )
          .map(([key, descriptor]) => [
            key,
            readProperty(
              descriptor,
              depth,
              keepUndefined || key === "args" || key === "value",
            ),
          ]),
      );
    } finally {
      ancestors.delete(input);
    }
  };
  const readProperty = (
    descriptor: PropertyDescriptor | undefined,
    depth: number,
    keepUndefined: boolean,
  ): JsonValue => {
    if (!descriptor) return invalid("undefined");
    return "value" in descriptor
      ? visit(descriptor.value, depth + 1, keepUndefined)
      : invalid("accessor");
  };
  return { value: visit(value, 0), replacedValues };
}

export function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    (Object.getPrototypeOf(prototype) === null &&
      prototype.constructor?.name === "Object")
  );
}
