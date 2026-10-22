import { mkdir, readFile, writeFile } from "node:fs/promises";
import { completeSnapshotSchema as snapshotSchema } from "../../packages/data/src/schema.js";
import { buildOracleSeedPlan, readOracleSeedImages } from "./seed-plan.js";
import { compileSeedPublication, compileSeedTask } from "./seed-requests.js";
import { validateSeedRequestTemplate } from "./seed-schema.js";
import { oracleConfigSchema } from "./store-guard.js";

try {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--snapshot" ||
    !args[1] ||
    args[2] !== "--images" ||
    !args[3] ||
    args[4] !== "--admin-schema" ||
    !args[5]
  )
    throw new Error("Invalid arguments");
  const config = oracleConfigSchema.parse(JSON.parse(await readFile(".local/oracle.json", "utf8")));
  const snapshot = snapshotSchema.parse(JSON.parse(await readFile(args[1], "utf8")));
  const schema: unknown = JSON.parse(await readFile(args[5], "utf8"));
  const plan = buildOracleSeedPlan(config, snapshot);
  if (plan.issues.length) throw new Error("Source preparation has unresolved issues");
  const images = await readOracleSeedImages(plan, args[3]);
  let checked = 0;
  const states = plan.states.map((state) => ({
    hash: state.hash,
    tasks: state.tasks.map((task) => {
      const image = images.find((i) => i.file === task.identity[0]);
      const create = compileSeedTask(task, {
        mode: "create",
        ...(image ? { imageBytes: image.bytes } : {}),
      });
      const update =
        task.resource === "collection" ? null : compileSeedTask(task, { mode: "update" });
      const publication =
        task.resource === "product" || task.resource === "collection"
          ? compileSeedPublication(
              task.resource === "product" ? "Product" : "Collection",
              task.identity[0] ?? "",
            )
          : null;
      for (const template of [
        ...create,
        ...(update ?? []),
        ...(publication ? [publication] : []),
      ]) {
        checked++;
        if (validateSeedRequestTemplate(template, schema).length)
          throw new Error("Admin input contract mismatch");
      }
      return {
        key: task.key,
        sourceHash: task.sourceHash,
        dependencies: task.dependencies,
        create,
        update,
        publication,
        additionalRequirements:
          task.resource === "collection"
            ? [
                "observed-owned-source-and-membership-for-update",
                "observed-final-order-for-reorder",
                "reorder-job-completion",
              ]
            : [],
      };
    }),
  }));
  await mkdir(".local/results", { recursive: true, mode: 0o700 });
  await writeFile(
    ".local/results/oracle-seed-request-templates.json",
    `${JSON.stringify({ domain: config.domain, apiVersion: config.apiVersion, fixtureHash: plan.fixtureHash, images, states, requests: plan.requests, executionReady: false, mutationsExecuted: 0, blockers: plan.blockers }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      source: "oracle-seed-request-templates",
      fixtureHash: plan.fixtureHash,
      states: states.length,
      checkedInputContracts: checked,
      liveBindingResolution: "required",
      collectionUpdateAndOrder: "observations-required",
      executionReady: false,
      mutationsExecuted: 0,
    }),
  );
} catch {
  console.error(
    "Seed request preparation failed; invalid source, schema or dependency. Details withheld.",
  );
  process.exitCode = 3;
}
