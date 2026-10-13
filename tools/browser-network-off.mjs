import { spawnSync } from "node:child_process";

const image = "shopify-offline-preview-browser:local";
for (const args of [
  ["build", "-f", "tools/ci/browser.Dockerfile", "-t", image, "."],
  ["run", "--rm", "--network", "none", image],
]) {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
