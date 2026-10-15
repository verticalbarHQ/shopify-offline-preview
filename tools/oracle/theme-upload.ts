import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type OracleTheme, oracleThemeSchema } from "./admin-read.js";
import {
  createBenchmarkThemeVerifier,
  inspectPreparedBenchmarkTheme,
  type PreparedBenchmarkTheme,
  readComparisonThemeFiles,
} from "./benchmark-theme.js";
import { type CorpusFiles, corpusFilesFingerprint } from "./corpus-environment.js";
import { openOracleSeedJournal, seedJournalFingerprint } from "./seed-journal.js";
import {
  assertOracleStore,
  type OracleConfig,
  oracleConfigSchema,
  oracleIdentitySchema,
} from "./store-guard.js";

export class ThemeUploadError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "concurrent-operation"
      | "closed"
      | "precondition-failed"
      | "upload-unverified",
  ) {
    super(`Oracle theme upload failed: ${code}`);
    this.name = "ThemeUploadError";
  }
}
export interface ThemeUploadContext {
  domain: string;
  shopId: string;
  theme: "dawn" | "horizon";
  commit: string;
  filesHash: string;
}
export interface ThemePushCommand {
  args: readonly string[];
  cwd: string;
}
export interface ThemeUploadDependencies {
  /** Must verify actual backup/restoration, manual first wipe and explicit theme-upload approval. No default grant. */
  authorize(context: ThemeUploadContext): Promise<void>;
  readIdentity(): Promise<unknown>;
  readTheme(id: string): Promise<OracleTheme>;
  readAllFiles(id: string): Promise<CorpusFiles>;
  runCli?: (command: ThemePushCommand) => Promise<string>;
}

/** No shell, no credentials in argv, no inherited theme flags, and no interactive authentication. */
async function runCli(command: ThemePushCommand): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("SHOPIFY_FLAG_")),
  );
  const result = await promisify(execFile)("shopify", [...command.args], {
    cwd: command.cwd,
    env,
    timeout: 300000,
    maxBuffer: 256 * 1024,
  });
  return result.stdout;
}
const cliResult = z.object({
  theme: z.object({
    id: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()]),
    role: z.literal("unpublished"),
    shop: z.string(),
  }),
});

/** Uploads one prepared copy only after explicit authorization. Importing/opening this module performs no upload.
 * The private journal suppresses duplicate uploads across reopen. Any dispatched-but-unverified outcome stays
 * pending for operator recovery; this module never retries, publishes, deletes or adopts a theme automatically. */
export async function openOracleBenchmarkUploader(
  inputConfig: OracleConfig,
  shopId: string,
  prepared: PreparedBenchmarkTheme,
  directory: string,
  dependencies: ThemeUploadDependencies,
) {
  const config = oracleConfigSchema.parse(inputConfig),
    info = inspectPreparedBenchmarkTheme(prepared),
    {
      authorize,
      readIdentity,
      readTheme,
      readAllFiles,
      runCli: executeCli = runCli,
    } = dependencies;
  if (
    !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId) ||
    [authorize, readIdentity, readTheme, readAllFiles, executeCli].some(
      (value) => typeof value !== "function",
    )
  )
    throw new ThemeUploadError("invalid-input");
  const context: ThemeUploadContext = {
      domain: config.domain,
      shopId,
      theme: info.pin.name,
      commit: info.pin.commit,
      filesHash: info.filesHash,
    },
    scope = seedJournalFingerprint({
      version: 1,
      operation: "unpublished-benchmark-upload",
      config,
      shopId,
      pin: info.pin,
      filesHash: info.filesHash,
    }),
    journal = await openOracleSeedJournal(directory, scope);
  let busy = false,
    closed = false;
  async function guard() {
    const identity = oracleIdentitySchema.parse(await readIdentity());
    assertOracleStore(config, identity);
    if (identity.id !== shopId) throw new Error();
  }
  return {
    async push() {
      if (closed) throw new ThemeUploadError("closed");
      if (busy) throw new ThemeUploadError("concurrent-operation");
      busy = true;
      let stage = "",
        dispatched = false,
        intent: string | undefined;
      try {
        // Existing pending/completed records fail here before authorization, reads or a second CLI call.
        intent = await journal.begin(scope);
        try {
          inspectPreparedBenchmarkTheme(prepared);
          const files = await readComparisonThemeFiles(info.path);
          if (corpusFilesFingerprint(files) !== info.filesHash) throw new Error();
          stage = await realpath(await mkdtemp(join(tmpdir(), "sop-theme-upload-")));
          // Copy recognized theme files only. Exclude root .env, CLI config, ignore files and build scripts from CLI cwd.
          for (const [path, body] of Object.entries(files)) {
            await mkdir(dirname(join(stage, path)), { recursive: true, mode: 0o700 });
            await writeFile(join(stage, path), body, { mode: 0o600, flag: "wx" });
          }
          // A leftover outcome requires operator inspection, never another upload or overwrite.
          try {
            await lstat(join(directory, "theme-upload.json"));
            throw new Error("Existing outcome");
          } catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
              throw error;
          }
          await authorize(structuredClone(context));
          await guard();
          inspectPreparedBenchmarkTheme(prepared);
          if (
            corpusFilesFingerprint(await readComparisonThemeFiles(info.path)) !== info.filesHash ||
            corpusFilesFingerprint(await readComparisonThemeFiles(stage)) !== info.filesHash
          )
            throw new Error();
        } catch {
          await journal.settle(intent, "not-dispatched");
          throw new ThemeUploadError("precondition-failed");
        }
        const command: ThemePushCommand = {
          cwd: stage,
          args: [
            "theme",
            "push",
            "--unpublished",
            "--theme",
            `SOP-${info.pin.name}-${info.pin.commit.slice(0, 12)}-${info.filesHash.slice(0, 12)}`,
            "--store",
            config.domain,
            "--path",
            stage,
            "--json",
            "--no-input",
            "--no-color",
          ],
        };
        dispatched = true; // A thrown/aborted CLI call can already have created or partially uploaded a theme.
        const output = await executeCli(command);
        if (Buffer.byteLength(output) > 65536) throw new Error();
        const result = cliResult.parse(JSON.parse(output));
        if (result.theme.shop !== config.domain) throw new Error();
        const themeId = String(result.theme.id),
          verifier = createBenchmarkThemeVerifier(prepared, themeId, readAllFiles);
        await guard();
        await verifier(oracleThemeSchema.parse(await readTheme(themeId)));
        await guard();
        // Metadata only, written before completion. A crash between these writes keeps the pending barrier.
        const record = await open(join(directory, "theme-upload.json"), "wx", 0o600);
        try {
          await record.writeFile(
            `${JSON.stringify({ ...context, apiVersion: config.apiVersion, themeId, scope })}\n`,
          );
          await record.sync();
        } finally {
          await record.close();
        }
        await journal.settle(intent, "verified");
        return { themeId, verifyThemeFiles: verifier };
      } catch (error) {
        if (dispatched) throw new ThemeUploadError("upload-unverified");
        throw error;
      } finally {
        if (stage) await rm(stage, { recursive: true, force: true });
        busy = false;
      }
    },
    async close() {
      if (closed) return;
      if (busy) throw new ThemeUploadError("concurrent-operation");
      await journal.close();
      closed = true;
    },
  };
}
