import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { NodeThemeFileSystem } from "../../packages/theme/src/node.js";
import { type OracleTheme, oracleThemeSchema } from "./admin-read.js";
import { type CorpusFiles, corpusFilesFingerprint } from "./corpus-environment.js";
import { instrumentTheme } from "./instrument-theme.js";

const exec = promisify(execFile),
  themeName = z.enum(["dawn", "horizon"]);
const pinSchema = z.strictObject({
  name: themeName,
  repo: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
export class BenchmarkThemeError extends Error {
  constructor(
    readonly code:
      | "invalid-pin"
      | "source-unavailable"
      | "invalid-archive"
      | "unverified-source"
      | "files-mismatch"
      | "unverified-files",
  ) {
    super(`Oracle benchmark theme failed: ${code}`);
    this.name = "BenchmarkThemeError";
  }
}
export interface PreparedBenchmarkTheme {
  readonly kind: "prepared-benchmark-theme";
}
interface ThemeRecord {
  pin: z.infer<typeof pinSchema>;
  archiveHash: string;
  filesHash: string;
  files: CorpusFiles;
  root: string;
  copy: string;
  closed: boolean;
}
const prepared = new WeakMap<PreparedBenchmarkTheme, ThemeRecord>();
const isThemePath = (path: string) =>
  /^(assets|blocks|config|layout|locales|sections|snippets|templates)\//.test(path);
export async function readComparisonThemeFiles(root: string): Promise<CorpusFiles> {
  const fs = new NodeThemeFileSystem(root),
    files: CorpusFiles = {};
  for (const path of await fs.listFiles())
    if (isThemePath(path)) files[path] = await fs.readBytes(path);
  return files;
}
export function inspectPreparedBenchmarkTheme(receipt: PreparedBenchmarkTheme) {
  const record = prepared.get(receipt);
  if (!record || record.closed) throw new BenchmarkThemeError("unverified-source");
  return {
    pin: structuredClone(record.pin),
    archiveHash: record.archiveHash,
    filesHash: record.filesHash,
    filePaths: Object.keys(record.files).sort(),
    path: record.copy,
  };
}
/** Downloads only the locked public source into OS temporary storage. Never uploads, publishes or executes downloaded scripts/instructions. */
export async function preparePinnedBenchmarkTheme(
  name: "dawn" | "horizon",
  fetcher: typeof fetch = fetch,
): Promise<PreparedBenchmarkTheme> {
  let pin: z.infer<typeof pinSchema>;
  try {
    themeName.parse(name);
    const pins = z
      .array(pinSchema)
      .length(2)
      .parse(JSON.parse(await readFile(new URL("../../benchmarks.json", import.meta.url), "utf8")));
    const found = pins.find((pin) => pin.name === name && pin.repo === `Shopify/${name}`);
    if (!found) throw new Error();
    pin = found;
  } catch {
    throw new BenchmarkThemeError("invalid-pin");
  }
  const root = await mkdtemp(join(tmpdir(), "sop-pinned-theme-"));
  let copy = "";
  try {
    const url = `https://codeload.github.com/${pin.repo}/tar.gz/${pin.commit}`,
      response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(120000) });
    if (!response.ok || response.redirected || (response.url && response.url !== url))
      throw new BenchmarkThemeError("source-unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new BenchmarkThemeError("source-unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 64 * 1024 * 1024) throw new BenchmarkThemeError("invalid-archive");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const compressed = Buffer.concat(chunks),
      archiveHash = createHash("sha256").update(compressed).digest("hex"),
      tar = join(root, "source.tar");
    await writeFile(tar, gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 }), {
      mode: 0o600,
    });
    const listing = await exec("tar", ["-tf", tar], { maxBuffer: 8 * 1024 * 1024 }),
      details = await exec("tar", ["-tvf", tar], { maxBuffer: 8 * 1024 * 1024 }),
      paths = listing.stdout.trim().split("\n");
    if (
      paths.length > 20000 ||
      !paths.length ||
      paths.some(
        (path) =>
          /[\\\r\n]/.test(path) ||
          path.includes(String.fromCharCode(0)) ||
          path.startsWith("/") ||
          path.split("/").some((part) => part === "." || part === "..") ||
          path.split("/")[0] !== `${name}-${pin.commit}`,
      ) ||
      details.stdout
        .trim()
        .split("\n")
        .some((line) => !line.startsWith("-") && !line.startsWith("d"))
    )
      throw new BenchmarkThemeError("invalid-archive");
    const source = join(root, "source");
    await mkdir(source);
    await exec("tar", ["-xf", tar, "--strip-components=1", "-C", source], {
      maxBuffer: 1024 * 1024,
    });
    const instrumented = await instrumentTheme(source, { captureContext: true });
    copy = instrumented.path;
    const files = await readComparisonThemeFiles(copy);
    if (!Object.keys(files).length) throw new BenchmarkThemeError("invalid-archive");
    const receipt: PreparedBenchmarkTheme = Object.freeze({ kind: "prepared-benchmark-theme" });
    prepared.set(receipt, {
      pin,
      archiveHash,
      filesHash: corpusFilesFingerprint(files),
      files,
      root,
      copy,
      closed: false,
    });
    return receipt;
  } catch (error) {
    if (copy) await rm(copy, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    if (error instanceof BenchmarkThemeError) throw error;
    throw new BenchmarkThemeError("invalid-archive");
  }
}
export async function disposePreparedBenchmarkTheme(receipt: PreparedBenchmarkTheme) {
  const record = prepared.get(receipt);
  if (!record || record.closed) return;
  record.closed = true;
  await rm(record.copy, { recursive: true, force: true });
  await rm(record.root, { recursive: true, force: true });
}
export interface VerifiedBenchmarkThemeFiles {
  readonly kind: "verified-benchmark-theme-files";
}
export interface BenchmarkThemeBinding {
  themeId: string;
  theme: "dawn" | "horizon";
  themeCommit: string;
  archiveHash: string;
  filesHash: string;
}
interface FileRecord extends BenchmarkThemeBinding {
  challenge: string | undefined;
}
const verified = new WeakMap<VerifiedBenchmarkThemeFiles, FileRecord>();
export function inspectVerifiedBenchmarkThemeFiles(
  receipt: VerifiedBenchmarkThemeFiles,
  challenge: string | undefined,
): BenchmarkThemeBinding {
  const record = verified.get(receipt);
  if (!record || record.challenge !== challenge) throw new BenchmarkThemeError("unverified-files");
  const { challenge: _challenge, ...binding } = record;
  return structuredClone(binding);
}
/** Every call rereads the complete uploaded inventory; a fresh capture challenge binds that read to the guarded HTML request. */
export function createBenchmarkThemeVerifier(
  receipt: PreparedBenchmarkTheme,
  themeId: string,
  readAllFiles: (themeId: string) => Promise<CorpusFiles>,
) {
  const record = prepared.get(receipt);
  if (!record || record.closed || !/^[1-9]\d*$/.test(themeId))
    throw new BenchmarkThemeError("unverified-source");
  return async (theme: OracleTheme, challenge?: string): Promise<VerifiedBenchmarkThemeFiles> => {
    if (record.closed) throw new BenchmarkThemeError("unverified-source");
    const observed = oracleThemeSchema.parse(theme);
    if (
      observed.id !== `gid://shopify/OnlineStoreTheme/${themeId}` ||
      observed.role !== "UNPUBLISHED" ||
      observed.processing ||
      observed.processingFailed
    )
      throw new BenchmarkThemeError("files-mismatch");
    if (corpusFilesFingerprint(await readAllFiles(themeId)) !== record.filesHash)
      throw new BenchmarkThemeError("files-mismatch");
    const proof: VerifiedBenchmarkThemeFiles = Object.freeze({
      kind: "verified-benchmark-theme-files",
    });
    verified.set(proof, {
      themeId,
      theme: record.pin.name,
      themeCommit: record.pin.commit,
      archiveHash: record.archiveHash,
      filesHash: record.filesHash,
      challenge,
    });
    return proof;
  };
}
