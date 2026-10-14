import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { extractCorpusOutput, prepareCorpus } from "../tools/oracle/corpus.js";
import { snapshotFingerprint } from "../tools/oracle/matrix.js";
import { verifyCorpusObservation } from "../tools/oracle/verify-corpus.js";

async function sample(liquid = '{{ "<own input>" | escape }}', fixturePath = "/") {
  const snapshot = defaultFixture();
  const specCommit = "a".repeat(40);
  const prepared = prepareCorpus(
    [{ id: "filters/escape/0", kind: "filters", name: "escape", path: fixturePath, liquid }],
    { [fixturePath]: fixturePath },
  );
  const item = prepared.cases[0];
  assert.ok(item);
  const result = await renderTheme(new MemoryThemeFileSystem(prepared.files), item.requestPath, {
    snapshot,
  });
  const output = extractCorpusOutput(result.html, item);
  // Synthetic observations exercise the verifier only; they are never saved as native evidence.
  const observation = {
    schemaVersion: "1.0",
    source: "shopify-storefront",
    specCommit,
    fixtureHash: snapshotFingerprint(snapshot),
    harnessHash: item.harnessHash,
    caseId: item.id,
    name: item.name,
    originalInputHash: item.originalInputHash,
    preparedInputHash: item.preparedInputHash,
    requestPath: item.requestPath,
    capturedAt: "2026-10-14T00:00:00.000Z",
    doubleCaptureStable: true,
    outputHash: createHash("sha256").update(output).digest("hex"),
    outputBytes: Buffer.byteLength(output),
  };
  return { item, observation, context: { snapshot, specCommit } };
}

test("corpus verification binds the exact input, fixture, spec pin and request without returning raw output", async () => {
  const { item, observation, context } = await sample();
  const verified = await verifyCorpusObservation(item, observation, context);
  assert.equal(verified.pass, true);
  assert.equal(verified.outputEqual, true);
  assert.deepEqual(verified.diagnosticCodes, []);
  assert.ok(!JSON.stringify(verified).includes("own input"));
  const mismatch = await verifyCorpusObservation(
    item,
    { ...observation, outputHash: "b".repeat(64) },
    context,
  );
  assert.equal(mismatch.pass, false);
  assert.equal(mismatch.outputEqual, false);
  const wrongBytes = await verifyCorpusObservation(
    item,
    { ...observation, outputBytes: observation.outputBytes + 1 },
    context,
  );
  assert.equal(wrongBytes.pass, false);
});

test("changed capture provenance and prepared manifests are rejected before replay", async () => {
  const { item, observation, context } = await sample();
  for (const change of [
    { specCommit: "b".repeat(40) },
    { fixtureHash: "b".repeat(64) },
    { caseId: "filters/escape/1" },
    { name: "escape_once" },
    { originalInputHash: "b".repeat(64) },
    { preparedInputHash: "b".repeat(64) },
    { requestPath: "/?view=other" },
  ])
    await assert.rejects(
      verifyCorpusObservation(item, { ...observation, ...change }, context),
      /does not match/,
    );
  await assert.rejects(
    verifyCorpusObservation({ ...item, liquidSource: "changed" }, observation, context),
    /provenance/,
  );
  await assert.rejects(
    verifyCorpusObservation(item, { ...observation, doubleCaptureStable: false }, context),
  );
  await assert.rejects(
    verifyCorpusObservation(item, observation, {
      ...context,
      snapshot: { ...context.snapshot, shop: { ...context.snapshot.shop, name: "different" } },
    }),
    /does not match/,
  );
});

test("matching error and unsupported output hashes do not pass corpus conformance", async () => {
  for (const [liquid, path, code] of [
    ['{{ "product-1" | placeholder_svg_tag }}', "/", "missing-resource"],
    ['{{ "" | metafield_tag }}', "/", "not-implemented"],
    ["{{ nil | image_url }}", "/", "liquid-error"],
  ]) {
    const { item, observation, context } = await sample(liquid, path);
    const result = await verifyCorpusObservation(item, observation, context);
    assert.equal(result.outputEqual, true);
    assert.equal(result.pass, false);
    assert.ok(result.diagnosticCodes.includes(code ?? ""), JSON.stringify(result));
  }
});

test("an absent mapped fixture resource cannot produce a successful replay", async () => {
  const { observation, context } = await sample();
  const prepared = prepareCorpus(
    [
      {
        id: "filters/escape/0",
        kind: "filters",
        name: "escape",
        path: "/products/absent",
        liquid: '{{ "<own input>" | escape }}',
      },
    ],
    { "/products/absent": "/products/absent" },
  );
  const item = prepared.cases[0];
  assert.ok(item);
  await assert.rejects(
    verifyCorpusObservation(
      item,
      { ...observation, requestPath: item.requestPath, harnessHash: item.harnessHash },
      context,
    ),
    /Theme file not found: templates\/404/,
  );
});
