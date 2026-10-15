import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeHTML } from "entities";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { z } from "zod";
import { type CaptureDependencies, type CaptureInput, captureOracleHtmlPair } from "./capture.js";
import {
  type CorpusEnvironment,
  type CorpusFiles,
  corpusDependencyFiles,
  corpusFilesFingerprint,
  emptyCorpusEnvironment,
} from "./corpus-environment.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const corpusInputSchema = z.strictObject({
  id: z.string().regex(/^filters\/[a-z0-9_]+\/\d+$/),
  kind: z.literal("filters"),
  name: z.string().regex(/^[a-z0-9_]+$/),
  path: z.string(),
  liquid: z.string().min(1),
});
export type CorpusInput = z.infer<typeof corpusInputSchema>;
export interface PreparedCorpusCase extends CorpusInput {
  fixturePath: string;
  requestPath: string;
  template: string;
  section: string;
  snippet: string;
  payloadId: string;
  liquidSource: string;
  originalInputHash: string;
  preparedInputHash: string;
  transformation: "decode-html-entities";
  harnessHash: string;
}
function localPath(path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n\0#]/.test(path))
    throw new Error("Corpus context must be a local storefront path");
  const url = new URL(path, "https://fixture.invalid");
  if (
    url.host !== "fixture.invalid" ||
    url.searchParams.has("view") ||
    url.searchParams.has("preview_theme_id")
  )
    throw new Error("Corpus context contains reserved routing parameters");
  return url;
}
function templateKind(path: string): string {
  const url = localPath(path);
  if (url.pathname === "/") return "index";
  if (url.pathname === "/cart") return "cart";
  if (url.pathname === "/search") return "search";
  if (/^\/products\/[^/]+$/.test(url.pathname)) return "product";
  if (/^\/collections\/[^/]+(?:\/[^/]+)?$/.test(url.pathname)) return "collection";
  if (/^\/pages\/[^/]+$/.test(url.pathname)) return "page";
  if (/^\/blogs\/[^/]+\/[^/]+$/.test(url.pathname)) return "article";
  if (/^\/blogs\/[^/]+$/.test(url.pathname)) return "blog";
  throw new Error("Unsupported corpus page context");
}
/** No Shopify calls or uploads: only own harness files and explicitly mapped fixture requests. */
export function prepareCorpus(
  inputs: readonly unknown[],
  pathMap: Readonly<Record<string, string>>,
  environment: CorpusEnvironment = emptyCorpusEnvironment,
): { cases: PreparedCorpusCase[]; files: CorpusFiles } {
  const baseFiles: CorpusFiles = {
    "layout/theme.liquid":
      "<!doctype html><html><head>{{content_for_header}}</head><body>{{content_for_layout}}</body></html>",
    "layout/sop-corpus.liquid":
      "<!doctype html><html><head>{{content_for_header}}</head><body>{{content_for_layout}}</body></html>",
    "config/settings_schema.json": "[]",
    "config/settings_data.json": '{"current":{}}',
  };
  Object.assign(baseFiles, corpusDependencyFiles(environment));
  const files: CorpusFiles = { ...baseFiles };
  const cases: PreparedCorpusCase[] = [];
  const seen = new Set<string>();
  for (const value of inputs) {
    const input = corpusInputSchema.parse(value);
    if (!input.liquid.trim()) throw new Error("Corpus input has no executable Liquid");
    if (seen.has(input.id)) throw new Error("Duplicate corpus case id");
    seen.add(input.id);
    if (!Object.hasOwn(pathMap, input.path))
      throw new Error(`Fixture path mapping required for ${input.id}`);
    const fixturePath = pathMap[input.path];
    if (!fixturePath || templateKind(input.path) !== templateKind(fixturePath))
      throw new Error(`Corpus fixture context kind mismatch: ${input.id}`);
    const key = `sop-corpus-${hash(input.id).slice(0, 16)}`;
    const url = localPath(fixturePath);
    url.searchParams.set("view", key);
    const item = {
      ...input,
      fixturePath,
      requestPath: url.pathname + url.search,
      template: `templates/${templateKind(fixturePath)}.${key}.json`,
      section: `sections/${key}.liquid`,
      snippet: `snippets/${key}.liquid`,
      payloadId: key,
      liquidSource: decodeHTML(input.liquid),
      originalInputHash: hash(input.liquid),
      preparedInputHash: hash(decodeHTML(input.liquid)),
      transformation: "decode-html-entities" as const,
    };
    if (Object.hasOwn(files, item.snippet)) throw new Error("Corpus file identity collision");
    const caseFiles: CorpusFiles = {};
    caseFiles[item.snippet] = item.liquidSource;
    caseFiles[item.section] =
      `{% capture sop_corpus_output %}{% render '${key}' %}{% endcapture %}<script id="${key}" type="application/json">{{sop_corpus_output | base64_encode | json}}</script>`;
    caseFiles[item.template] = JSON.stringify({
      layout: "sop-corpus",
      sections: { main: { type: key } },
      order: ["main"],
    });
    Object.assign(files, caseFiles);
    cases.push({ ...item, harnessHash: corpusFilesFingerprint({ ...baseFiles, ...caseFiles }) });
  }
  return { cases, files };
}
export function assertPreparedCorpusCase(
  item: PreparedCorpusCase,
  environment: CorpusEnvironment = emptyCorpusEnvironment,
): CorpusFiles {
  const original = {
    id: item.id,
    kind: item.kind,
    name: item.name,
    path: item.path,
    liquid: item.liquid,
  };
  const prepared = prepareCorpus([original], { [item.path]: item.fixturePath }, environment);
  const expected = prepared.cases[0];
  if (
    !expected ||
    Object.entries(expected).some(([key, value]) => Reflect.get(item, key) !== value)
  )
    throw new Error("Prepared corpus provenance or routing has changed");
  return prepared.files;
}
export function extractCorpusOutput(
  html: string,
  item: PreparedCorpusCase,
  environment: CorpusEnvironment = emptyCorpusEnvironment,
): string {
  assertPreparedCorpusCase(item, environment);
  const payloads: string[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if (
      "tagName" in node &&
      node.tagName === "script" &&
      node.attrs.some((attr) => attr.name === "id" && attr.value === item.payloadId)
    ) {
      if (!node.attrs.some((attr) => attr.name === "type" && attr.value === "application/json"))
        throw new Error("Corpus payload has an invalid content type");
      payloads.push(
        node.childNodes
          .map((child) => (child.nodeName === "#text" && "value" in child ? child.value : ""))
          .join(""),
      );
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(html));
  if (payloads.length !== 1) throw new Error("Exactly one expected corpus payload is required");
  let output: unknown;
  try {
    output = JSON.parse(payloads[0] ?? "");
  } catch {
    throw new Error("Corpus payload is not valid JSON");
  }
  if (typeof output !== "string")
    throw new Error("Corpus payload must contain a captured output string");
  try {
    if (output.length > 12 * 1024 * 1024) throw new Error();
    const bytes = Buffer.from(output, "base64");
    if (bytes.length > 8 * 1024 * 1024 || bytes.toString("base64") !== output) throw new Error();
    return new TextDecoder("utf8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Corpus payload must contain canonical UTF-8 Base64");
  }
}
export const corpusObservationSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  source: z.literal("shopify-storefront"),
  specCommit: z.string().regex(/^[a-f0-9]{40}$/),
  fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
  harnessHash: z.string().regex(/^[a-f0-9]{64}$/),
  caseId: corpusInputSchema.shape.id,
  name: corpusInputSchema.shape.name,
  originalInputHash: z.string().regex(/^[a-f0-9]{64}$/),
  preparedInputHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestPath: z.string(),
  capturedAt: z.iso.datetime(),
  doubleCaptureStable: z.literal(true),
  outputHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputBytes: z.number().int().nonnegative(),
});
export interface CorpusCaptureDependencies extends CaptureDependencies {
  readThemeFiles(themeId: string, paths: readonly string[]): Promise<CorpusFiles>;
}
export async function captureCorpusCase(
  input: Omit<CaptureInput, "path" | "summaryOptions">,
  item: PreparedCorpusCase,
  metadata: { specCommit: string; fixtureHash: string },
  dependencies: CorpusCaptureDependencies,
  environment: CorpusEnvironment = emptyCorpusEnvironment,
) {
  const files = assertPreparedCorpusCase(item, environment);
  corpusObservationSchema.shape.specCommit.parse(metadata.specCommit);
  corpusObservationSchema.shape.fixtureHash.parse(metadata.fixtureHash);
  const pair = await captureOracleHtmlPair(
    { ...input, path: item.requestPath },
    {
      ...dependencies,
      async verifyThemeFiles() {
        const uploaded = await dependencies.readThemeFiles(
          input.previewThemeId,
          Object.keys(files).sort(),
        );
        if (corpusFilesFingerprint(uploaded) !== item.harnessHash)
          throw new Error("Uploaded corpus harness files differ from the prepared fixture");
      },
    },
  );
  const outputs = pair.privateRawHtml.map((html) => extractCorpusOutput(html, item, environment));
  if (outputs[0] !== outputs[1])
    throw new Error("Unstable Shopify corpus capture; no observation is retained");
  const output = outputs[0];
  if (output === undefined) throw new Error("Missing corpus output");
  const observation = corpusObservationSchema.parse({
    ...metadata,
    schemaVersion: "1.0",
    source: "shopify-storefront",
    caseId: item.id,
    name: item.name,
    harnessHash: item.harnessHash,
    originalInputHash: item.originalInputHash,
    preparedInputHash: item.preparedInputHash,
    requestPath: item.requestPath,
    capturedAt: pair.capturedAt,
    doubleCaptureStable: true,
    outputHash: hash(output),
    outputBytes: Buffer.byteLength(output),
  });
  return { observation, privateRawHtml: pair.privateRawHtml, privateOutputs: outputs };
}

/** Readable storefront output stays in the ignored private raw store, never public observations. */
export async function savePrivateCorpusCapture(
  result: Awaited<ReturnType<typeof captureCorpusCase>>,
): Promise<string> {
  corpusObservationSchema.parse(result.observation);
  const privateRoot = resolve(".local");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(privateRoot)) !== privateRoot)
    throw new Error("Private capture root cannot be a symlink");
  const rawRoot = join(privateRoot, "oracle", "corpus-raw");
  await mkdir(rawRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(rawRoot)) !== rawRoot)
    throw new Error("Private corpus path cannot contain symlinks");
  const directory = await mkdtemp(join(rawRoot, "capture-"));
  for (const [index, html] of result.privateRawHtml.entries())
    await writeFile(join(directory, `${index + 1}.html`), html, { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "outputs.json"), `${JSON.stringify(result.privateOutputs)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(join(directory, "observation.json"), `${JSON.stringify(result.observation)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return directory;
}
