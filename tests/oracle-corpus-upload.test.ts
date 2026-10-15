import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { registry } from "../packages/spec/src/index.js";
import { readComparisonThemeFiles } from "../tools/oracle/benchmark-theme.js";
import { corpusFilesFingerprint } from "../tools/oracle/corpus-environment.js";
import {
  inspectPreparedFilterCorpus,
  preparePinnedFilterCorpus,
  readPreparedFilterCorpusFiles,
} from "../tools/oracle/corpus-source.js";
import {
  type FilterCorpusUploadContext,
  openOracleFilterCorpusUploader,
  type ThemeUploadDependencies,
} from "../tools/oracle/theme-upload.js";
import { config, shopId } from "./helpers/case-store.js";

// Pinned public inputs with explicit self-mapping for contract tests only, not a calibrated store fixture.
const generated: { id: string; kind: string; name: string; path: string; liquid: string }[] =
    JSON.parse(
      await readFile(
        new URL("../packages/spec/src/generated/corpus.json", import.meta.url),
        "utf8",
      ),
    ),
  mapping = Object.fromEntries(
    generated.filter((input) => input.kind === "filters").map((input) => [input.path, input.path]),
  );
test("pinned filter preparation binds full inputs, requests and files without allowing cloned flags or mutable inspection results", async () => {
  const prepared = await preparePinnedFilterCorpus(mapping),
    info = inspectPreparedFilterCorpus(prepared);
  assert.equal(info.spec.commit, registry.commit);
  assert.equal(info.sourceHash, registry.hashes["filters.json"]);
  assert.equal(info.cases.length, 235);
  assert.equal(info.unavailable.length, 10);
  assert.deepEqual(
    info.cases.map(({ id, kind, name, path, liquid }) => ({ id, kind, name, path, liquid })),
    generated.filter((input) => input.kind === "filters"),
  );
  const files = readPreparedFilterCorpusFiles(prepared);
  assert.equal(Object.keys(files).length, 710);
  assert.equal(corpusFilesFingerprint(files), info.filesHash);
  const item = info.cases[0];
  assert.ok(item);
  item.requestPath = "/changed";
  files["layout/theme.liquid"] = "changed";
  assert.notEqual(inspectPreparedFilterCorpus(prepared).cases[0]?.requestPath, item.requestPath);
  assert.equal(corpusFilesFingerprint(readPreparedFilterCorpusFiles(prepared)), info.filesHash);
  assert.throws(() => inspectPreparedFilterCorpus({ ...prepared }), { code: "unverified-source" });
  assert.throws(() => readPreparedFilterCorpusFiles(JSON.parse(JSON.stringify(prepared))), {
    code: "unverified-source",
  });
  await assert.rejects(preparePinnedFilterCorpus({}), { code: "invalid-input" });
  const changed = { ...mapping },
    path = Object.keys(changed)[0];
  assert.ok(path);
  const url = new URL(changed[path] ?? "/", "https://fixture.invalid");
  url.searchParams.set("page", "2");
  changed[path] = url.pathname + url.search;
  const other = inspectPreparedFilterCorpus(await preparePinnedFilterCorpus(changed));
  assert.equal(other.filesHash, info.filesHash);
  assert.notEqual(other.manifestHash, info.manifestHash);
});
async function fixture() {
  const prepared = await preparePinnedFilterCorpus(mapping),
    info = inspectPreparedFilterCorpus(prepared),
    directory = await realpath(await mkdtemp(join(tmpdir(), "sop-corpus-upload-"))),
    files = readPreparedFilterCorpusFiles(prepared),
    theme = {
      id: "gid://shopify/OnlineStoreTheme/11",
      role: "UNPUBLISHED",
      processing: false,
      processingFailed: false,
    };
  let calls = 0;
  const dependencies: ThemeUploadDependencies<FilterCorpusUploadContext> = {
    authorize: async (context) => {
      assert.equal(context.corpus, "filters");
      assert.equal(context.specCommit, registry.commit);
      assert.equal(context.cases, 235);
      assert.equal(context.manifestHash, info.manifestHash);
      assert.equal(context.filesHash, info.filesHash);
      assert.equal("theme" in context, false);
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
    readTheme: async () => theme,
    readAllFiles: async () => files,
    runCli: async (command) => {
      calls++;
      assert.ok(command.args.includes("--unpublished"));
      assert.equal(
        corpusFilesFingerprint(await readComparisonThemeFiles(command.cwd)),
        info.filesHash,
      );
      return JSON.stringify({ theme: { id: 11, role: "unpublished", shop: config.domain } });
    },
  };
  return {
    prepared,
    info,
    directory,
    files,
    theme,
    dependencies,
    calls: () => calls,
    open: () => openOracleFilterCorpusUploader(config, shopId, prepared, directory, dependencies),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
test("all 235 filter inputs upload through the guarded lane, keep private source metadata and return no benchmark proof", async () => {
  const f = await fixture(),
    uploader = await f.open();
  try {
    const result = await uploader.push();
    assert.equal(result.themeId, "11");
    assert.equal(await result.verifyThemeFiles(f.theme), undefined);
    const record = JSON.parse(await readFile(join(f.directory, "theme-upload.json"), "utf8"));
    assert.equal(record.specCommit, registry.commit);
    assert.equal(record.manifestHash, f.info.manifestHash);
    assert.equal(record.cases, 235);
    assert.equal("theme" in record, false);
    assert.equal((await stat(join(f.directory, "theme-upload.json"))).mode & 0o777, 0o600);
    await uploader.close();
    const reopened = await f.open();
    try {
      await assert.rejects(reopened.push(), { code: "duplicate-operation" });
    } finally {
      await reopened.close();
    }
    assert.equal(f.calls(), 1);
    f.files["sections/unowned.liquid"] = "changed";
    await assert.rejects(result.verifyThemeFiles(f.theme), { code: "upload-unverified" });
  } finally {
    await uploader.close();
    await f.close();
  }
});
test("changed uploaded corpus bytes remain pending and serialized preparation flags cannot dispatch", async () => {
  const f = await fixture();
  f.files["layout/sop-corpus.liquid"] = "changed";
  const uploader = await f.open();
  try {
    await assert.rejects(uploader.push(), { code: "upload-unverified" });
    await assert.rejects(uploader.push(), { code: "recovery-required" });
    assert.equal(f.calls(), 1);
    await assert.rejects(
      openOracleFilterCorpusUploader(
        config,
        shopId,
        { ...f.prepared },
        f.directory,
        f.dependencies,
      ),
      { code: "unverified-source" },
    );
  } finally {
    await uploader.close();
    await f.close();
  }
});
test("the preparation CLI keeps its existing counts and writes the source-bound manifest only in its private working tree", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sop-corpus-cli-")));
  let output = "";
  try {
    const path = join(directory, "mapping.json");
    await writeFile(path, JSON.stringify(mapping), { mode: 0o600 });
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../tools/oracle/prepare-corpus.ts", import.meta.url)),
        "--path-map",
        path,
      ],
      { cwd: directory, maxBuffer: 65536 },
    );
    const summary = JSON.parse(result.stdout);
    output = summary.directory;
    assert.equal(summary.preparedCases, 235);
    assert.equal(summary.unavailableExamples, 10);
    assert.equal(summary.uploaded, false);
    assert.ok(output.startsWith(join(tmpdir(), "sop-oracle-corpus-")));
    const manifest = join(directory, ".local/oracle/corpus-prepared.json"),
      record = JSON.parse(await readFile(manifest, "utf8"));
    assert.equal(record.spec.commit, registry.commit);
    assert.equal(record.sourceHash, registry.hashes["filters.json"]);
    assert.equal(record.filesHash, corpusFilesFingerprint(await readComparisonThemeFiles(output)));
    assert.equal((await stat(manifest)).mode & 0o777, 0o600);
  } finally {
    if (output.startsWith(join(tmpdir(), "sop-oracle-corpus-")))
      await rm(output, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
