import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { defaultFixture, fixtureProductHandle } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { hasDropConstructor } from "./liquid-spec-environment.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--suite-dir" || !args[1])
  throw new Error("Usage: check-liquid-language --suite-dir <pinned-liquid-spec-checkout>");
const directory = resolve(args[1]);
const pin = "84bf25e0edbca5f7e530574788b0f875ab331f50";
const actualPin = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: directory,
  encoding: "utf8",
}).trim();
if (
  actualPin !== pin ||
  execFileSync("git", ["status", "--porcelain", "--", "specs/basics"], {
    cwd: directory,
    encoding: "utf8",
  }).trim()
)
  throw new Error("Clean pinned liquid-spec basics checkout required");
// Ruby's standard YAML loader stays in the dev harness; it is not a package dependency.
const loader = `require 'yaml'; require 'json'; require 'date'
root=ARGV[0]; output=[]; failures=[]
Dir[File.join(root,'specs/basics/*.yml')].sort.each do |file|
  begin
    raw=File.read(file)
    data=if YAML.method(:safe_load).parameters.any? { |kind,name| kind == :key && name == :permitted_classes }
      YAML.safe_load(raw, permitted_classes: [Date,Time], permitted_symbols: [], aliases: true)
    else
      YAML.safe_load(raw,[Date,Time],[],true)
    end
    cases=data.is_a?(Hash) ? data['specs'] : data
    (cases || []).each { |spec| output << {'file'=>file.sub(root+'/', ''),'spec'=>spec} }
  rescue Psych::Exception => error
    failures << {'file'=>file.sub(root+'/', ''),'reason'=>error.class.to_s}
  end
end
puts JSON.generate({'cases'=>output,'loaderFailures'=>failures})`;
const input = z
  .object({
    cases: z.array(
      z.object({
        file: z.string(),
        spec: z.object({
          name: z.string(),
          template: z.unknown().optional(),
          environment: z.record(z.string(), z.json()).optional(),
          expected: z.unknown().optional(),
          complexity: z.number().optional(),
          filesystem: z.record(z.string(), z.unknown()).optional(),
          generate: z.unknown().optional(),
          errors: z.unknown().optional(),
          render_errors: z.unknown().optional(),
          resource_limits: z.unknown().optional(),
          error_mode: z.unknown().optional(),
        }),
      }),
    ),
    loaderFailures: z.array(z.object({ file: z.string(), reason: z.string() })),
  })
  .parse(
    JSON.parse(
      execFileSync("ruby", ["-e", loader, directory], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    ),
  );
const rows: {
  file: string;
  name: string;
  status: "pass" | "fail" | "bridge-unsupported";
  diagnosticCodes?: string[];
  reason?: string;
  complexity?: number | undefined;
}[] = [];
for (const { file, spec } of input.cases) {
  if (
    typeof spec.template !== "string" ||
    typeof spec.expected !== "string" ||
    spec.generate ||
    spec.errors ||
    spec.render_errors ||
    spec.resource_limits ||
    spec.error_mode
  ) {
    rows.push({
      file,
      name: spec.name,
      status: "bridge-unsupported",
      reason: "Nonliteral template/output, generator, errors, parse mode or resource limits",
    });
    continue;
  }
  const environment = spec.environment ?? {};
  if (hasDropConstructor(environment)) {
    rows.push({
      file,
      name: spec.name,
      status: "bridge-unsupported",
      reason: "Test Drop constructor directives cannot be represented by the snapshot JSON bridge",
    });
    continue;
  }
  const keys = Object.keys(environment);
  if (keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    rows.push({
      file,
      name: spec.name,
      status: "bridge-unsupported",
      reason: "Unrepresentable binding name",
    });
    continue;
  }
  const snapshot = defaultFixture();
  const product = snapshot.products.find((p) => p.handle === fixtureProductHandle);
  if (!product) throw new Error("Fixture product missing");
  product.metafields._liquid_spec = { environment };
  const files: Record<string, string> = {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{% assign __sdk_spec_env=all_products['${fixtureProductHandle}'].metafields._liquid_spec.environment %}{% capture __sdk_spec_output %}{% render 'liquid_spec_case'${keys.map((key) => `, ${key}: __sdk_spec_env['${key}']`).join("")} %}{% endcapture %}<script id="sdk-spec-output" type="application/json">{{__sdk_spec_output|json}}</script>`,
    "snippets/liquid_spec_case.liquid": spec.template,
  };
  for (const [name, text] of Object.entries(spec.filesystem ?? {})) {
    if (typeof text !== "string") continue;
    files[`snippets/${name.endsWith(".liquid") ? name : `${name}.liquid`}`] = text;
  }
  try {
    const result = await renderTheme(new MemoryThemeFileSystem(files), "/", { snapshot });
    const raw = /<script id="sdk-spec-output" type="application\/json">([\s\S]*?)<\/script>/.exec(
      result.html,
    )?.[1];
    if (raw === undefined) throw new Error("Case payload absent");
    const output = JSON.parse(raw);
    const blockers = result.diagnostics.filter(
      (d) => d.code === "liquid-error" || d.code === "not-implemented",
    );
    rows.push({
      file,
      name: spec.name,
      complexity: spec.complexity,
      status: output === spec.expected && blockers.length === 0 ? "pass" : "fail",
      diagnosticCodes: [...new Set(blockers.map((d) => d.code))],
    });
  } catch {
    rows.push({
      file,
      name: spec.name,
      status: "fail",
      reason: "SDK execution failed",
    });
  }
}
const counts = Object.fromEntries(
  ["pass", "fail", "bridge-unsupported"].map((status) => [
    status,
    rows.filter((row) => row.status === status).length,
  ]),
);
await mkdir(".local/results", { recursive: true });
const report = {
  scope:
    "SDK renderer basics suite through isolated snippet bindings; not complete liquid-spec or Shopify oracle conformance",
  pin,
  counts,
  loaderFailures: input.loaderFailures,
  rows: rows.map(({ file, name, status, diagnosticCodes, reason, complexity }) => ({
    file,
    name,
    status,
    diagnosticCodes,
    reason,
    complexity,
  })),
};
await writeFile(".local/results/liquid-language.json", `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    pin,
    ...counts,
    loaderFailures: input.loaderFailures.length,
    report: ".local/results/liquid-language.json",
  }),
);
if (counts.fail || counts["bridge-unsupported"] || input.loaderFailures.length)
  process.exitCode = 1;
