import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  inspectPreparedSeedCheckpoint,
  type PreparedSeedCheckpoint,
} from "./seed-binding-ledger.js";
import { type SeedCheckpointData, seedCheckpointSchema } from "./seed-checkpoint-shape.js";

export interface StoredSeedCheckpoint {
  readonly kind: "stored-seed-checkpoint";
}
const storedCheckpoints = new WeakMap<StoredSeedCheckpoint, SeedCheckpointData>();
export function inspectStoredSeedCheckpoint(receipt: StoredSeedCheckpoint): SeedCheckpointData {
  const data = storedCheckpoints.get(receipt);
  if (!data) throw new SeedJournalError("invalid-journal");
  return structuredClone(data);
}

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  documentSchema = z.strictObject({
    version: z.literal(1),
    scope: digest,
    completed: z.array(digest).max(20000),
    pending: digest.nullable(),
    checkpoint: seedCheckpointSchema.optional(),
  });
type Document = z.infer<typeof documentSchema>;
const maxBytes = 2 * 1024 * 1024;
export class SeedJournalError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "unsafe-directory"
      | "locked"
      | "invalid-journal"
      | "scope-mismatch"
      | "journal-unavailable"
      | "journal-full"
      | "duplicate-operation"
      | "recovery-required"
      | "concurrent-operation"
      | "closed",
  ) {
    super(`Oracle seed journal failed: ${code}`);
    this.name = "SeedJournalError";
  }
}

/** A fingerprint, never an ownership, backup, authorization or execution receipt. */
export function seedJournalFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, entry: unknown) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? Object.fromEntries(
              Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : entry,
      ),
    )
    .digest("hex");
}

/** Private local write-ahead state. A stale lock or pending intent is never cleared automatically.
 * Checkpoints retain prior provenance; restoring bindings still requires fresh source and identity verification. */
export async function openOracleSeedJournal(directory: string, scope: string) {
  if (!isAbsolute(directory) || !digest.safeParse(scope).success)
    throw new SeedJournalError("invalid-input");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory
    )
      throw new Error();
  } catch {
    throw new SeedJournalError("unsafe-directory");
  }
  const lockPath = join(directory, "seed-run.lock"),
    path = join(directory, "seed-run.json");
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new SeedJournalError("locked");
  }
  try {
    await lock.writeFile("Oracle seed run lock. Never remove while a run is active.\n");
    await lock.sync();
  } catch {
    // Keep the uncertain lock on disk, but never leak its open descriptor.
    await lock.close().catch(() => {});
    throw new SeedJournalError("journal-unavailable");
  }
  const lockStat = await lock.stat();
  let closed = false,
    busy = false,
    failed = false,
    activeIntent: string | null = null,
    current: Document = { version: 1, scope, completed: [], pending: null },
    journalIdentity:
      | { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
      | undefined;
  async function syncDirectory() {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async function checkLock() {
    const stat = await lstat(lockPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.dev !== lockStat.dev ||
      stat.ino !== lockStat.ino ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error();
  }
  async function checkJournal() {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maxBytes ||
      (journalIdentity &&
        (stat.dev !== journalIdentity.dev ||
          stat.ino !== journalIdentity.ino ||
          stat.size !== journalIdentity.size ||
          stat.mtimeMs !== journalIdentity.mtimeMs ||
          stat.ctimeMs !== journalIdentity.ctimeMs))
    )
      throw new Error();
    return stat;
  }
  async function save(next: Document) {
    const temporary = join(directory, `seed-run-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await checkLock();
      if (journalIdentity) await checkJournal();
      const bytes = `${JSON.stringify(documentSchema.parse(next))}\n`;
      if (Buffer.byteLength(bytes) > maxBytes) throw new Error();
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      // The temporary file is on the same private filesystem as the destination.
      await rename(temporary, path);
      await syncDirectory();
      journalIdentity = await checkJournalAfterRename();
      current = structuredClone(next);
    } catch {
      failed = true;
      throw new SeedJournalError("journal-unavailable");
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  async function checkJournalAfterRename() {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error();
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  }
  async function release() {
    await checkLock();
    await unlink(lockPath);
    await syncDirectory();
  }
  try {
    await syncDirectory();
    try {
      journalIdentity = await checkJournal();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw new SeedJournalError("invalid-journal");
    }
    if (journalIdentity) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (stat.dev !== journalIdentity.dev || stat.ino !== journalIdentity.ino) throw new Error();
        current = documentSchema.parse(JSON.parse(await handle.readFile("utf8")));
        if (new Set(current.completed).size !== current.completed.length) throw new Error();
        if (current.pending && current.completed.includes(current.pending)) throw new Error();
      } catch {
        throw new SeedJournalError("invalid-journal");
      } finally {
        await handle.close();
      }
      if (current.scope !== scope) throw new SeedJournalError("scope-mismatch");
    } else await save(current);
  } catch (error) {
    await release().catch(() => {});
    await lock.close();
    if (error instanceof SeedJournalError) throw error;
    throw new SeedJournalError("journal-unavailable");
  }
  async function operation<T>(fn: () => Promise<T>): Promise<T> {
    if (closed) throw new SeedJournalError("closed");
    if (busy) throw new SeedJournalError("concurrent-operation");
    if (failed) throw new SeedJournalError("recovery-required");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }
  return {
    checkpoint(): StoredSeedCheckpoint | undefined {
      if (closed) throw new SeedJournalError("closed");
      if (busy) throw new SeedJournalError("concurrent-operation");
      if (failed || current.pending) throw new SeedJournalError("recovery-required");
      if (!current.checkpoint?.entries.length) return undefined;
      const receipt: StoredSeedCheckpoint = Object.freeze({ kind: "stored-seed-checkpoint" });
      storedCheckpoints.set(receipt, structuredClone(current.checkpoint));
      return receipt;
    },
    status: () =>
      closed
        ? ("closed" as const)
        : failed || current.pending
          ? ("recovery-required" as const)
          : ("accepting-intents" as const),
    begin: (intent: string) =>
      operation(async () => {
        if (!digest.safeParse(intent).success) throw new SeedJournalError("invalid-input");
        if (current.pending) throw new SeedJournalError("recovery-required");
        if (current.completed.includes(intent)) throw new SeedJournalError("duplicate-operation");
        if (current.completed.length >= 20000) {
          failed = true;
          throw new SeedJournalError("journal-full");
        }
        await save({ ...current, pending: intent });
        activeIntent = intent;
      }),
    settle: (
      intent: string,
      outcome: "verified" | "not-dispatched",
      checkpoint?: PreparedSeedCheckpoint,
    ) =>
      operation(async () => {
        if (
          activeIntent !== intent ||
          current.pending !== intent ||
          !["verified", "not-dispatched"].includes(outcome)
        )
          throw new SeedJournalError("invalid-input");
        await save({
          ...current,
          pending: null,
          completed: outcome === "verified" ? [...current.completed, intent] : current.completed,
          ...(checkpoint && outcome === "verified"
            ? { checkpoint: seedCheckpointSchema.parse(inspectPreparedSeedCheckpoint(checkpoint)) }
            : {}),
        });
        activeIntent = null;
      }),
    close: async () => {
      if (closed) return;
      if (busy) throw new SeedJournalError("concurrent-operation");
      closed = true;
      try {
        await release();
      } catch {
        throw new SeedJournalError("journal-unavailable");
      } finally {
        await lock.close();
      }
    },
  };
}
