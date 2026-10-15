import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { backupDigest, backupDirectory, backupFile } from "./backup-audit.js";
import { auditReadBackup, type ReadBackupKind, readBackupKind } from "./read-backup-audit.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

const count = z.number().int().nonnegative();
const file = z.object({
  path: z.string(),
  bytes: count.max(32 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const common = z.object({
  domain: z.string(),
  apiVersion: z.literal("2026-10"),
  readOnly: z.literal(true),
});
const connection = z.object({
  nodes: z.array(z.object({ id: z.string() })),
  pageInfo: z.object({ hasNextPage: z.boolean() }),
});
const collectionManifest = common.extend({
  collections: count,
  memberships: count,
  metafields: count,
  file,
});
const mediaManifest = common.extend({
  products: count,
  originalImages: count,
  metadata: file,
  files: z.array(file.extend({ id: z.string() })).max(10000),
});
const collectionRows = z.array(
  z.object({
    id: z.string().regex(/^gid:\/\/shopify\/Collection\/\d+$/),
    products: connection,
    metafields: connection,
  }),
);
const mediaRows = z.array(
  z.object({
    id: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
    media: z.object({
      nodes: z.array(
        z.object({
          id: z.string().regex(/^gid:\/\/shopify\/MediaImage\/\d+$/),
          mediaContentType: z.literal("IMAGE"),
          originalSource: z.object({ fileSize: count }),
        }),
      ),
      pageInfo: z.object({ hasNextPage: z.boolean() }),
    }),
  }),
);
const json = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** Local bytes and coverage only; a manifest cannot prove remote capture or restoration. */
export async function auditSupplementalBackup(
  config: OracleConfig,
  kind: "collections" | "product-media" | ReadBackupKind,
  archive: string,
) {
  oracleConfigSchema.parse(config);
  const readKind = readBackupKind.safeParse(kind);
  if (readKind.success) return auditReadBackup(config, readKind.data, archive);
  const root = await backupDirectory(archive);
  const manifestBytes = await backupFile(root, "manifest.json");
  const raw = json(manifestBytes);
  const manifest = common.parse(raw);
  if (manifest.domain !== config.domain || manifest.apiVersion !== config.apiVersion)
    throw new Error("Backup differs from pinned store");
  const issues = new Set<string>();
  async function verified(entry: z.infer<typeof file>): Promise<Uint8Array | undefined> {
    try {
      const bytes = await backupFile(root, entry.path);
      if (bytes.byteLength === entry.bytes && backupDigest(bytes) === entry.sha256) return bytes;
      issues.add("file-hash-or-size-mismatch");
    } catch {
      issues.add("file-unreadable-or-unsafe");
    }
    return undefined;
  }
  let resources = 0,
    references = 0,
    verifiedBinaries = 0,
    verifiedBinaryBytes = 0;
  if (kind === "collections") {
    const input = collectionManifest.parse(raw);
    const bytes = await verified(input.file);
    if (bytes) {
      const rows = collectionRows.parse(json(bytes));
      resources = rows.length;
      if (resources !== input.collections) issues.add("resource-count-mismatch");
      if (new Set(rows.map((r) => r.id)).size !== rows.length) issues.add("duplicate-resource");
      let metafields = 0;
      for (const row of rows) {
        references += row.products.nodes.length;
        metafields += row.metafields.nodes.length;
        for (const child of [row.products, row.metafields]) {
          if (child.pageInfo.hasNextPage) issues.add("nested-pagination-incomplete");
          if (new Set(child.nodes.map((n) => n.id)).size !== child.nodes.length)
            issues.add("duplicate-reference");
        }
      }
      if (references !== input.memberships || metafields !== input.metafields)
        issues.add("reference-count-mismatch");
    }
  } else {
    const input = mediaManifest.parse(raw);
    const bytes = await verified(input.metadata);
    const paths = new Set<string>(),
      ids = new Set<string>();
    const sizes = new Map<string, number>();
    if (bytes) {
      const rows = mediaRows.parse(json(bytes));
      resources = rows.length;
      if (resources !== input.products) issues.add("resource-count-mismatch");
      if (new Set(rows.map((r) => r.id)).size !== rows.length) issues.add("duplicate-resource");
      for (const row of rows) {
        if (row.media.pageInfo.hasNextPage) issues.add("nested-pagination-incomplete");
        if (new Set(row.media.nodes.map((n) => n.id)).size !== row.media.nodes.length)
          issues.add("duplicate-reference");
        for (const media of row.media.nodes) {
          if (sizes.has(media.id) && sizes.get(media.id) !== media.originalSource.fileSize)
            issues.add("conflicting-image-size");
          sizes.set(media.id, media.originalSource.fileSize);
          references++;
        }
      }
      if (sizes.size !== input.originalImages) issues.add("image-count-mismatch");
    }
    for (const entry of input.files) {
      if (!/^files\/[a-f0-9]{64}\.bin$/.test(entry.path)) {
        issues.add("unexpected-image-path");
        continue;
      }
      if (paths.has(entry.path) || ids.has(entry.id)) {
        issues.add("duplicate-image-entry");
        continue;
      }
      paths.add(entry.path);
      ids.add(entry.id);
      if (!sizes.has(entry.id) || sizes.get(entry.id) !== entry.bytes)
        issues.add("image-reference-or-size-mismatch");
      const image = await verified(entry);
      if (image) {
        verifiedBinaries++;
        verifiedBinaryBytes += image.byteLength;
      }
    }
    if (sizes.size !== ids.size || [...sizes.keys()].some((id) => !ids.has(id)))
      issues.add("missing-image-entry");
    const filesRoot = await backupDirectory(join(root, "files"));
    for (const entry of await readdir(filesRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !paths.has(`files/${entry.name}`))
        issues.add("unlisted-or-unsafe-image-file");
    }
  }
  return {
    readOnly: true,
    source: "local-supplemental-backup-audit",
    kind,
    domainMatches: true,
    manifestSha256: backupDigest(manifestBytes),
    resources,
    references,
    verifiedBinaries,
    verifiedBinaryBytes,
    issues: [...issues].sort(),
    integrityPass: issues.size === 0,
    remoteStabilityVerified: false,
    fullStoreBackupVerified: false,
    restorationVerified: false,
    wipeReady: false,
  };
}
