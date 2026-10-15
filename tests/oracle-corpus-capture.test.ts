import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureContextSnippet, captureContextSource } from "../tools/oracle/capture-context.js";
import {
  inspectVerifiedOracleCase,
  inspectVerifiedOracleCorpusCase,
} from "../tools/oracle/case-capture.js";
import {
  inspectCorpusCapture,
  replayCorpusCapture,
  saveVerifiedCorpusCapture,
} from "../tools/oracle/corpus-capture.js";
import {
  inspectPreparedCorpusRequest,
  prepareCorpusRequest,
} from "../tools/oracle/corpus-request.js";
import {
  inspectPreparedFilterCorpus,
  preparePinnedFilterCorpus,
  readPreparedFilterCorpusFiles,
} from "../tools/oracle/corpus-source.js";
import { snapshotFingerprint } from "../tools/oracle/matrix.js";
import { openOracleSeedStateDriver } from "../tools/oracle/seed-state-driver.js";
import {
  allContracts,
  compactCaseStore,
  config,
  locationId,
  publication,
  shopId,
} from "./helpers/case-store.js";

// Genuine opaque runtime receipts over entirely authored HTTP/CLI responses. Never live Native evidence.
const generated: { id: string; path: string }[] = JSON.parse(
  await readFile(new URL("../packages/spec/src/generated/corpus.json", import.meta.url), "utf8"),
);
const mapped = (path: string) =>
  path.startsWith("/products/")
    ? "/products/sop-matrix-needle"
    : path.startsWith("/collections/")
      ? "/collections/sop-catalog"
      : path.startsWith("/pages/")
        ? "/pages/about"
        : path.startsWith("/blogs/")
          ? path.split("/").length > 3
            ? "/blogs/news/story-1"
            : "/blogs/news"
          : path.startsWith("/search")
            ? "/search?q=Matrix%20Needle"
            : path;
const mapping = Object.fromEntries(generated.map((item) => [item.path, mapped(item.path)]));
const source = await preparePinnedFilterCorpus(mapping),
  info = inspectPreparedFilterCorpus(source),
  files = readPreparedFilterCorpusFiles(source);
const item = info.cases.find((item) => item.name === "escape" && item.fixturePath === "/");
assert.ok(item);
async function harness() {
  const store = compactCaseStore(),
    directory = await realpath(await mkdtemp(join(tmpdir(), "sop-corpus-context-")));
  const driver = await openOracleSeedStateDriver(
    config,
    store.snapshot,
    shopId,
    "authored",
    allContracts,
    store.assets,
    directory,
    {
      authorize: async () => {},
      fetcher: store.fetcher,
      readImage: store.readImage,
      uploadFetcher: async () => new Response(null, { status: 204 }),
      location: { kind: "Location", id: locationId },
      publication,
    },
  );
  await driver.runState(store.state.hash);
  const images = {
    product: { themeId: "8", cookie: "authored", dependencies: store.imageDependencies },
    collection: { themeId: "9", cookie: "authored", dependencies: store.imageDependencies },
    article: { themeId: "10", cookie: "authored", dependencies: store.imageDependencies },
  };
  function options(text: (epoch: string) => string, currentFiles = files) {
    const cart = store.cartTransport({ text });
    return {
      cart: {
        passwordCookie: "_shopify_essential=authored",
        fetcher: cart.transport,
        authorize: async () => {},
      },
      capture: { ...store.captureAdapters, readAllThemeFiles: async () => currentFiles },
      shop: store.shop,
      imageProbes: images,
    };
  }
  return {
    store,
    driver,
    options,
    close: async () => {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const input = { previewThemeId: "7", summaryOptions: { sectionTypes: { main: "main" } } };
function payload(id: string, output: string) {
  return `<script id="${id}" type="application/json">${JSON.stringify(Buffer.from(output).toString("base64"))}</script>`;
}

test("pinned corpus context source and requests bind the exact verified resource, query and fixture without clone capabilities", () => {
  assert.equal(files[captureContextSnippet], captureContextSource);
  for (const path of ["layout/theme.liquid", "layout/sop-corpus.liquid"])
    assert.ok(String(files[path]).includes("render 'sop-capture-context-v1'"));
  const store = compactCaseStore(),
    request = prepareCorpusRequest(
      config,
      shopId,
      store.snapshot,
      source,
      "01-home-default",
      item.id,
    );
  const scope = inspectPreparedCorpusRequest(request);
  assert.equal(scope.capturePath, item.requestPath);
  scope.item.requestPath = "/changed";
  assert.equal(inspectPreparedCorpusRequest(request).capturePath, item.requestPath);
  assert.throws(() => inspectPreparedCorpusRequest({ ...request }));
  assert.throws(() =>
    prepareCorpusRequest(config, shopId, store.snapshot, source, "02-product-default", item.id),
  );
  const search = info.cases.find((item) => item.fixturePath.startsWith("/search"));
  assert.ok(search);
  assert.doesNotThrow(() =>
    prepareCorpusRequest(config, shopId, store.snapshot, source, "11-search-default", search.id),
  );
  assert.throws(() =>
    prepareCorpusRequest(config, shopId, store.snapshot, source, "12-search-default", search.id),
  );
});
test("seeded corpus capture derives Native clock, calibrated fixture and output hashes, keeps private snapshot and cannot certify a benchmark", async () => {
  const h = await harness();
  let saved: string | undefined;
  try {
    const writes = h.store.counts().writes;
    const receipt = await h.driver.captureSeededCorpusCase(
      source,
      "01-home-default",
      item.id,
      input,
      h.options(() => payload(item.payloadId, "Authored expected &lt;output&gt;")),
    );
    const result = inspectCorpusCapture(source, receipt),
      record = inspectVerifiedOracleCorpusCase(receipt);
    assert.equal(result.observation.fixtureHash, snapshotFingerprint(result.snapshot));
    assert.notEqual(result.observation.fixtureHash, snapshotFingerprint(h.store.snapshot));
    assert.equal(result.observation.capturedAt, result.snapshot.meta.now);
    assert.equal(result.observation.specCommit, info.spec.commit);
    assert.equal(result.observation.requestPath, item.requestPath);
    assert.equal(result.privateOutputs[0], "Authored expected &lt;output&gt;");
    assert.equal(record.baseFixtureHash, h.store.plan.fixtureHash);
    assert.equal("theme" in record, false);
    assert.equal(h.store.counts().writes, writes);
    assert.throws(
      () =>
        inspectVerifiedOracleCase(
          receipt as unknown as Parameters<typeof inspectVerifiedOracleCase>[0],
        ),
      { code: "unverified-case" },
    );
    assert.throws(() => inspectVerifiedOracleCorpusCase({ ...receipt }), {
      code: "unverified-case",
    });
    result.snapshot.shop.name = "changed";
    assert.notEqual(inspectCorpusCapture(source, receipt).snapshot.shop.name, "changed");
    saved = await saveVerifiedCorpusCapture(source, receipt);
    for (const name of [
      "snapshot.json",
      "binding.json",
      "observation.json",
      "outputs.json",
      "1.html",
      "2.html",
    ])
      assert.equal((await stat(join(saved, name))).mode & 0o777, 0o600);
    assert.equal(
      snapshotFingerprint(JSON.parse(await readFile(join(saved, "snapshot.json"), "utf8"))),
      record.snapshotHash,
    );
    const replay = await replayCorpusCapture(source, receipt);
    assert.equal(replay.pass, false); // Arbitrary authored expected text must not pass just because its receipts are genuine.
    const other = await preparePinnedFilterCorpus({ ...mapping, "/": "/?page=2" });
    assert.throws(() => inspectCorpusCapture(other, receipt));
  } finally {
    if (saved) await rm(saved, { recursive: true, force: true });
    await h.close();
  }
});
test("fresh full uploaded inventory, context bytes and source receipts are required before corpus output can be retained", async () => {
  const h = await harness();
  try {
    const output = () => payload(item.payloadId, "Authored");
    for (const changed of [
      { ...files, "assets/unowned.js": "changed" },
      { ...files, [captureContextSnippet]: "changed" },
    ])
      await assert.rejects(
        h.driver.captureSeededCorpusCase(
          source,
          "01-home-default",
          item.id,
          input,
          h.options(output, changed),
        ),
      );
    await assert.rejects(
      h.driver.captureSeededCorpusCase(
        { ...source },
        "01-home-default",
        item.id,
        input,
        h.options(output),
      ),
    );
    const opts = h.options(output);
    opts.capture.readCaptureContextSource = async () => "changed";
    await assert.rejects(
      h.driver.captureSeededCorpusCase(source, "01-home-default", item.id, input, opts),
    );
    let reads = 0;
    const unstable = h.options(() => payload(item.payloadId, String(++reads)));
    const receipt = await h.driver.captureSeededCorpusCase(
      source,
      "01-home-default",
      item.id,
      input,
      unstable,
    );
    assert.throws(() => inspectCorpusCapture(source, receipt), /Unstable/);
  } finally {
    await h.close();
  }
});

test("authored escape and Native-clock date replay while nonempty-cart unsupported behavior still blocks", async () => {
  const h = await harness();
  try {
    const date = info.cases.find((item) => item.id === "filters/date/1"),
      plural = info.cases.find((item) => item.id === "filters/pluralize/0");
    assert.ok(date && plural);
    const dateText = (epoch: string) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: h.store.snapshot.shop.timezone,
        month: "long",
        day: "2-digit",
        year: "numeric",
      }).format(new Date(Number(epoch) * 1000));
    for (const example of [
      { item, base: "01-home-default", output: () => "&lt;p&gt;Text to be escaped.&lt;/p&gt;" },
      { item: date, base: "01-home-default", output: dateText },
      { item: plural, base: "14-cart-with-items", output: () => "Cart item count: 2 items" },
    ]) {
      const receipt = await h.driver.captureSeededCorpusCase(
        source,
        example.base,
        example.item.id,
        input,
        h.options((epoch) => payload(example.item.payloadId, example.output(epoch))),
      );
      const replay = await replayCorpusCapture(source, receipt);
      if (example.item === plural) {
        assert.equal(replay.pass, false);
        assert.ok(replay.diagnosticCodes.includes("not-implemented"));
      } else assert.equal(replay.pass, true, JSON.stringify(replay));
      assert.deepEqual(replay.harnessDiagnosticCodes, ["shopify-server-only"]);
      if (example.base === "14-cart-with-items")
        assert.equal(inspectCorpusCapture(source, receipt).snapshot.cart.lines.length, 2);
    }
  } finally {
    await h.close();
  }
});
