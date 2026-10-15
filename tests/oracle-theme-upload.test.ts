import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  disposePreparedBenchmarkTheme,
  inspectPreparedBenchmarkTheme,
  inspectVerifiedBenchmarkThemeFiles,
  readComparisonThemeFiles,
} from "../tools/oracle/benchmark-theme.js";
import { corpusFilesFingerprint } from "../tools/oracle/corpus-environment.js";
import {
  openOracleBenchmarkUploader,
  type ThemeUploadDependencies,
} from "../tools/oracle/theme-upload.js";
import { authoredBenchmark } from "./helpers/benchmark-archive.js";
import { config, shopId } from "./helpers/case-store.js";

// Authored tarball/API/CLI only. Never invokes the real Shopify CLI or grants real upload authorization.
async function fixture() {
  const prepared = await authoredBenchmark(),
    info = inspectPreparedBenchmarkTheme(prepared),
    files = await readComparisonThemeFiles(info.path),
    directory = await realpath(await mkdtemp(join(tmpdir(), "sop-upload-journal-")));
  let calls = 0,
    authorizations = 0,
    identities = 0,
    stage = "",
    deny = false,
    marker = true;
  const theme = {
      id: "gid://shopify/OnlineStoreTheme/7",
      role: "UNPUBLISHED",
      processing: false,
      processingFailed: false,
    },
    dependencies: ThemeUploadDependencies = {
      authorize: async (context) => {
        authorizations++;
        assert.equal(context.domain, config.domain);
        assert.equal(context.shopId, shopId);
        assert.equal(context.filesHash, info.filesHash);
        if (deny) throw new Error("authored private authorization detail");
      },
      readIdentity: async () => {
        identities++;
        return {
          id: shopId,
          myshopifyDomain: config.domain,
          name: "Authored",
          currencyCode: "USD",
          ianaTimezone: "UTC",
          plan: { partnerDevelopment: true },
          metafield: marker ? { value: "true" } : null,
        };
      },
      readTheme: async (id) => {
        assert.equal(id, "7");
        return theme;
      },
      readAllFiles: async (id) => {
        assert.equal(id, "7");
        return files;
      },
      runCli: async (command) => {
        calls++;
        stage = command.cwd;
        assert.deepEqual(command.args, [
          "theme",
          "push",
          "--unpublished",
          "--theme",
          `SOP-dawn-${info.pin.commit.slice(0, 12)}-${info.filesHash.slice(0, 12)}`,
          "--store",
          config.domain,
          "--path",
          stage,
          "--json",
          "--no-input",
          "--no-color",
        ]);
        assert.equal(corpusFilesFingerprint(await readComparisonThemeFiles(stage)), info.filesHash);
        for (const name of ["shopify.theme.toml", ".env", "AGENTS.md"])
          await assert.rejects(stat(join(stage, name)), { code: "ENOENT" });
        return JSON.stringify({ theme: { id: 7, role: "unpublished", shop: config.domain } });
      },
    };
  const open = () => openOracleBenchmarkUploader(config, shopId, prepared, directory, dependencies);
  return {
    prepared,
    info,
    files,
    directory,
    theme,
    dependencies,
    open,
    counts: () => ({ calls, authorizations, identities, stage }),
    deny: (value: boolean) => {
      deny = value;
    },
    marker: (value: boolean) => {
      marker = value;
    },
    close: async () => {
      await disposePreparedBenchmarkTheme(prepared);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("authorized unpublished upload verifies exact files, saves private metadata and prevents a duplicate after reopen", async () => {
  const f = await fixture(),
    uploader = await f.open();
  try {
    for (const name of ["shopify.theme.toml", ".env", "AGENTS.md"])
      await writeFile(join(f.info.path, name), "authored unwanted root configuration");
    const result = await uploader.push();
    assert.equal(result.themeId, "7");
    assert.equal(f.counts().calls, 1);
    assert.equal(f.counts().authorizations, 1);
    await assert.rejects(stat(f.counts().stage), { code: "ENOENT" });
    const record = JSON.parse(await readFile(join(f.directory, "theme-upload.json"), "utf8"));
    assert.equal(record.themeId, "7");
    assert.equal(record.filesHash, f.info.filesHash);
    assert.equal((await stat(join(f.directory, "theme-upload.json"))).mode & 0o777, 0o600);
    const proof = await result.verifyThemeFiles(f.theme, "fresh-capture");
    assert.equal(
      inspectVerifiedBenchmarkThemeFiles(proof, "fresh-capture").filesHash,
      f.info.filesHash,
    );
    await assert.rejects(uploader.push(), { code: "duplicate-operation" });
    await uploader.close();
    const reopened = await f.open();
    try {
      await assert.rejects(reopened.push(), { code: "duplicate-operation" });
    } finally {
      await reopened.close();
    }
    assert.equal(f.counts().calls, 1);
    assert.equal(f.counts().authorizations, 1);
    await disposePreparedBenchmarkTheme(f.prepared);
    await assert.rejects(result.verifyThemeFiles(f.theme), { code: "unverified-source" });
  } finally {
    await uploader.close();
    await f.close();
  }
});
test("pre-dispatch denial and changed source/store clear only their unexecuted intent; a clean authorized attempt can follow", async () => {
  const f = await fixture(),
    uploader = await f.open();
  try {
    f.deny(true);
    await assert.rejects(uploader.push(), { code: "precondition-failed" });
    f.deny(false);
    f.marker(false);
    await assert.rejects(uploader.push(), { code: "precondition-failed" });
    f.marker(true);
    const path = join(f.info.path, "sections/main.liquid"),
      original = await readFile(path);
    await writeFile(path, "changed");
    await assert.rejects(uploader.push(), { code: "precondition-failed" });
    assert.equal(f.counts().calls, 0);
    await writeFile(path, original);
    await uploader.push();
    assert.equal(f.counts().calls, 1);
  } finally {
    await uploader.close();
    await f.close();
  }
});
test("a dispatched lost, invalid, live or changed-file outcome remains pending through reopen without another CLI call", async () => {
  for (const failure of ["lost", "invalid", "wrong-shop", "unsafe-id", "live", "files"]) {
    const f = await fixture();
    let dispatched = 0;
    f.dependencies.runCli = async () => {
      dispatched++;
      if (failure === "lost") throw new Error("authored private token detail");
      if (failure === "invalid") return "invalid output with authored private token";
      return JSON.stringify({
        theme: {
          id: failure === "unsafe-id" ? 9007199254740992 : 7,
          role: "unpublished",
          shop: failure === "wrong-shop" ? "other.myshopify.com" : config.domain,
        },
      });
    };
    if (failure === "live") f.theme.role = "MAIN";
    if (failure === "files") f.files["sections/main.liquid"] = "changed";
    const uploader = await f.open();
    try {
      await assert.rejects(
        uploader.push(),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "Oracle theme upload failed: upload-unverified",
      );
      await assert.rejects(uploader.push(), { code: "recovery-required" });
      await uploader.close();
      const reopened = await f.open();
      try {
        await assert.rejects(reopened.push(), { code: "recovery-required" });
      } finally {
        await reopened.close();
      }
      assert.equal(dispatched, 1);
    } finally {
      await uploader.close();
      await f.close();
    }
  }
});
test("an active upload excludes another push/close and still requires fresh final store verification", async () => {
  const f = await fixture();
  let release = () => {},
    entered = () => {};
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    hold = new Promise<void>((r) => {
      release = r;
    });
  const run = f.dependencies.runCli;
  assert.ok(run);
  f.dependencies.runCli = async (command) => {
    entered();
    await hold;
    return run(command);
  };
  const uploader = await f.open();
  try {
    const pending = uploader.push();
    await ready;
    await assert.rejects(uploader.push(), { code: "concurrent-operation" });
    await assert.rejects(uploader.close(), { code: "concurrent-operation" });
    f.marker(false);
    release();
    await assert.rejects(pending, { code: "upload-unverified" });
    assert.equal(f.counts().calls, 1);
  } finally {
    release();
    await uploader.close();
    await f.close();
  }
});
test("the actual child-process adapter strips inherited Shopify flags and uses only isolated staging files", async () => {
  const f = await fixture(),
    executable = join(f.directory, "shopify"),
    oldPath = process.env.PATH,
    oldPublish = process.env.SHOPIFY_FLAG_PUBLISH;
  const script = `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(Object.keys(process.env).some(k=>k.startsWith('SHOPIFY_FLAG_')))process.exit(8);if(!a.includes('--unpublished')||!a.includes('--no-input')||a.includes('--publish')||a.includes('--live'))process.exit(9);if(fs.existsSync('shopify.theme.toml')||process.cwd()!==a[a.indexOf('--path')+1])process.exit(10);process.stdout.write(JSON.stringify({theme:{id:7,role:'unpublished',shop:${JSON.stringify(config.domain)}}}));\n`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.PATH = `${f.directory}:${oldPath ?? ""}`;
  process.env.SHOPIFY_FLAG_PUBLISH = "true";
  delete f.dependencies.runCli;
  const uploader = await f.open();
  try {
    assert.equal((await uploader.push()).themeId, "7");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldPublish === undefined) delete process.env.SHOPIFY_FLAG_PUBLISH;
    else process.env.SHOPIFY_FLAG_PUBLISH = oldPublish;
    await uploader.close();
    await f.close();
  }
});
