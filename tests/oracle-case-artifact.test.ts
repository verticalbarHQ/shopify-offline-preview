import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeThemeFileSystem } from "../packages/theme/src/node.js";
import { makeGoldenArtifact } from "../tools/oracle/artifacts.js";
import {
  createBenchmarkThemeVerifier,
  disposePreparedBenchmarkTheme,
  inspectPreparedBenchmarkTheme,
  inspectVerifiedBenchmarkThemeFiles,
  preparePinnedBenchmarkTheme,
  readComparisonThemeFiles,
} from "../tools/oracle/benchmark-theme.js";
import { readCaseSnapshots, savePrivateCaseArchive } from "../tools/oracle/case-archive.js";
import { inspectVerifiedOracleCase } from "../tools/oracle/case-capture.js";
import { compareGoldenCase } from "../tools/oracle/compare-case.js";
import { openOracleSeedStateDriver } from "../tools/oracle/seed-state-driver.js";
import { authoredBenchmark } from "./helpers/benchmark-archive.js";
import {
  allContracts,
  compactCaseStore,
  config,
  locationId,
  publication,
  shopId,
} from "./helpers/case-store.js";

// All HTTP/tarball payloads are authored mocks. No real golden is written or Shopify verification claimed.
async function harness() {
  const prepared = await authoredBenchmark(),
    info = inspectPreparedBenchmarkTheme(prepared),
    files = await readComparisonThemeFiles(info.path),
    store = compactCaseStore(),
    directory = await realpath(await mkdtemp(join(tmpdir(), "sop-certified-case-")));
  try {
    const driver = await openOracleSeedStateDriver(
      config,
      store.snapshot,
      shopId,
      "authored",
      allContracts,
      [],
      directory,
      {
        authorize: async () => {},
        fetcher: store.fetcher,
        readImage: async () => {
          throw new Error();
        },
        location: { kind: "Location", id: locationId },
        publication,
      },
    );
    await driver.runState(store.state.hash);
    const verifier = createBenchmarkThemeVerifier(prepared, "7", async () => files),
      imageProbes = {
        product: { themeId: "8", cookie: "authored-cookie", dependencies: store.imageDependencies },
        collection: {
          themeId: "9",
          cookie: "authored-cookie",
          dependencies: store.imageDependencies,
        },
        article: {
          themeId: "10",
          cookie: "authored-cookie",
          dependencies: store.imageDependencies,
        },
      },
      input = {
        previewThemeId: "7",
        summaryOptions: { sectionTypes: { "template--N__main": "main" } },
      };
    async function capture(prove = true) {
      const server = store.cartTransport({
        text: (epoch) => `1 ${epoch}`,
        sectionId: "template--123__main",
      });
      return driver.captureSeededCase("14-cart-with-items", input, {
        cart: {
          passwordCookie: "_shopify_essential=authored",
          fetcher: server.transport,
          authorize: async () => {},
        },
        capture: { ...store.captureAdapters, ...(prove ? { verifyThemeFiles: verifier } : {}) },
        shop: store.shop,
        imageProbes,
      });
    }
    return {
      prepared,
      info,
      files,
      store,
      driver,
      verifier,
      input,
      imageProbes,
      capture,
      close: async () => {
        await driver.close();
        await rm(directory, { recursive: true, force: true });
        await disposePreparedBenchmarkTheme(prepared);
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    await disposePreparedBenchmarkTheme(prepared);
    throw error;
  }
}
test("pinned-source preparation and full inventory checks issue challenge-bound proof and refuse changes, extra files, live themes and disposal", async () => {
  const source = await authoredBenchmark();
  try {
    const info = inspectPreparedBenchmarkTheme(source),
      files = await readComparisonThemeFiles(info.path),
      verify = createBenchmarkThemeVerifier(source, "7", async () => files),
      theme = {
        id: "gid://shopify/OnlineStoreTheme/7",
        role: "UNPUBLISHED" as const,
        processing: false,
        processingFailed: false,
      },
      receipt = await verify(theme, "fresh");
    assert.equal(inspectVerifiedBenchmarkThemeFiles(receipt, "fresh").filesHash, info.filesHash);
    assert.throws(() => inspectVerifiedBenchmarkThemeFiles(receipt, "stale"), {
      code: "unverified-files",
    });
    files["assets/extra.txt"] = "Unexpected upload";
    await assert.rejects(verify(theme, "next"), { code: "files-mismatch" });
    delete files["assets/extra.txt"];
    await assert.rejects(verify({ ...theme, role: "MAIN" }), { code: "files-mismatch" });
    await disposePreparedBenchmarkTheme(source);
    await assert.rejects(verify(theme), { code: "unverified-source" });
  } finally {
    await disposePreparedBenchmarkTheme(source);
  }
});
test("only theme-bound case receipts become hash-only goldens, and exact private snapshots replay observed IDs and Native clock without source overlays", async () => {
  const h = await harness();
  let archive = "";
  try {
    const receipt = await h.capture(),
      record = inspectVerifiedOracleCase(receipt),
      golden = makeGoldenArtifact(receipt);
    assert.equal(golden.theme, h.info.pin.name);
    assert.equal(golden.themeCommit, h.info.pin.commit);
    assert.equal(golden.themeFilesHash, h.info.filesHash);
    assert.equal(golden.caseSnapshotHash, record.snapshotHash);
    assert.equal(JSON.stringify(golden).includes("authored-demo"), false);
    assert.equal(Object.hasOwn(golden, "privateRawHtml"), false);
    const saved = await savePrivateCaseArchive([receipt]);
    archive = saved.directory;
    const key = `${golden.theme}/${golden.caseId}`,
      restored = await readCaseSnapshots(
        saved.manifest,
        new Map([[key, golden]]),
        record.baseFixtureHash,
      ),
      snapshot = restored.get(key);
    assert.ok(snapshot);
    assert.deepEqual(snapshot, record.snapshot);
    assert.equal(snapshot.meta.now, golden.capturedAt);
    assert.deepEqual(snapshot.scenarios, {});
    await compareGoldenCase(new NodeThemeFileSystem(h.info.path), golden, snapshot);
    await assert.rejects(
      compareGoldenCase(new NodeThemeFileSystem(h.info.path), golden, h.store.snapshot),
      /fingerprint/,
    );
    await assert.rejects(savePrivateCaseArchive([receipt, receipt]), { code: "duplicate-case" });
    assert.throws(() => makeGoldenArtifact(JSON.parse(JSON.stringify(receipt))), {
      code: "unverified-case",
    });
  } finally {
    if (archive) await rm(archive, { recursive: true, force: true });
    await h.close();
  }
});
test("case archive rejects changed data, mismatched metadata, path escapes and publicly readable snapshots", async () => {
  const h = await harness();
  let archive = "";
  try {
    const receipt = await h.capture(),
      record = inspectVerifiedOracleCase(receipt),
      golden = makeGoldenArtifact(receipt),
      saved = await savePrivateCaseArchive([receipt]);
    archive = saved.directory;
    const goldens = new Map([[`${golden.theme}/${golden.caseId}`, golden]]),
      manifest = await readFile(saved.manifest, "utf8"),
      entry = JSON.parse(manifest).entries[0],
      file = join(saved.directory, entry.snapshotFile),
      original = await readFile(file, "utf8");
    const changed = JSON.parse(original);
    changed.shop.name = "Different input";
    await writeFile(file, JSON.stringify(changed));
    await assert.rejects(readCaseSnapshots(saved.manifest, goldens, record.baseFixtureHash), {
      code: "snapshot-mismatch",
    });
    await writeFile(file, original);
    await chmod(file, 0o644);
    await assert.rejects(readCaseSnapshots(saved.manifest, goldens, record.baseFixtureHash), {
      code: "unsafe-path",
    });
    await chmod(file, 0o600);
    const wrong = JSON.parse(manifest);
    wrong.entries[0].snapshotFile = "../../outside.json";
    await writeFile(saved.manifest, JSON.stringify(wrong));
    await assert.rejects(readCaseSnapshots(saved.manifest, goldens, record.baseFixtureHash));
    await writeFile(saved.manifest, manifest);
    await assert.rejects(readCaseSnapshots(saved.manifest, new Map(), record.baseFixtureHash), {
      code: "invalid-archive",
    });
    await assert.rejects(readCaseSnapshots(saved.manifest, goldens, "0".repeat(64)), {
      code: "invalid-archive",
    });
  } finally {
    if (archive) await rm(archive, { recursive: true, force: true });
    await h.close();
  }
});
test("a valid data case without pinned theme evidence remains ineligible, and a cached theme check cannot satisfy a new capture challenge", async () => {
  const h = await harness();
  try {
    const ordinary = await h.capture(false);
    assert.throws(() => makeGoldenArtifact(ordinary), /Pinned uploaded theme evidence/);
    const proof = await h.verifier(
        {
          id: "gid://shopify/OnlineStoreTheme/7",
          role: "UNPUBLISHED",
          processing: false,
          processingFailed: false,
        },
        "old",
      ),
      server = h.store.cartTransport({
        text: (epoch) => `1 ${epoch}`,
        sectionId: "template--123__main",
      });
    await assert.rejects(
      h.driver.captureSeededCase("01-home-default", h.input, {
        cart: {
          passwordCookie: "_shopify_essential=authored",
          fetcher: server.transport,
          authorize: async () => {},
        },
        capture: { ...h.store.captureAdapters, verifyThemeFiles: async () => proof },
        shop: h.store.shop,
        imageProbes: h.imageProbes,
      }),
    );
  } finally {
    await h.close();
  }
});
test("source preparation refuses HTTP errors, redirected and malformed archives", async () => {
  await assert.rejects(authoredBenchmark("dawn", true), { code: "invalid-archive" });
  await assert.rejects(
    preparePinnedBenchmarkTheme("dawn", async () => new Response("unavailable", { status: 503 })),
    { code: "source-unavailable" },
  );
  await assert.rejects(
    preparePinnedBenchmarkTheme("dawn", async () =>
      Response.redirect("https://example.invalid/", 302),
    ),
    { code: "source-unavailable" },
  );
  await assert.rejects(
    preparePinnedBenchmarkTheme("dawn", async () => new Response("not a gzip archive")),
    { code: "invalid-archive" },
  );
});
