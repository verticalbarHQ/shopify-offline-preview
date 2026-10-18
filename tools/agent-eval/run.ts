/**
 * Report-only agent eval (SPEC §9.12). Each task runs in a fresh folder outside the repository that
 * holds a copy of the pinned Dawn theme and the package installed from npm. The agent gets the
 * task as a prompt and only the environment variables named with --env, so no store credentials
 * reach it. A check script then decides the result. Not part of CI.
 *
 *   pnpm agent:eval --package <npm spec or .tgz> --self-test
 *   pnpm agent:eval --package <spec> --agent '<shell command>' \
 *     [--env CODEX_HOME] [--tasks id,id] [--timeout-minutes 20] [--theme <dawn>] [--out <dir>]
 *
 * The agent command runs with `sh -c` in the task folder; $PROMPT_FILE names a file holding the
 * prompt. --theme defaults to the Dawn copy from `pnpm benchmarks:fetch`.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { type Context, type Task, tasks } from "./tasks.js";

const { values } = parseArgs({
  options: {
    theme: { type: "string" },
    package: { type: "string" },
    agent: { type: "string" },
    env: { type: "string", multiple: true, default: [] },
    tasks: { type: "string" },
    "timeout-minutes": { type: "string", default: "20" },
    out: { type: "string" },
    "self-test": { type: "boolean", default: false },
  },
});
if (!values.package || (!values["self-test"] && !values.agent)) {
  console.error("Usage: run.ts --package <spec> (--self-test | --agent <command>) [--theme <dir>]");
  process.exit(2);
}
const theme =
  values.theme ??
  z
    .array(z.object({ name: z.string(), path: z.string() }))
    .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")))
    .find((item) => item.name === "dawn")?.path;
if (!theme) throw new Error("No Dawn copy: run pnpm benchmarks:fetch or pass --theme");
const selected = values.tasks
  ? tasks.filter((task) => values.tasks?.split(",").includes(task.id))
  : tasks;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(values.out ?? join(".local/agent-eval", stamp));
await mkdir(out, { recursive: true });

// One untouched install for the checks, and the source of every workspace's node_modules.
const install = await mkdtemp(join(tmpdir(), "sop-agent-eval-package-"));
await writeFile(join(install, "package.json"), '{ "private": true }\n');
const npm = spawnSync(
  "npm",
  ["install", "--no-audit", "--no-fund", "--save-dev", resolvePackage(values.package)],
  { cwd: install, encoding: "utf8" },
);
if (npm.status !== 0) throw new Error(`npm install failed: ${npm.stderr}`);
const installed = join(install, "node_modules/@verticalbar/shopify-offline-preview");
const context: Context = {
  cli: join(installed, "dist/cli.js"),
  fixture: join(installed, "fixtures/default"),
  sourceTheme: resolve(theme),
};

function resolvePackage(spec: string): string {
  return spec.endsWith(".tgz") ? resolve(spec) : spec;
}

async function workspace(task: Task): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `sop-agent-eval-${task.id}-`));
  await cp(context.sourceTheme, join(dir, "theme"), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "node_modules"])
    await cp(join(install, name), join(dir, name), { recursive: true, verbatimSymlinks: true });
  await task.setup?.(dir, context);
  return dir;
}

const preamble = `You are in a Shopify theme project. The theme is in ./theme.
The offline preview tool @verticalbar/shopify-offline-preview is installed in this folder: run it with \`npx shopify-offline-preview\`. Its README is node_modules/@verticalbar/shopify-offline-preview/README.md.
There is no Shopify store, account or credential, and you must not try to reach one.
Work only inside this folder. Check your result with the preview tool before you finish.

Task: `;

async function runAgent(task: Task, dir: string): Promise<{ seconds: number; exit: string }> {
  const prompt = join(dir, ".eval-prompt.txt");
  await writeFile(prompt, `${preamble}${task.prompt}\n`);
  const env: Record<string, string> = { PROMPT_FILE: prompt, TERM: "dumb" };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", ...values.env]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const log = await open(join(out, `${task.id}.log`), "w");
  const started = performance.now();
  const child = spawn("sh", ["-c", values.agent ?? ""], {
    cwd: dir,
    env,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  const stop = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {}
  };
  const limit = Number(values["timeout-minutes"]) * 60_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop("SIGTERM");
    setTimeout(() => stop("SIGKILL"), 10_000).unref();
  }, limit);
  const [code, signal] = (await once(child, "exit")) as [number | null, string | null];
  clearTimeout(timer);
  // The agent may leave a dev server or watcher running; stop its whole process group.
  stop("SIGTERM");
  await log.close();
  const seconds = Math.round((performance.now() - started) / 1000);
  return { seconds, exit: timedOut ? "timeout" : String(code ?? signal) };
}

interface Result {
  task: string;
  pass: boolean;
  seconds?: number;
  exit?: string;
  reason?: string;
  workspace: string;
}
const results: Result[] = [];
for (const task of selected) {
  const dir = await workspace(task);
  if (values["self-test"]) {
    const before = await task.check(dir, context);
    await task.reference(dir, context);
    const after = await task.check(dir, context);
    const reason = !before
      ? "the check passes before any change"
      : after
        ? `the reference solution fails: ${after}`
        : undefined;
    results.push({ task: task.id, pass: !reason, ...(reason ? { reason } : {}), workspace: dir });
  } else {
    const run = await runAgent(task, dir);
    const reason = await task.check(dir, context).catch((error: unknown) => String(error));
    results.push({
      task: task.id,
      pass: !reason,
      ...run,
      ...(reason ? { reason } : {}),
      workspace: dir,
    });
  }
  const last = results.at(-1);
  console.log(
    `${last?.pass ? "pass" : "FAIL"} ${task.id}${last?.seconds === undefined ? "" : ` ${last.seconds}s`}${last?.reason ? `: ${last.reason}` : ""}`,
  );
}
const passed = results.filter((result) => result.pass).length;
const report = {
  date: new Date().toISOString(),
  mode: values["self-test"] ? "self-test" : "agent",
  package: values.package,
  theme: context.sourceTheme,
  agent: values.agent ?? null,
  passed,
  total: results.length,
  results,
};
await writeFile(join(out, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${passed}/${results.length} passed. Results: ${join(out, "results.json")}`);
