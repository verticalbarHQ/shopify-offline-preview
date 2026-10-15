import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readComparisonThemeFiles } from "../tools/oracle/benchmark-theme.js";
import { corpusFilesFingerprint } from "../tools/oracle/corpus-environment.js";
import { prepareNativeImageProbe } from "../tools/oracle/image-native.js";
import {
  type NativeImageProbeUploadContext,
  openOracleNativeImageProbeUploader,
  type ThemeUploadDependencies,
} from "../tools/oracle/theme-upload.js";
import { config, shopId } from "./helpers/case-store.js";

// All upload/API responses are authored. No real Shopify command, upload or approval.
async function fixture(kind: "product" | "collection" | "article") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sop-probe-upload-"))),
    probe = prepareNativeImageProbe(kind),
    id = { product: "8", collection: "9", article: "10" }[kind],
    theme = {
      id: `gid://shopify/OnlineStoreTheme/${id}`,
      role: "UNPUBLISHED",
      processing: false,
      processingFailed: false,
    };
  let calls = 0,
    authorizations = 0,
    allowed = true;
  const dependencies: ThemeUploadDependencies<NativeImageProbeUploadContext> = {
    authorize: async (context) => {
      authorizations++;
      assert.equal(context.domain, config.domain);
      assert.equal(context.shopId, shopId);
      assert.equal(context.probe, kind);
      assert.equal(context.filesHash, probe.harnessHash);
      assert.equal("theme" in context, false);
      assert.equal("commit" in context, false);
      if (!allowed) throw new Error("authored denial");
    },
    readIdentity: async () => ({
      id: shopId,
      myshopifyDomain: config.domain,
      name: "Authored",
      currencyCode: "USD",
      ianaTimezone: "UTC",
      plan: { partnerDevelopment: true },
      metafield: { value: "true" },
    }),
    readTheme: async (actual) => {
      assert.equal(actual, id);
      return { ...theme };
    },
    readAllFiles: async (actual) => {
      assert.equal(actual, id);
      return structuredClone(probe.files);
    },
    runCli: async (command) => {
      calls++;
      assert.ok(command.args.includes("--unpublished"));
      assert.ok(!command.args.includes("--publish"));
      assert.equal(
        command.args[command.args.indexOf("--theme") + 1],
        `SOP-native-image-${kind}-${probe.harnessHash.slice(0, 12)}`,
      );
      const files = await readComparisonThemeFiles(command.cwd);
      assert.equal((await stat(join(command.cwd, "locales"))).isDirectory(), true);
      assert.equal(corpusFilesFingerprint(files), probe.harnessHash);
      const layout = files["layout/theme.liquid"],
        text = typeof layout === "string" ? layout : new TextDecoder().decode(layout);
      assert.match(text, /{{content_for_header}}/);
      assert.match(text, /{{content_for_layout}}/);
      return JSON.stringify({ theme: { id, role: "unpublished", shop: config.domain } });
    },
  };
  return {
    directory,
    probe,
    id,
    theme,
    dependencies,
    open: () => openOracleNativeImageProbeUploader(config, shopId, kind, directory, dependencies),
    counts: () => ({ calls, authorizations }),
    deny: () => {
      allowed = false;
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
test("all three canonical Native image probes use guarded unpublished uploads and cannot return benchmark proof", async () => {
  for (const kind of ["product", "collection", "article"] as const) {
    const f = await fixture(kind),
      uploader = await f.open();
    try {
      const result = await uploader.push();
      assert.equal(result.themeId, f.id);
      assert.equal(await result.verifyThemeFiles(f.theme), undefined);
      const record = JSON.parse(await readFile(join(f.directory, "theme-upload.json"), "utf8"));
      assert.equal(record.probe, kind);
      assert.equal(record.filesHash, f.probe.harnessHash);
      assert.equal("theme" in record, false);
      assert.equal("commit" in record, false);
      await assert.rejects(uploader.push(), { code: "duplicate-operation" });
      await uploader.close();
      const reopened = await f.open();
      try {
        await assert.rejects(reopened.push(), { code: "duplicate-operation" });
      } finally {
        await reopened.close();
      }
      assert.deepEqual(f.counts(), { calls: 1, authorizations: 1 });
      f.probe.files["sections/unowned.liquid"] = "extra";
      await assert.rejects(result.verifyThemeFiles(f.theme), { code: "upload-unverified" });
    } finally {
      await uploader.close();
      await f.close();
    }
  }
});
test("probe kind is part of the private scope and denial dispatches no CLI", async () => {
  const f = await fixture("product"),
    uploader = await f.open();
  try {
    f.deny();
    await assert.rejects(uploader.push(), { code: "precondition-failed" });
    assert.equal(f.counts().calls, 0);
  } finally {
    await uploader.close();
  }
  try {
    await assert.rejects(
      openOracleNativeImageProbeUploader(config, shopId, "article", f.directory, f.dependencies),
      { code: "scope-mismatch" },
    );
  } finally {
    await f.close();
  }
});
test("wrong, processing, failed, live or incomplete probe themes keep the dispatched outcome pending", async () => {
  for (const failure of ["id", "processing", "failed", "live", "missing-layout"]) {
    const f = await fixture("collection");
    if (failure === "id") f.theme.id = "gid://shopify/OnlineStoreTheme/99";
    if (failure === "processing") f.theme.processing = true;
    if (failure === "failed") f.theme.processingFailed = true;
    if (failure === "live") f.theme.role = "MAIN";
    if (failure === "missing-layout") delete f.probe.files["layout/theme.liquid"];
    const uploader = await f.open();
    try {
      await assert.rejects(uploader.push(), { code: "upload-unverified" });
      await assert.rejects(uploader.push(), { code: "recovery-required" });
      assert.equal(f.counts().calls, 1);
    } finally {
      await uploader.close();
      await f.close();
    }
  }
});
