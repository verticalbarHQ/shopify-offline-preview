// Compares the vendored Shopify/theme-liquid-docs files with upstream's default branch. When
// upstream has changed them, it names the files and exits 1, so the weekly docs-drift workflow
// fails and a maintainer updates the pin. GitHub Actions does not open pull requests in this
// repository. `--update` writes upstream's files to vendor/theme-liquid-docs/ and moves the pin
// to that commit; run `pnpm generate` afterwards and open the pull request by hand.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const pinText = await readFile("upstream.json", "utf8");
const pin = JSON.parse(pinText);
if (pin.repository !== "Shopify/theme-liquid-docs") throw new Error("Unexpected upstream pin");
const api = { "user-agent": "shopify-offline-preview-docs-drift" };
if (process.env.GITHUB_TOKEN) api.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const head = await fetch(`https://api.github.com/repos/${pin.repository}/commits/HEAD`, {
  headers: api,
});
if (!head.ok) throw new Error(`Could not read ${pin.repository}: HTTP ${head.status}`);
const latest = (await head.json()).sha;
if (!/^[a-f0-9]{40}$/.test(latest)) throw new Error("Unexpected upstream commit");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const upstream = {};
const changed = [];
for (const file of pin.files) {
  const response = await fetch(
    `https://raw.githubusercontent.com/${pin.repository}/${latest}/data/${file}`,
    { headers: { "user-agent": api["user-agent"] } },
  );
  if (!response.ok) throw new Error(`Could not read ${file}: HTTP ${response.status}`);
  upstream[file] = Buffer.from(await response.arrayBuffer());
  const vendored = await readFile(`vendor/theme-liquid-docs/${file}`);
  if (sha256(upstream[file]) !== sha256(vendored)) changed.push(file);
}

const short = (sha) => sha.slice(0, 12);
if (process.argv.includes("--update")) {
  for (const file of changed) await writeFile(`vendor/theme-liquid-docs/${file}`, upstream[file]);
  if (changed.length) {
    await writeFile("upstream.json", pinText.replace(pin.commit, latest));
    console.log(`Pinned ${pin.repository}@${short(latest)}; updated ${changed.join(", ")}.`);
    console.log("Next: pnpm generate, review the generated changes, then open a pull request.");
  } else console.log(`No vendored file differs from ${pin.repository}@${short(latest)}.`);
} else if (changed.length) {
  console.error(
    `${pin.repository}@${short(latest)} differs from the pin ${short(pin.commit)} in: ${changed.join(", ")}.`,
  );
  console.error("Update it with: pnpm docs:drift-check --update && pnpm generate, then open a PR.");
  process.exitCode = 1;
} else {
  console.log(
    `${pin.repository}@${short(latest)}: the vendored files match (pin ${short(pin.commit)}).`,
  );
}
