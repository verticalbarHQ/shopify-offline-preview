import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import type { GoldenArtifact } from "../tools/oracle/artifacts.js";
import {
  type BenchmarkPin,
  snapshotFingerprint,
  validateGoldenMatrix,
} from "../tools/oracle/matrix.js";

const pins: BenchmarkPin[] = [
  { name: "dawn", repo: "Shopify/dawn", commit: "a".repeat(40) },
  { name: "horizon", repo: "Shopify/horizon", commit: "b".repeat(40) },
];
const fixtureHash = "c".repeat(64);
// Explicitly synthetic validator inputs, never published as captures or implementation evidence.
function examples(): GoldenArtifact[] {
  return pins.flatMap((pin) =>
    benchmarkMatrix.map((page) => ({
      schemaVersion: "1.0",
      theme: pin.name,
      themeCommit: pin.commit,
      caseId: page.id,
      path: page.path,
      scenario: page.scenario,
      capturedAt: "2026-10-13T00:00:00Z",
      fixtureHash,
      doubleCaptureStable: true,
      summary: {
        schemaVersion: "1.0",
        tree: [{ kind: "section", type: "synthetic", children: [] }],
        sections: [{ id: "template--N__synthetic", textHash: "d".repeat(64), tokenCount: 1 }],
        markedBlockCount: 0,
      },
    })),
  );
}

test("golden matrix refuses absent, duplicate, wrongly pinned and mismatched request evidence", () => {
  assert.equal(validateGoldenMatrix(examples(), pins, fixtureHash).size, 36);
  assert.throws(() => validateGoldenMatrix([], pins, fixtureHash), /missing for 36/);
  assert.throws(
    () => validateGoldenMatrix(examples().slice(1), pins, fixtureHash),
    /missing for 1/,
  );
  const duplicate = examples();
  assert.ok(duplicate[0]);
  duplicate.push(duplicate[0]);
  assert.throws(() => validateGoldenMatrix(duplicate, pins, fixtureHash), /Duplicate/);
  for (const [property, value, pattern] of [
    ["themeCommit", "e".repeat(40), /pin mismatch/],
    ["fixtureHash", "f".repeat(64), /fixture mismatch/],
    ["path", "/wrong", /request matrix mismatch/],
    ["scenario", "wrong", /request matrix mismatch/],
    ["caseId", "unknown", /request matrix mismatch/],
    ["doubleCaptureStable", false, /Invalid input/],
  ] as const) {
    const changed = examples().map((item, index) =>
      index ? item : { ...item, [property]: value },
    );
    assert.throws(() => validateGoldenMatrix(changed, pins, fixtureHash), pattern);
  }
  const firstPin = pins[0];
  assert.ok(firstPin);
  assert.throws(
    () => validateGoldenMatrix(examples(), [firstPin, firstPin], fixtureHash),
    /distinct/,
  );
});

test("release validation checks every golden's freshness and refuses raw text fields", () => {
  assert.doesNotThrow(() =>
    validateGoldenMatrix(examples(), pins, fixtureHash, new Date("2026-10-20T00:00:00Z")),
  );
  const stale = examples().map((item, index) =>
    index === 35 ? { ...item, capturedAt: "2026-10-12T23:59:59Z" } : item,
  );
  assert.throws(
    () => validateGoldenMatrix(stale, pins, fixtureHash, new Date("2026-10-20T00:00:00Z")),
    /freshness/,
  );
  assert.throws(
    () => validateGoldenMatrix(examples(), pins, fixtureHash, new Date("2026-10-12T00:00:00Z")),
    /freshness/,
  );
  const raw = examples().map((item, index) =>
    index ? item : { ...item, privateRawHtml: "private" },
  );
  assert.throws(() => validateGoldenMatrix(raw, pins, fixtureHash), /Unrecognized key/);
});

test("snapshot fingerprints ignore object insertion order while retaining source values and array order", () => {
  const original = defaultFixture();
  const reordered = JSON.parse(
    JSON.stringify(original, (_key, value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ),
  );
  assert.equal(snapshotFingerprint(original), snapshotFingerprint(reordered));
  reordered.products.reverse();
  assert.notEqual(snapshotFingerprint(original), snapshotFingerprint(reordered));
  const changed = defaultFixture();
  changed.shop.name += " changed";
  assert.notEqual(snapshotFingerprint(original), snapshotFingerprint(changed));
});

test("summary metadata rejects empty trees, inconsistent block counts and duplicate section ids", () => {
  const first = examples()[0];
  assert.ok(first);
  for (const summary of [
    { ...first.summary, tree: [], sections: [] },
    { ...first.summary, markedBlockCount: 1 },
    {
      ...first.summary,
      tree: [...first.summary.tree, ...first.summary.tree],
      sections: [...first.summary.sections, ...first.summary.sections],
    },
  ]) {
    assert.throws(
      () =>
        validateGoldenMatrix(
          examples().map((item, index) => (index ? item : { ...item, summary })),
          pins,
          fixtureHash,
        ),
      /summary structure/,
    );
  }
});
