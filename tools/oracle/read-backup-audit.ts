import { readdir } from "node:fs/promises";
import { z } from "zod";
import { backupDigest, backupDirectory, backupFile } from "./backup-audit.js";
import type { OracleConfig } from "./store-guard.js";

export const readBackupKind = z.enum(["content", "inventory", "collection-sources"]);
export type ReadBackupKind = z.infer<typeof readBackupKind>;
const count = z.number().int().nonnegative();
const gid = z.string().regex(/^gid:\/\/shopify\/[A-Za-z]+\/[1-9]\d*$/);
const ref = z.object({ id: gid });
const kindRef = (kind: string) =>
  z.object({ id: gid.refine((id) => id.startsWith(`gid://shopify/${kind}/`)) });
const rows = z.array(ref).max(10000);
const connection = z.object({ nodes: rows, pageInfo: z.object({ hasNextPage: z.boolean() }) });
const manifestSchema = z.object({
  domain: z.string(),
  apiVersion: z.literal("2026-10"),
  readOnly: z.literal(true),
  storeDataMutations: z.literal(0),
  files: z
    .array(
      z.object({
        file: z.string(),
        bytes: count.max(32 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        resources: count.optional(),
      }),
    )
    .max(16),
});
const filesByKind = {
  content: [
    "pages",
    "blogs",
    "menus",
    "publications",
    "locations",
    "metaobjectDefinitions",
    "articles",
    "content-metafields",
    "metaobjects",
  ],
  inventory: ["properties", "inventory-items"],
  "collection-sources": ["collection-sources", "condition-type-contracts"],
} as const;
const json = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** Audits local export structure and bytes; capture completeness and restoration remain unverified. */
export async function auditReadBackup(config: OracleConfig, kind: ReadBackupKind, archive: string) {
  const root = await backupDirectory(archive),
    manifestBytes = await backupFile(root, "manifest.json");
  const raw = json(manifestBytes),
    manifest = manifestSchema.parse(raw);
  if (manifest.domain !== config.domain || manifest.apiVersion !== config.apiVersion)
    throw new Error("Backup differs from pinned store");
  const issues = new Set<string>(),
    data = new Map<string, unknown>();
  const expected = new Set<string>(filesByKind[kind].map((name) => `${name}.json`));
  const seen = new Set<string>();
  let verifiedBytes = 0,
    resources = 0,
    references = 0;
  for (const entry of manifest.files) {
    if (!expected.has(entry.file)) {
      issues.add("unexpected-archive-file");
      continue;
    }
    if (seen.has(entry.file)) {
      issues.add("duplicate-archive-file");
      continue;
    }
    seen.add(entry.file);
    try {
      const bytes = await backupFile(root, entry.file);
      if (bytes.length !== entry.bytes || backupDigest(bytes) !== entry.sha256) {
        issues.add("file-hash-or-size-mismatch");
        continue;
      }
      data.set(entry.file.slice(0, -5), json(bytes));
      verifiedBytes += bytes.length;
    } catch {
      issues.add("file-unreadable-or-invalid");
    }
  }
  if (data.size !== expected.size) issues.add("missing-archive-file");
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      (entry.name !== "manifest.json" && !expected.has(entry.name))
    )
      issues.add("unlisted-or-unsafe-archive-file");
  function unique(ids: string[], issue = "duplicate-resource") {
    if (new Set(ids).size !== ids.length) issues.add(issue);
  }
  function complete(c: z.infer<typeof connection>) {
    if (c.pageInfo.hasNextPage) issues.add("nested-pagination-incomplete");
    unique(
      c.nodes.map((n) => n.id),
      "duplicate-reference",
    );
  }
  if (data.size === expected.size && kind === "inventory") {
    const declared = z
      .object({
        inventoryItems: count,
        inventoryLevels: count,
        locations: count,
        quantityNames: z.array(z.string()),
        completePagination: z.boolean(),
      })
      .parse(raw);
    const names = z
      .object({
        quantityNames: z
          .array(z.object({ name: z.string().min(1) }))
          .min(1)
          .max(30),
      })
      .parse(data.get("properties"))
      .quantityNames.map((n) => n.name);
    unique(names, "duplicate-quantity-name");
    if (JSON.stringify([...names].sort()) !== JSON.stringify([...declared.quantityNames].sort()))
      issues.add("quantity-name-mismatch");
    const items = z
      .array(
        kindRef("InventoryItem").extend({
          variant: kindRef("ProductVariant")
            .extend({ product: kindRef("Product") })
            .nullable(),
          inventoryLevels: z
            .array(
              z.object({
                id: z
                  .string()
                  .regex(/^gid:\/\/shopify\/InventoryLevel\/[1-9]\d*\?inventory_item_id=[1-9]\d*$/),
                location: kindRef("Location"),
                quantities: z.array(z.object({ name: z.string(), quantity: z.number().int() })),
              }),
            )
            .max(10000),
        }),
      )
      .max(10000)
      .parse(data.get("inventory-items"));
    unique(items.map((i) => i.id));
    unique(
      items.flatMap((i) => (i.variant ? [i.variant.id] : [])),
      "duplicate-variant",
    );
    const levels = items.flatMap((i) => i.inventoryLevels),
      locations = new Set(levels.map((l) => l.location.id));
    unique(
      levels.map((l) => l.id),
      "duplicate-inventory-level",
    );
    for (const item of items)
      for (const level of item.inventoryLevels)
        if (new URL(level.id).searchParams.get("inventory_item_id") !== item.id.split("/").at(-1))
          issues.add("inventory-level-owner-mismatch");
    for (const item of items)
      unique(
        item.inventoryLevels.map((l) => l.location.id),
        "duplicate-inventory-location",
      );
    for (const level of levels) {
      const actual = level.quantities.map((q) => q.name);
      if (
        actual.length !== names.length ||
        new Set(actual).size !== actual.length ||
        actual.some((n) => !names.includes(n))
      )
        issues.add("incomplete-inventory-quantities");
    }
    resources = items.length;
    references = levels.length;
    if (
      resources !== declared.inventoryItems ||
      references !== declared.inventoryLevels ||
      locations.size !== declared.locations
    )
      issues.add("resource-count-mismatch");
    if (!declared.completePagination) issues.add("declared-pagination-incomplete");
  } else if (data.size === expected.size && kind === "content") {
    const declared = z
      .object({
        counts: z.record(z.string(), count),
        coverage: z.array(z.string()),
        completePagination: z.boolean(),
      })
      .parse(raw);
    const tables = new Map(filesByKind.content.map((name) => [name, rows.parse(data.get(name))]));
    const kinds: Record<string, string> = {
      pages: "Page",
      blogs: "Blog",
      articles: "Article",
      menus: "Menu",
      publications: "Publication",
      locations: "Location",
      metaobjectDefinitions: "MetaobjectDefinition",
      metaobjects: "Metaobject",
    };
    for (const [name, table] of tables) {
      unique(table.map((r) => r.id));
      if (kinds[name] && table.some((row) => !row.id.startsWith(`gid://shopify/${kinds[name]}/`)))
        issues.add("resource-kind-mismatch");
      resources += table.length;
      const entry = manifest.files.find((f) => f.file === `${name}.json`);
      if (table.length !== declared.counts[name] || table.length !== entry?.resources)
        issues.add("resource-count-mismatch");
      if (!declared.coverage.includes(name)) issues.add("missing-coverage-declaration");
    }
    const blogs = new Set(tables.get("blogs")?.map((r) => r.id));
    for (const article of z.array(ref.extend({ blog: ref })).parse(data.get("articles"))) {
      references++;
      if (!blogs.has(article.blog.id)) issues.add("unknown-article-blog");
    }
    const owners = new Set(
      [
        ...(tables.get("pages") ?? []),
        ...(tables.get("blogs") ?? []),
        ...(tables.get("articles") ?? []),
      ].map((r) => r.id),
    );
    const parents = z.array(ref.extend({ metafields: rows })).parse(data.get("content-metafields"));
    if (parents.length !== owners.size || parents.some((p) => !owners.has(p.id)))
      issues.add("incomplete-content-metafields");
    const metafields = parents.flatMap((p) => p.metafields);
    unique(
      metafields.map((m) => m.id),
      "duplicate-metafield",
    );
    references += metafields.length;
    const definitions = new Set(
      z
        .array(ref.extend({ type: z.string() }))
        .parse(data.get("metaobjectDefinitions"))
        .map((d) => d.type),
    );
    for (const object of z.array(ref.extend({ type: z.string() })).parse(data.get("metaobjects")))
      if (!definitions.has(object.type)) issues.add("unknown-metaobject-definition");
    if (!declared.completePagination) issues.add("declared-pagination-incomplete");
  } else if (data.size === expected.size && kind === "collection-sources") {
    const declared = z
      .object({
        collections: count,
        sources: count,
        conditionTypes: z.array(z.string()),
        allSelectionConnectionsComplete: z.boolean(),
        conditionScalarsFullySelected: z.boolean(),
      })
      .parse(raw);
    const condition = z.object({ __typename: z.string() }).passthrough();
    const selection = z.object({ product: kindRef("Product") });
    const rules = z.object({
      conditions: z.array(condition),
      selections: z.object({
        nodes: z.array(selection),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    });
    const collections = z
      .array(
        kindRef("Collection").extend({
          products: connection,
          sources: z.array(
            kindRef("CollectionConditionsSource").extend({
              __typename: z.literal("CollectionConditionsSource"),
              inclusion: rules,
              exclusion: rules.nullable(),
            }),
          ),
        }),
      )
      .parse(data.get("collection-sources"));
    const contracts = z
      .record(
        z.string(),
        z.object({
          name: z.string(),
          fields: z.array(z.object({ name: z.string(), args: z.array(z.unknown()) })),
        }),
      )
      .parse(data.get("condition-type-contracts"));
    const sources = collections.flatMap((c) => c.sources),
      used = new Set<string>();
    unique(collections.map((c) => c.id));
    unique(
      sources.map((s) => s.id),
      "duplicate-collection-source",
    );
    for (const collection of collections) {
      complete(collection.products);
      references += collection.products.nodes.length;
      for (const source of collection.sources)
        for (const rule of [source.inclusion, source.exclusion]) {
          if (!rule) continue;
          complete({ ...rule.selections, nodes: rule.selections.nodes.map((n) => n.product) });
          for (const value of rule.conditions) {
            used.add(value.__typename);
            const contract = contracts[value.__typename];
            if (!contract || contract.name !== value.__typename) {
              issues.add("missing-condition-contract");
              continue;
            }
            const fields = contract.fields.filter((f) => !f.args.length).map((f) => f.name);
            if (
              fields.some((f) => !Object.hasOwn(value, f)) ||
              Object.keys(value).some((k) => k !== "__typename" && !fields.includes(k))
            )
              issues.add("incomplete-condition-fields");
          }
        }
    }
    if (JSON.stringify([...used].sort()) !== JSON.stringify([...declared.conditionTypes].sort()))
      issues.add("condition-type-mismatch");
    resources = collections.length;
    if (resources !== declared.collections || sources.length !== declared.sources)
      issues.add("resource-count-mismatch");
    if (!declared.allSelectionConnectionsComplete || !declared.conditionScalarsFullySelected)
      issues.add("declared-coverage-incomplete");
  }
  return {
    readOnly: true,
    source: "local-supplemental-backup-audit",
    kind,
    domainMatches: true,
    manifestSha256: backupDigest(manifestBytes),
    resources,
    references,
    verifiedBinaries: 0,
    verifiedBinaryBytes: 0,
    verifiedFiles: data.size,
    verifiedBytes,
    issues: [...issues].sort(),
    integrityPass: issues.size === 0,
    remoteStabilityVerified: false,
    fullStoreBackupVerified: false,
    restorationVerified: false,
    wipeReady: false,
  };
}
