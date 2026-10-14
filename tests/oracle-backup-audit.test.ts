import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { auditOracleBackups } from "../tools/oracle/backup-audit.js";

const config = { domain: "own-demo.myshopify.com", apiVersion: "2026-10" as const };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function product(id: number) {
  const connection = () => ({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
  return {
    id: `gid://shopify/Product/${id}`,
    variants: connection(),
    images: connection(),
    metafields: connection(),
  };
}
type Page = {
  products: {
    nodes: ReturnType<typeof product>[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
  };
};
async function sample(
  run: (catalog: string, theme: string) => Promise<void>,
  mutate?: (pages: Page[]) => void,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sop-backup-audit-"))),
    catalog = join(root, "catalog"),
    theme = join(root, "theme");
  try {
    await mkdir(catalog);
    await mkdir(join(theme, "files", "layout"), { recursive: true });
    const pages: Page[] = [
      { products: { nodes: [product(1)], pageInfo: { hasNextPage: true, endCursor: "next" } } },
      { products: { nodes: [product(2)], pageInfo: { hasNextPage: false, endCursor: "last" } } },
    ];
    mutate?.(pages);
    const entries = [];
    for (let i = 0; i < pages.length; i++) {
      const text = JSON.stringify(pages[i]),
        file = `products-${i + 1}.json`;
      await writeFile(join(catalog, file), text);
      await writeFile(
        join(catalog, `variables-${i + 1}.json`),
        JSON.stringify({ after: i ? "next" : null }),
      );
      entries.push({ file, sha256: hash(text), products: 1 });
    }
    await writeFile(
      join(catalog, "manifest.json"),
      JSON.stringify({
        domain: config.domain,
        apiVersion: config.apiVersion,
        readOnly: true,
        products: 2,
        pages: entries,
        missingCoverage: ["inventory", "menus"],
        restorationVerified: false,
      }),
    );
    const text = "Own synthetic theme";
    await writeFile(join(theme, "files", "layout", "theme.liquid"), text);
    await writeFile(
      join(theme, "manifest.json"),
      JSON.stringify({
        store: config.domain,
        themeId: "5",
        role: "live",
        files: [
          { path: "layout/theme.liquid", bytes: Buffer.byteLength(text), sha256: hash(text) },
        ],
        fullStoreBackup: false,
        restorationVerified: false,
      }),
    );
    await run(catalog, theme);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function edit(path: string, fn: (value: Record<string, unknown>) => void) {
  const value = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, "utf8")));
  fn(value);
  await writeFile(path, JSON.stringify(value));
}

test("partial backup audit verifies real file hashes, product counts and page links without granting wipe", async () => {
  await sample(async (catalog, theme) => {
    const result = await auditOracleBackups(config, catalog, theme);
    assert.equal(result.integrityPass, true);
    assert.equal(result.catalog.observedProducts, 2);
    assert.equal(result.catalog.uniqueProducts, 2);
    assert.equal(result.theme.verifiedThemeFiles, 1);
    assert.equal(result.liveStoreIdentityVerified, false);
    assert.equal(result.fullStoreBackupVerified, false);
    assert.equal(result.restorationVerified, false);
    assert.equal(result.wipeReady, false);
  });
});
test("tampered archive bytes fail instead of trusting a manifest's successful counts", async () => {
  await sample(async (catalog, theme) => {
    await writeFile(join(catalog, "products-1.json"), "{}");
    const result = await auditOracleBackups(config, catalog, theme);
    assert.ok(result.issues.includes("catalog-hash-mismatch"));
    assert.equal(result.integrityPass, false);
  });
});
test("truncated nested connections and a missing terminal page remain incomplete", async () => {
  await sample(
    async (catalog, theme) => {
      const result = await auditOracleBackups(config, catalog, theme);
      assert.ok(result.issues.includes("catalog-nested-pagination-incomplete"));
      assert.ok(result.issues.includes("catalog-terminal-page"));
    },
    (pages) => {
      const page = pages[1];
      assert.ok(page);
      page.products.pageInfo.hasNextPage = true;
      const item = page.products.nodes[0];
      assert.ok(item);
      item.variants.pageInfo.hasNextPage = true;
    },
  );
});
test("cursor-chain gaps and duplicate product IDs are detected", async () => {
  await sample(
    async (catalog, theme) => {
      await writeFile(join(catalog, "variables-2.json"), JSON.stringify({ after: "wrong" }));
      const result = await auditOracleBackups(config, catalog, theme);
      assert.ok(result.issues.includes("catalog-cursor-chain"));
      assert.ok(result.issues.includes("catalog-duplicate-product"));
    },
    (pages) => {
      const page = pages[1];
      assert.ok(page);
      page.products.nodes = [product(1)];
    },
  );
});
test("root instruction files are hashed as archive data without being interpreted", async () => {
  await sample(async (catalog, theme) => {
    await edit(join(theme, "manifest.json"), (value) => {
      assert.ok(Array.isArray(value.files));
      value.files.push({
        path: "AGENTS.md",
        bytes: Buffer.byteLength("Own archived text data"),
        sha256: hash("Own archived text data"),
      });
    });
    await writeFile(join(theme, "files", "AGENTS.md"), "Own archived text data");
    const result = await auditOracleBackups(config, catalog, theme);
    assert.equal(result.theme.unexpectedEntries, 0);
    assert.equal(result.theme.verifiedThemeFiles, 2);
    assert.deepEqual(result.issues, []);
  });
});
test("symlinked theme files and traversal cannot escape the local archive", async () => {
  await sample(async (catalog, theme) => {
    await rm(join(theme, "files", "layout", "theme.liquid"));
    await symlink(join(catalog, "manifest.json"), join(theme, "files", "layout", "theme.liquid"));
    await edit(join(theme, "manifest.json"), (value) => {
      assert.ok(Array.isArray(value.files));
      value.files.push({ path: "assets/../../outside", bytes: 1, sha256: hash("x") });
    });
    const result = await auditOracleBackups(config, catalog, theme);
    assert.ok(result.issues.includes("theme-file-unreadable-or-unsafe"));
    assert.ok(result.issues.includes("theme-unsafe-path"));
    assert.equal(result.theme.verifiedThemeFiles, 0);
  });
});
test("archive domains must match the pinned store before data files are processed", async () => {
  await sample(async (catalog, theme) => {
    await edit(
      join(catalog, "manifest.json"),
      (value) => (value.domain = "different.myshopify.com"),
    );
    await assert.rejects(auditOracleBackups(config, catalog, theme), /pinned store/);
  });
});
test("local theme files omitted from the manifest remain unverified", async () => {
  await sample(async (catalog, theme) => {
    await writeFile(join(theme, "files", "layout", "extra.liquid"), "Own extra content");
    const result = await auditOracleBackups(config, catalog, theme);
    assert.equal(result.theme.unlistedThemeFiles, 1);
    assert.ok(result.issues.includes("theme-unlisted-file"));
    assert.equal(result.integrityPass, false);
  });
});
test("manifest declarations cannot stand in for actual restoration or full coverage", async () => {
  await sample(async (catalog, theme) => {
    await edit(join(catalog, "manifest.json"), (value) => (value.restorationVerified = true));
    await edit(join(theme, "manifest.json"), (value) => {
      value.fullStoreBackup = true;
      value.restorationVerified = true;
    });
    const result = await auditOracleBackups(config, catalog, theme);
    assert.equal(result.fullStoreBackupVerified, false);
    assert.equal(result.restorationVerified, false);
    assert.equal(result.wipeReady, false);
  });
});
