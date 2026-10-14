import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupDigest } from "../tools/oracle/backup-audit.js";
import { auditSupplementalBackup } from "../tools/oracle/supplemental-backup-audit.js";

const config = { domain: "owned-demo.myshopify.com", apiVersion: "2026-10" as const };
const imageId = "gid://shopify/MediaImage/3";
const imagePath = `files/${backupDigest(Buffer.from(imageId))}.bin`;
const empty = () => ({ nodes: [], pageInfo: { hasNextPage: false } });
async function sample(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sop-supplemental-")));
  try {
    await mkdir(join(root, "files"));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function file(root: string, path: string, value: string) {
  const bytes = Buffer.from(value);
  await writeFile(join(root, path), bytes);
  return { path, bytes: bytes.length, sha256: backupDigest(bytes) };
}
function collections() {
  return [
    {
      id: "gid://shopify/Collection/1",
      products: { nodes: [{ id: "gid://shopify/Product/2" }], pageInfo: { hasNextPage: false } },
      metafields: empty(),
    },
  ];
}
async function collectionArchive(root: string, rows = collections()) {
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      ...config,
      readOnly: true,
      collections: rows.length,
      memberships: rows.reduce((n, r) => n + r.products.nodes.length, 0),
      metafields: 0,
      file: await file(root, "collections.json", JSON.stringify(rows)),
    }),
  );
}
async function mediaArchive(root: string, truncated = false, includeImage = true) {
  const metadata = await file(
    root,
    "media.json",
    JSON.stringify([
      {
        id: "gid://shopify/Product/2",
        media: {
          nodes: [{ id: imageId, mediaContentType: "IMAGE", originalSource: { fileSize: 4 } }],
          pageInfo: { hasNextPage: truncated },
        },
      },
    ]),
  );
  const entry = { ...(await file(root, imagePath, "test")), id: imageId };
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      ...config,
      readOnly: true,
      products: 1,
      originalImages: 1,
      metadata,
      files: includeImage ? [entry] : [],
      doubleDownloadStable: true,
      restorationVerified: true,
    }),
  );
}

test("collection archive verifies counts and bytes without trusting restoration declarations", async () => {
  await sample(async (root) => {
    await collectionArchive(root);
    const result = await auditSupplementalBackup(config, "collections", root);
    assert.equal(result.integrityPass, true);
    assert.equal(result.resources, 1);
    assert.equal(result.references, 1);
    assert.equal(result.wipeReady, false);
    await writeFile(join(root, "collections.json"), "tampered payload must stay private");
    const changed = await auditSupplementalBackup(config, "collections", root);
    assert.equal(changed.integrityPass, false);
    assert.ok(changed.issues.includes("file-hash-or-size-mismatch"));
    assert.ok(!JSON.stringify(changed).includes("tampered payload"));
  });
});
test("truncated memberships and duplicated collection references are detected", async () => {
  await sample(async (root) => {
    const rows = collections();
    const first = rows[0];
    assert.ok(first);
    first.products.pageInfo.hasNextPage = true;
    first.products.nodes.push({ id: "gid://shopify/Product/2" });
    rows.push(structuredClone(first));
    await collectionArchive(root, rows);
    const result = await auditSupplementalBackup(config, "collections", root);
    assert.equal(result.integrityPass, false);
    assert.ok(result.issues.includes("nested-pagination-incomplete"));
    assert.ok(result.issues.includes("duplicate-resource"));
    assert.ok(result.issues.includes("duplicate-reference"));
  });
});
test("media archive verifies original binary bytes and leaves remote stability unverified", async () => {
  await sample(async (root) => {
    await mediaArchive(root);
    const result = await auditSupplementalBackup(config, "product-media", root);
    assert.equal(result.integrityPass, true);
    assert.equal(result.verifiedBinaries, 1);
    assert.equal(result.verifiedBinaryBytes, 4);
    assert.equal(result.remoteStabilityVerified, false);
    assert.equal(result.restorationVerified, false);
    assert.equal(result.fullStoreBackupVerified, false);
  });
});
test("missing image entries and truncated media cannot yield a successful archive", async () => {
  await sample(async (root) => {
    await mediaArchive(root, true, false);
    const result = await auditSupplementalBackup(config, "product-media", root);
    assert.equal(result.integrityPass, false);
    assert.ok(result.issues.includes("nested-pagination-incomplete"));
    assert.ok(result.issues.includes("missing-image-entry"));
    assert.ok(result.issues.includes("unlisted-or-unsafe-image-file"));
  });
});
test("symlinks cannot substitute for archived originals even if the target bytes match", async () => {
  await sample(async (root) => {
    await mediaArchive(root);
    await file(root, "outside.bin", "test");
    await rm(join(root, imagePath));
    await symlink(join(root, "outside.bin"), join(root, imagePath));
    const result = await auditSupplementalBackup(config, "product-media", root);
    assert.equal(result.integrityPass, false);
    assert.equal(result.verifiedBinaries, 0);
    assert.ok(result.issues.includes("file-unreadable-or-unsafe"));
  });
});
test("tampered binaries, duplicate entries and wrong original sizes are reported", async () => {
  await sample(async (root) => {
    await mediaArchive(root);
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.files[0].bytes = 5;
    manifest.files.push(structuredClone(manifest.files[0]));
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(root, imagePath), "evil");
    const result = await auditSupplementalBackup(config, "product-media", root);
    assert.equal(result.integrityPass, false);
    assert.equal(result.verifiedBinaries, 0);
    assert.ok(result.issues.includes("image-reference-or-size-mismatch"));
    assert.ok(result.issues.includes("file-hash-or-size-mismatch"));
    assert.ok(result.issues.includes("duplicate-image-entry"));
  });
});
test("a wrong pinned domain or invalid metadata is rejected without printing source payloads", async () => {
  await sample(async (root) => {
    await mediaArchive(root);
    await assert.rejects(
      auditSupplementalBackup({ ...config, domain: "other.myshopify.com" }, "product-media", root),
      /pinned store/,
    );
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.metadata = await file(root, "media.json", "{}");
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(auditSupplementalBackup(config, "product-media", root));
  });
});
