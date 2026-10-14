/** The SDK snapshot bridge cannot instantiate the upstream suite's test-only Drop classes. */
export function hasDropConstructor(value: unknown): boolean {
  if (typeof value === "string") return /^instantiate:[A-Za-z]\w*(?:\s|:|$)/.test(value);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => key.startsWith("instantiate:") || hasDropConstructor(child),
  );
}
