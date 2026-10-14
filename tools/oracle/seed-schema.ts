import { z } from "zod";
import type { SeedRequestTemplate, SeedValue } from "./seed-requests.js";

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null | undefined;
}
const typeRef: z.ZodType<TypeRef> = z.lazy(() =>
  z.object({
    kind: z.string(),
    name: z.string().nullable(),
    ofType: typeRef.nullable().optional(),
  }),
);
const field = z.object({
  name: z.string(),
  type: typeRef,
  defaultValue: z.string().nullable().optional(),
});
export const seedAdminSchema = z.object({
  apiVersion: z.literal("2026-10"),
  types: z
    .array(
      z.object({
        kind: z.string(),
        name: z.string(),
        inputFields: z.array(field).nullable(),
        enumValues: z.array(z.object({ name: z.string() })).nullable(),
      }),
    )
    .max(512),
  operations: z.array(z.object({ name: z.string(), args: z.array(field) })).max(100),
});

/** Validates compiled templates against retained API input contracts without executing a request. */
export function validateSeedRequestTemplate(
  template: SeedRequestTemplate,
  input: unknown,
  allowBindings = true,
): string[] {
  const schema = seedAdminSchema.parse(input),
    issues = new Set<string>(),
    types = new Map(schema.types.map((t) => [t.name, t]));
  if (types.size !== schema.types.length) throw new Error("Duplicate schema type");
  const operation = schema.operations.find((o) => o.name === template.operation);
  if (!operation) return ["unknown-operation"];
  function invalid(path: string, code: string) {
    issues.add(`${path}:${code}`);
  }
  function check(value: SeedValue | undefined, ref: TypeRef, path: string, depth: number) {
    if (depth > 64) {
      invalid(path, "input-depth-bound");
      return;
    }
    if (ref.kind === "NON_NULL") {
      if (value === undefined || value === null) invalid(path, "required-value");
      else if (ref.ofType) check(value, ref.ofType, path, depth + 1);
      else invalid(path, "invalid-schema-reference");
      return;
    }
    if (value === undefined || value === null) return;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "$seedBinding")
    ) {
      if (
        !allowBindings ||
        Object.keys(value).length !== 2 ||
        typeof value.$seedBinding !== "string" ||
        typeof value.$seedType !== "string" ||
        !(
          (ref.name === "ID" && !["URL", "STAGED_URL"].includes(value.$seedType)) ||
          (["String", "URL"].includes(ref.name ?? "") &&
            ["URL", "STAGED_URL"].includes(value.$seedType))
        )
      )
        invalid(path, "invalid-or-unresolved-binding");
      return;
    }
    if (ref.kind === "LIST") {
      if (!Array.isArray(value) || !ref.ofType) {
        invalid(path, "expected-list");
        return;
      }
      for (let i = 0; i < value.length; i++)
        check(value[i], ref.ofType, `${path}[${i}]`, depth + 1);
      return;
    }
    const type = types.get(ref.name ?? "");
    if (!type) {
      invalid(path, "missing-schema-type");
      return;
    }
    if (type.kind === "INPUT_OBJECT") {
      if (typeof value !== "object" || Array.isArray(value)) {
        invalid(path, "expected-object");
        return;
      }
      const fields = new Map((type.inputFields ?? []).map((f) => [f.name, f]));
      for (const name of Object.keys(value))
        if (!fields.has(name)) invalid(`${path}.${name}`, "unknown-field");
      for (const f of fields.values()) {
        if (
          !Object.hasOwn(value, f.name) &&
          f.defaultValue !== undefined &&
          f.defaultValue !== null
        )
          continue;
        check(value[f.name], f.type, `${path}.${f.name}`, depth + 1);
      }
    } else if (type.kind === "ENUM") {
      if (typeof value !== "string" || !type.enumValues?.some((e) => e.name === value))
        invalid(path, "invalid-enum");
    } else if (type.kind === "SCALAR") {
      let valid = false;
      switch (type.name) {
        case "Int":
          valid =
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= -2147483648 &&
            value <= 2147483647;
          break;
        case "Float":
          valid = typeof value === "number" && Number.isFinite(value);
          break;
        case "Boolean":
          valid = typeof value === "boolean";
          break;
        case "Money":
        case "Decimal":
          valid = typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value);
          break;
        case "UnsignedInt64":
          valid =
            typeof value === "string" &&
            /^\d+$/.test(value) &&
            BigInt(value) <= 18446744073709551615n;
          break;
        case "DateTime":
          valid =
            typeof value === "string" &&
            /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
            Number.isFinite(Date.parse(value));
          break;
        case "String":
        case "HTML":
        case "ID":
        case "URL":
          valid = typeof value === "string";
          break;
        default:
          invalid(path, "unverified-scalar-contract");
          return;
      }
      if (!valid) invalid(path, "invalid-scalar");
    } else invalid(path, "non-input-type");
  }
  const args = new Map(operation.args.map((a) => [a.name, a]));
  function typeName(r: TypeRef): string {
    return r.kind === "NON_NULL" && r.ofType
      ? `${typeName(r.ofType)}!`
      : r.kind === "LIST" && r.ofType
        ? `[${typeName(r.ofType)}]`
        : (r.name ?? "");
  }
  for (const name of Object.keys(template.variables)) {
    const arg = args.get(name);
    if (!arg) {
      invalid(name, "unknown-argument");
      continue;
    }
    // A stricter top-level non-null variable is valid for a nullable argument.
    const declared = template.variableTypes[name],
      actual = typeName(arg.type);
    if (declared !== actual && declared !== `${actual}!`) invalid(name, "variable-type-mismatch");
    check(
      template.variables[name],
      declared === `${actual}!` ? { kind: "NON_NULL", name: null, ofType: arg.type } : arg.type,
      name,
      0,
    );
  }
  for (const arg of args.values())
    if (
      !Object.hasOwn(template.variables, arg.name) &&
      arg.defaultValue == null &&
      arg.type.kind === "NON_NULL"
    )
      invalid(arg.name, "required-argument");
  for (const name of Object.keys(template.variableTypes))
    if (!Object.hasOwn(template.variables, name)) invalid(name, "unused-variable");
  return [...issues].sort();
}
