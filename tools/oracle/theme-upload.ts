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
import { type PreparedNativeImageProbe, prepareNativeImageProbe } from "./image-native.js";
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
export interface ThemeUploadDependencies<Context = ThemeUploadContext> {
  /** Must verify actual backup/restoration, manual first wipe and explicit theme-upload approval. No default grant. */
  authorize(context: Context): Promise<void>;
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

interface UploadIdentity {
  domain: string;
  shopId: string;
  filesHash: string;
}
export interface NativeImageProbeUploadContext extends UploadIdentity {
  probe: PreparedNativeImageProbe["kind"];
}
type FileReader = (id: string) => Promise<CorpusFiles>;

/** Prepared benchmark copies alone can return opaque benchmark proofs. Opening performs no upload. */
export async function openOracleBenchmarkUploader(
  inputConfig: OracleConfig,
  shopId: string,
  prepared: PreparedBenchmarkTheme,
  directory: string,
  dependencies: ThemeUploadDependencies,
) {
  const config = oracleConfigSchema.parse(inputConfig),
    info = inspectPreparedBenchmarkTheme(prepared);
  return openThemeUploader(
    config,
    shopId,
    directory,
    {
      context: {
        domain: config.domain,
        shopId,
        theme: info.pin.name,
        commit: info.pin.commit,
        filesHash: info.filesHash,
      },
      scope: {
        version: 1,
        operation: "unpublished-benchmark-upload",
        config,
        shopId,
        pin: info.pin,
        filesHash: info.filesHash,
      },
      name: `SOP-${info.pin.name}-${info.pin.commit.slice(0, 12)}-${info.filesHash.slice(0, 12)}`,
      readFiles: async () => {
        inspectPreparedBenchmarkTheme(prepared);
        return readComparisonThemeFiles(info.path);
      },
      createVerifier: (id: string, reader: FileReader) =>
        createBenchmarkThemeVerifier(prepared, id, reader),
    },
    dependencies,
  );
}

/** Only the built-in authored expressions for one image kind can be uploaded, never arbitrary caller files.
 * Probe verification returns void: it cannot certify a pinned benchmark or produce golden theme evidence. */
export async function openOracleNativeImageProbeUploader(
  inputConfig: OracleConfig,
  shopId: string,
  kind: PreparedNativeImageProbe["kind"],
  directory: string,
  dependencies: ThemeUploadDependencies<NativeImageProbeUploadContext>,
) {
  const config = oracleConfigSchema.parse(inputConfig),
    probe = prepareNativeImageProbe(kind);
  return openThemeUploader(
    config,
    shopId,
    directory,
    {
      context: { domain: config.domain, shopId, probe: kind, filesHash: probe.harnessHash },
      scope: {
        version: 1,
        operation: "unpublished-native-image-probe-upload",
        config,
        shopId,
        kind,
        filesHash: probe.harnessHash,
      },
      name: `SOP-native-image-${kind}-${probe.harnessHash.slice(0, 12)}`,
      readFiles: async () => structuredClone(probe.files),
      createVerifier: (id: string, reader: FileReader) => async (input: OracleTheme) => {
        const theme = oracleThemeSchema.parse(input);
        if (
          theme.id !== `gid://shopify/OnlineStoreTheme/${id}` ||
          theme.role !== "UNPUBLISHED" ||
          theme.processing ||
          theme.processingFailed ||
          corpusFilesFingerprint(await reader(id)) !== probe.harnessHash
        )
          throw new ThemeUploadError("upload-unverified");
      },
    },
    dependencies,
  );
}

/** Shared execution lane. Success/reopen suppress a second CLI invocation; unknown dispatched outcomes stay
 * pending. No automatic retry, adoption, publish, delete, recovery or default authorization. */
async function openThemeUploader<
  Context extends UploadIdentity,
  Verifier extends (theme: OracleTheme, challenge?: string) => Promise<unknown>,
>(
  inputConfig: OracleConfig,
  shopId: string,
  directory: string,
  source: {
    context: Context;
    scope: unknown;
    name: string;
    readFiles(): Promise<CorpusFiles>;
    createVerifier(id: string, reader: FileReader): Verifier;
  },
  dependencies: ThemeUploadDependencies<Context>,
) {
  const config = oracleConfigSchema.parse(inputConfig),
    context = source.context,
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
  const scope = seedJournalFingerprint(source.scope),
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
          const files = await source.readFiles();
          if (corpusFilesFingerprint(files) !== context.filesHash) throw new Error();
          stage = await realpath(await mkdtemp(join(tmpdir(), "sop-theme-upload-")));
          for (const folder of [
            "assets",
            "blocks",
            "config",
            "layout",
            "locales",
            "sections",
            "snippets",
            "templates",
          ])
            await mkdir(join(stage, folder), { mode: 0o700 });
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
          if (
            corpusFilesFingerprint(await source.readFiles()) !== context.filesHash ||
            corpusFilesFingerprint(await readComparisonThemeFiles(stage)) !== context.filesHash
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
            source.name,
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
          verifier = source.createVerifier(themeId, readAllFiles);
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
