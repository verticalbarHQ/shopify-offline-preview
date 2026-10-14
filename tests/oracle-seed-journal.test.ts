import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  openOracleSeedJournal,
  SeedJournalError,
  seedJournalFingerprint,
} from "../tools/oracle/seed-journal.js";

const scope = seedJournalFingerprint({ authored: true }),
  intent = seedJournalFingerprint({
    task: "authored",
    signedUrl: "never-store-this",
    token: "never-store-that",
  }),
  code = (expected: string) => (error: unknown) =>
    error instanceof SeedJournalError && error.code === expected;
async function directory() {
  return realpath(await mkdtemp(join(tmpdir(), "sop-seed-journal-")));
}

test("journal syncs a pending hash before work and preserves completed replay suppression across close/reopen", async () => {
  const dir = await directory();
  try {
    const journal = await openOracleSeedJournal(dir, scope);
    await assert.rejects(openOracleSeedJournal(dir, scope), code("locked"));
    await journal.begin(intent);
    const state = JSON.parse(await readFile(join(dir, "seed-run.json"), "utf8"));
    assert.equal(state.pending, intent);
    assert.equal(journal.status(), "recovery-required");
    await journal.settle(intent, "verified");
    assert.equal(journal.status(), "accepting-intents");
    assert.equal((await lstat(join(dir, "seed-run.json"))).mode & 0o777, 0o600);
    await journal.close();
    await assert.rejects(journal.begin(intent), code("closed"));
    const reopened = await openOracleSeedJournal(dir, scope);
    try {
      await assert.rejects(reopened.begin(intent), code("duplicate-operation"));
      const raw = await readFile(join(dir, "seed-run.json"), "utf8");
      assert.equal(/never-store-this|never-store-that|signedUrl|token/.test(raw), false);
      assert.deepEqual(JSON.parse(raw).completed, [intent]);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unresolved intents survive a graceful shutdown; only proven pre-dispatch rejection can clear an intent", async () => {
  const dir = await directory();
  try {
    let journal = await openOracleSeedJournal(dir, scope);
    await journal.begin(intent);
    await journal.settle(intent, "not-dispatched");
    await journal.begin(intent);
    await journal.close();
    journal = await openOracleSeedJournal(dir, scope);
    assert.equal(journal.status(), "recovery-required");
    await assert.rejects(journal.settle(intent, "not-dispatched"), code("invalid-input"));
    await assert.rejects(
      journal.begin(seedJournalFingerprint("another")),
      code("recovery-required"),
    );
    await journal.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual process exit leaves a stale lock and pending intent; fresh process never steals or replays it", async () => {
  const dir = await directory();
  try {
    const module = new URL("../tools/oracle/seed-journal.ts", import.meta.url).href,
      child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        import {openOracleSeedJournal} from ${JSON.stringify(module)};
        const journal = await openOracleSeedJournal(process.argv[1], process.argv[2]);
        await journal.begin(process.argv[3]);
        process.exit(23);
      `,
          dir,
          scope,
          intent,
        ],
        { encoding: "utf8", timeout: 20000 },
      );
    assert.equal(child.status, 23, child.stderr);
    assert.equal(JSON.parse(await readFile(join(dir, "seed-run.json"), "utf8")).pending, intent);
    await assert.rejects(openOracleSeedJournal(dir, scope), code("locked"));
    assert.equal((await lstat(join(dir, "seed-run.lock"))).isFile(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scope changes, malformed state, unsafe permissions, links and active replacement fail without overwriting prior state", async () => {
  const dir = await directory();
  try {
    let journal = await openOracleSeedJournal(dir, scope);
    await journal.close();
    const path = join(dir, "seed-run.json"),
      original = await readFile(path, "utf8");
    await assert.rejects(
      openOracleSeedJournal(dir, seedJournalFingerprint("other")),
      code("scope-mismatch"),
    );
    assert.equal(await readFile(path, "utf8"), original);
    await writeFile(path, "not-json");
    await assert.rejects(openOracleSeedJournal(dir, scope), code("invalid-journal"));
    await writeFile(path, original);
    await chmod(path, 0o644);
    await assert.rejects(openOracleSeedJournal(dir, scope), code("invalid-journal"));
    await chmod(path, 0o600);
    await link(path, join(dir, "hardlink"));
    await assert.rejects(openOracleSeedJournal(dir, scope), code("invalid-journal"));
    await rm(join(dir, "hardlink"));
    journal = await openOracleSeedJournal(dir, scope);
    await writeFile(path, "changed-after-open");
    await assert.rejects(journal.begin(intent), code("journal-unavailable"));
    assert.equal(journal.status(), "recovery-required");
    assert.equal(await readFile(path, "utf8"), "changed-after-open");
    await journal.close();
    await rm(path);
    await writeFile(join(dir, "target"), original, { mode: 0o600 });
    await symlink(join(dir, "target"), path);
    await assert.rejects(openOracleSeedJournal(dir, scope), code("invalid-journal"));
    await symlink(dir, join(dir, "alias"));
    await assert.rejects(
      openOracleSeedJournal(join(dir, "alias"), scope),
      code("unsafe-directory"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fingerprints sort dictionary keys without changing array semantics or storing source values", () => {
  assert.equal(
    seedJournalFingerprint({ z: 1, a: { b: 2, a: 3 } }),
    seedJournalFingerprint({ a: { a: 3, b: 2 }, z: 1 }),
  );
  assert.notEqual(seedJournalFingerprint([1, 2]), seedJournalFingerprint([2, 1]));
});
