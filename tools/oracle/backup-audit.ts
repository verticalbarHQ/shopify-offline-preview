import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { themePath } from "../../packages/theme/src/index.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const catalogSchema = z.object({
  domain: z.string(),
  apiVersion: z.literal("2026-10"),
  readOnly: z.literal(true),
  products: z.number().int().nonnegative(),
  pages: z
    .array(
      z.object({
        file: z.string().regex(/^products-[1-9]\d*\.json$/),
        sha256: sha,
        products: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(10000),
  missingCoverage: z.array(z.string()),
  restorationVerified: z.boolean(),
});
const themeSchema = z.object({
  store: z.string(),
  themeId: z.string().regex(/^[1-9]\d*$/),
  role: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(32 * 1024 * 1024),
        sha256: sha,
      }),
    )
    .max(10000),
  fullStoreBackup: z.boolean(),
  restorationVerified: z.boolean(),
});
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = z.object({ nodes: z.array(z.unknown()), pageInfo });
const pageSchema = z.object({
  products: z.object({
    nodes: z.array(
      z.object({
        id: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
        variants: connection,
        images: connection,
        metafields: connection,
      }),
    ),
    pageInfo,
  }),
});

async function directory(path: string): Promise<string> {
  const full = resolve(path),
    stat = await lstat(full);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(full)) !== full)
    throw new Error("Backup directory must be a canonical local directory");
  return full;
}
async function localFile(root: string, path: string): Promise<Uint8Array> {
  themePath(path);
  const full = join(root, path),
    stat = await lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(dirname(full))) !== dirname(full))
    throw new Error("Unsafe backup file");
  if (stat.size > 32 * 1024 * 1024) throw new Error("Backup file exceeds audit limits");
  return readFile(full);
}
function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Audits existing partial exports without interpreting theme instructions or making API calls. */
export async function auditOracleBackups(
  config: OracleConfig,
  catalogPath: string,
  themePath: string,
) {
  oracleConfigSchema.parse(config);
  const catalogRoot = await directory(catalogPath),
    themeRoot = await directory(themePath);
  const catalogBytes = await localFile(catalogRoot, "manifest.json"),
    themeBytes = await localFile(themeRoot, "manifest.json");
  const catalog = catalogSchema.parse(json(catalogBytes)),
    theme = themeSchema.parse(json(themeBytes));
  if (catalog.domain !== config.domain || theme.store !== config.domain)
    throw new Error("Backup domain differs from pinned store");
  if (catalog.apiVersion !== config.apiVersion) throw new Error("Backup API version mismatch");
  const issues = new Set<string>();
  const productIds = new Set<string>(),
    cursors = new Set<string>(),
    pageFiles = new Set<string>();
  let verifiedCatalogPages = 0,
    products = 0,
    nestedTruncated = 0,
    cursor: string | null = null;
  for (let index = 0; index < catalog.pages.length; index++) {
    const entry = catalog.pages[index];
    if (!entry) continue;
    if (pageFiles.has(entry.file)) {
      issues.add("catalog-duplicate-page");
      continue;
    }
    pageFiles.add(entry.file);
    if (entry.file !== `products-${index + 1}.json`) issues.add("catalog-page-order");
    try {
      const bytes = await localFile(catalogRoot, entry.file);
      if (digest(bytes) !== entry.sha256) {
        issues.add("catalog-hash-mismatch");
        continue;
      }
      const variables = z
        .object({ after: z.string().nullable() })
        .parse(json(await localFile(catalogRoot, `variables-${index + 1}.json`)));
      if (variables.after !== cursor) issues.add("catalog-cursor-chain");
      const page = pageSchema.parse(json(bytes)).products;
      if (page.nodes.length !== entry.products) issues.add("catalog-page-count");
      for (const product of page.nodes) {
        if (productIds.has(product.id)) issues.add("catalog-duplicate-product");
        productIds.add(product.id);
        for (const child of [product.variants, product.images, product.metafields])
          if (child.pageInfo.hasNextPage) nestedTruncated++;
      }
      products += page.nodes.length;
      if (page.pageInfo.hasNextPage !== index < catalog.pages.length - 1)
        issues.add("catalog-terminal-page");
      cursor = page.pageInfo.endCursor;
      if (page.pageInfo.hasNextPage && (!cursor || cursors.has(cursor)))
        issues.add("catalog-cursor-stalled");
      if (cursor) cursors.add(cursor);
      verifiedCatalogPages++;
    } catch {
      issues.add("catalog-page-unreadable-or-invalid");
    }
  }
  if (products !== catalog.products) issues.add("catalog-total-count");
  if (nestedTruncated) issues.add("catalog-nested-pagination-incomplete");
  const themeFilesRoot = await directory(join(themeRoot, "files"));
  const observedPaths = new Set<string>();
  async function inventory(relative: string): Promise<void> {
    for (const entry of await readdir(join(themeFilesRoot, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        !relative &&
        !/^(?:assets|blocks|config|layout|locales|sections|snippets|templates)$/.test(entry.name)
      )
        continue;
      if (entry.isSymbolicLink()) {
        issues.add("theme-symlink-entry");
        continue;
      }
      if (entry.isDirectory()) await inventory(path);
      else if (entry.isFile()) observedPaths.add(path);
      else issues.add("theme-nonregular-entry");
    }
  }
  await inventory("");
  const paths = new Set<string>();
  let verifiedThemeFiles = 0,
    verifiedThemeBytes = 0,
    unexpectedThemeEntries = 0;
  for (const entry of theme.files) {
    if (
      !/^(?:assets|blocks|config|layout|locales|sections|snippets|templates)\//.test(entry.path)
    ) {
      unexpectedThemeEntries++;
      issues.add("theme-unexpected-path");
      continue;
    }
    if (paths.has(entry.path)) {
      issues.add("theme-duplicate-path");
      continue;
    }
    paths.add(entry.path);
    try {
      const bytes = await localFile(themeFilesRoot, entry.path);
      if (bytes.byteLength !== entry.bytes || digest(bytes) !== entry.sha256) {
        issues.add("theme-hash-or-size-mismatch");
        continue;
      }
      verifiedThemeFiles++;
      verifiedThemeBytes += bytes.byteLength;
    } catch {
      issues.add("theme-file-unreadable-or-unsafe");
    }
  }
  const unlistedThemeFiles = [...observedPaths].filter((path) => !paths.has(path)).length;
  if (unlistedThemeFiles) issues.add("theme-unlisted-file");
  return {
    schemaVersion: "1.0",
    source: "local-partial-backup-audit",
    readOnly: true,
    domainMatches: true,
    liveStoreIdentityVerified: false,
    manifests: { catalogSha256: digest(catalogBytes), themeSha256: digest(themeBytes) },
    catalog: {
      declaredPages: catalog.pages.length,
      verifiedPages: verifiedCatalogPages,
      declaredProducts: catalog.products,
      observedProducts: products,
      uniqueProducts: productIds.size,
      nestedTruncatedConnections: nestedTruncated,
      declaredMissingCoverage: catalog.missingCoverage.length,
    },
    theme: {
      id: theme.themeId,
      role: theme.role,
      declaredFiles: theme.files.length,
      verifiedThemeFiles,
      verifiedThemeBytes,
      unexpectedEntries: unexpectedThemeEntries,
      unlistedThemeFiles,
    },
    issues: [...issues].sort(),
    integrityPass: issues.size === 0,
    // Legacy manifests do not prove complete coverage, restoration or fresh authorization.
    fullStoreBackupVerified: false,
    restorationVerified: false,
    wipeReady: false,
    blockers: [
      "complete-coverage-not-proven",
      "restoration-not-verified",
      "fresh-store-identity-required",
      "action-time-owner-approval-required",
    ],
  };
}
