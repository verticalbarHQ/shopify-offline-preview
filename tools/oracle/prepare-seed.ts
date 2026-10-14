import { mkdir, readFile, writeFile } from "node:fs/promises";
import { snapshotSchema } from "../../packages/data/src/schema.js";
import { buildOracleSeedPlan, readOracleSeedImages } from "./seed-plan.js";
import { oracleConfigSchema } from "./store-guard.js";

try {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--snapshot" ||
    !args[1] ||
    args[2] !== "--images" ||
    !args[3]
  )
    throw new Error("Invalid arguments");
  const config = oracleConfigSchema.parse(JSON.parse(await readFile(".local/oracle.json", "utf8")));
  const snapshot = snapshotSchema.parse(JSON.parse(await readFile(args[1], "utf8")));
  const plan = buildOracleSeedPlan(config, snapshot);
  const images = await readOracleSeedImages(plan, args[3]);
  await mkdir(".local/results", { recursive: true, mode: 0o700 });
  await writeFile(
    ".local/results/oracle-seed-plan.json",
    `${JSON.stringify({ ...plan, images }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  console.log(
    JSON.stringify({
      source: plan.source,
      fixtureHash: plan.fixtureHash,
      states: plan.states.length,
      requests: plan.requests.length,
      verifiedLocalImages: images.length,
      resources: Object.fromEntries(
        [...new Set(plan.states.flatMap((s) => s.tasks.map((t) => t.resource)))].map((kind) => [
          kind,
          plan.states.map((s) => s.tasks.filter((t) => t.resource === kind).length),
        ]),
      ),
      issues: plan.issues.map((issue) => issue.code),
      blockers: plan.blockers,
      executionReady: false,
      mutationsExecuted: 0,
    }),
  );
  if (plan.issues.length) process.exitCode = 2;
} catch {
  console.error("Seed preparation failed; invalid or inaccessible input. Source details withheld.");
  process.exitCode = 3;
}
