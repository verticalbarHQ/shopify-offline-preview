import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupDigest } from "../tools/oracle/backup-audit.js";
import { auditSupplementalBackup } from "../tools/oracle/supplemental-backup-audit.js";

// Authored archives only; these fixtures are not store exports or restoration evidence.

const config = { domain: "owned-demo.myshopify.com", apiVersion: "2026-10" as const };
const id = (kind: string, number = 1) => `gid://shopify/${kind}/${number}`;
const ref = (kind: string, number = 1) => ({ id: id(kind, number) });
const connection = (nodes: { id: string }[] = []) => ({ nodes, pageInfo: { hasNextPage: false } });
async function sample(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sop-read-backup-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function archive(
  root: string,
  files: Record<string, unknown>,
  declarations: Record<string, unknown>,
  content = false,
) {
  const entries = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(join(root, `${name}.json`), bytes);
    entries.push({
      file: `${name}.json`,
      bytes: bytes.length,
      sha256: backupDigest(bytes),
      ...(content && Array.isArray(value) ? { resources: value.length } : {}),
    });
  }
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      ...config,
      readOnly: true,
      storeDataMutations: 0,
      ...declarations,
      files: entries,
    }),
  );
}
function inventory() {
  return {
    properties: { quantityNames: [{ name: "available" }, { name: "on_hand" }] },
    "inventory-items": [
      {
        ...ref("InventoryItem"),
        variant: { ...ref("ProductVariant"), product: ref("Product") },
        inventoryLevels: [
          {
            id: `${id("InventoryLevel")}?inventory_item_id=1`,
            location: ref("Location"),
            quantities: [
              { name: "available", quantity: 3 },
              { name: "on_hand", quantity: 4 },
            ],
          },
        ],
      },
    ],
  };
}
const inventoryCounts = {
  inventoryItems: 1,
  inventoryLevels: 1,
  locations: 1,
  quantityNames: ["available", "on_hand"],
  completePagination: true,
};
function content() {
  return {
    pages: [ref("Page")],
    blogs: [ref("Blog")],
    articles: [{ ...ref("Article"), blog: ref("Blog") }],
    menus: [],
    publications: [],
    locations: [],
    metaobjectDefinitions: [],
    metaobjects: [],
    "content-metafields": [
      { ...ref("Page"), metafields: [ref("Metafield")] },
      { ...ref("Blog"), metafields: [] },
      { ...ref("Article"), metafields: [] },
    ],
  };
}
async function contentArchive(root: string, files = content()) {
  await archive(
    root,
    files,
    {
      counts: Object.fromEntries(Object.entries(files).map(([name, rows]) => [name, rows.length])),
      coverage: Object.keys(files),
      completePagination: true,
    },
    true,
  );
}
function sources() {
  const typename = "CollectionSourceInclusionConditionProductTag";
  return {
    "collection-sources": [
      {
        ...ref("Collection"),
        products: connection([ref("Product")]),
        sources: [
          {
            ...ref("CollectionConditionsSource"),
            __typename: "CollectionConditionsSource",
            inclusion: {
              conditions: [
                {
                  __typename: typename,
                  id: id("CollectionSourceInclusionConditionProductTag"),
                  relation: "EQUALS",
                  values: ["private tag"],
                },
              ],
              selections: { nodes: [], pageInfo: { hasNextPage: false } },
            },
            exclusion: null,
          },
        ],
      },
    ],
    "condition-type-contracts": {
      [typename]: {
        name: typename,
        fields: ["id", "relation", "values"].map((name) => ({ name, args: [] })),
      },
    },
  };
}
const sourceCounts = {
  collections: 1,
  sources: 1,
  conditionTypes: ["CollectionSourceInclusionConditionProductTag"],
  allSelectionConnectionsComplete: true,
  conditionScalarsFullySelected: true,
};

test("inventory audit verifies parameterized level ownership and never trusts restore claims", async () => {
  await sample(async (root) => {
    await archive(root, inventory(), {
      ...inventoryCounts,
      restorationVerified: true,
      wipeReady: true,
    });
    const r = await auditSupplementalBackup(config, "inventory", root);
    assert.equal(r.integrityPass, true);
    assert.equal(r.resources, 1);
    assert.equal(r.references, 1);
    assert.equal(r.restorationVerified, false);
    assert.equal(r.wipeReady, false);
    assert.equal(r.remoteStabilityVerified, false);
  });
});
test("inventory quantities, owner IDs and declaration mismatches fail despite matching file hashes", async () => {
  await sample(async (root) => {
    const files = inventory(),
      item = files["inventory-items"][0];
    assert.ok(item);
    const level = item.inventoryLevels[0];
    assert.ok(level);
    level.quantities.pop();
    level.id = `${id("InventoryLevel")}?inventory_item_id=2`;
    item.inventoryLevels.push(structuredClone(level));
    await archive(root, files, inventoryCounts);
    const r = await auditSupplementalBackup(config, "inventory", root);
    for (const issue of [
      "incomplete-inventory-quantities",
      "inventory-level-owner-mismatch",
      "duplicate-inventory-level",
      "duplicate-inventory-location",
      "resource-count-mismatch",
    ])
      assert.ok(r.issues.includes(issue), issue);
    assert.ok(!JSON.stringify(r).includes(level.id));
  });
});
test("content audit checks all categories and content metafield owner coverage", async () => {
  await sample(async (root) => {
    await contentArchive(root);
    const r = await auditSupplementalBackup(config, "content", root);
    assert.equal(r.integrityPass, true);
    assert.ok("verifiedFiles" in r);
    assert.equal(r.verifiedFiles, 9);
    assert.equal(r.resources, 6);
    assert.equal(r.references, 2);
    const files = content();
    const article = files.articles[0];
    assert.ok(article);
    article.blog = ref("Blog", 2);
    files["content-metafields"].pop();
    await contentArchive(root, files);
    const bad = await auditSupplementalBackup(config, "content", root);
    assert.ok(bad.issues.includes("unknown-article-blog"));
    assert.ok(bad.issues.includes("incomplete-content-metafields"));
  });
});
test("content duplicate owners and a resource of the wrong kind cannot pass", async () => {
  await sample(async (root) => {
    const files = content();
    files.pages[0] = ref("Product");
    const parent = files["content-metafields"][0];
    assert.ok(parent);
    files["content-metafields"][1] = structuredClone(parent);
    await contentArchive(root, files);
    const r = await auditSupplementalBackup(config, "content", root);
    assert.equal(r.integrityPass, false);
    assert.ok(r.issues.includes("resource-kind-mismatch"));
    assert.ok(r.issues.includes("duplicate-resource"));
    assert.ok(r.issues.includes("incomplete-content-metafields"));
  });
});
test("collection conditions require their declared fields and complete membership connections", async () => {
  await sample(async (root) => {
    await archive(root, sources(), sourceCounts);
    const ok = await auditSupplementalBackup(config, "collection-sources", root);
    assert.equal(ok.integrityPass, true);
    assert.equal(ok.resources, 1);
    const files = sources(),
      row = files["collection-sources"][0];
    assert.ok(row);
    row.products.pageInfo.hasNextPage = true;
    const condition = row.sources[0]?.inclusion.conditions[0];
    assert.ok(condition);
    Reflect.deleteProperty(condition, "values");
    await archive(root, files, sourceCounts);
    const bad = await auditSupplementalBackup(config, "collection-sources", root);
    assert.ok(bad.issues.includes("incomplete-condition-fields"));
    assert.ok(bad.issues.includes("nested-pagination-incomplete"));
    assert.ok(!JSON.stringify(bad).includes("private tag"));
  });
});
test("missing condition metadata and duplicated sources are detected", async () => {
  await sample(async (root) => {
    const files = sources(),
      row = files["collection-sources"][0];
    assert.ok(row);
    const source = row.sources[0];
    assert.ok(source);
    row.sources.push(structuredClone(source));
    await archive(root, { ...files, "condition-type-contracts": {} }, sourceCounts);
    const r = await auditSupplementalBackup(config, "collection-sources", root);
    assert.ok(r.issues.includes("missing-condition-contract"));
    assert.ok(r.issues.includes("duplicate-collection-source"));
    assert.ok(r.issues.includes("resource-count-mismatch"));
  });
});
test("tampered bytes, missing or duplicate manifest entries and unlisted files fail closed", async () => {
  await sample(async (root) => {
    await archive(root, inventory(), inventoryCounts);
    const p = join(root, "manifest.json"),
      m = JSON.parse(await readFile(p, "utf8"));
    m.files.push(structuredClone(m.files[0]));
    await writeFile(p, JSON.stringify(m));
    await writeFile(join(root, "inventory-items.json"), "withheld private payload");
    await writeFile(join(root, "extra.json"), "{}");
    const r = await auditSupplementalBackup(config, "inventory", root);
    for (const issue of [
      "file-hash-or-size-mismatch",
      "missing-archive-file",
      "duplicate-archive-file",
      "unlisted-or-unsafe-archive-file",
    ])
      assert.ok(r.issues.includes(issue));
    assert.ok(!JSON.stringify(r).includes("withheld private payload"));
  });
});
test("symbolic links and wrong domains cannot pass the supplemental read audit", async () => {
  await sample(async (root) => {
    await archive(root, inventory(), inventoryCounts);
    await assert.rejects(
      auditSupplementalBackup({ ...config, domain: "other.myshopify.com" }, "inventory", root),
      /pinned store/,
    );
    const target = await readFile(join(root, "properties.json"));
    await writeFile(join(root, "outside.json"), target);
    await rm(join(root, "properties.json"));
    await symlink(join(root, "outside.json"), join(root, "properties.json"));
    const r = await auditSupplementalBackup(config, "inventory", root);
    assert.equal(r.integrityPass, false);
    assert.ok(r.issues.includes("file-unreadable-or-invalid"));
  });
});
