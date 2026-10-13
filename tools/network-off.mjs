import { spawnSync } from "node:child_process";

const image = "shopify-offline-preview-m0:local";
function run(args) {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["build", "-f", "tools/ci/Dockerfile", "-t", image, "."]);
run(["run", "--rm", "--network", "none", image]);
