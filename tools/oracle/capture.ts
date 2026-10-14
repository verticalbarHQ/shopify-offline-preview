import { type OracleTheme, oracleThemeSchema } from "./admin-read.js";
import { assertOracleStore, type OracleConfig, type OracleIdentity } from "./store-guard.js";
import {
  assertStableCapture,
  type PrivateSummary,
  type SummaryOptions,
  summarizeHtml,
} from "./summary.js";

export interface CaptureInput {
  config: OracleConfig;
  path: string;
  previewThemeId: string;
  cookie: string;
  summaryOptions: SummaryOptions;
}
export interface CaptureDependencies {
  readIdentity(): Promise<OracleIdentity>;
  readTheme(id: string): Promise<OracleTheme>;
  fetcher?: typeof fetch;
  verifyThemeFiles?(theme: OracleTheme): Promise<void>;
}
export interface CapturedPage {
  publicSummary: PrivateSummary["summary"];
  capturedAt: string;
  privateRawHtml: readonly [string, string];
  privateSectionText: PrivateSummary["sectionText"];
}

/** Shared read-only transport. Identity and unpublished theme guards precede every GET pair. */
export async function captureOracleHtmlPair(
  input: Omit<CaptureInput, "summaryOptions">,
  dependencies: CaptureDependencies,
): Promise<{ capturedAt: string; privateRawHtml: readonly [string, string] }> {
  assertOracleStore(input.config, await dependencies.readIdentity());
  if (!input.path.startsWith("/") || input.path.startsWith("//") || input.path.includes("#"))
    throw new Error("Capture path must be relative to the pinned store");
  if (!/^[1-9]\d*$/.test(input.previewThemeId))
    throw new Error("Unpublished preview theme id required");
  if (!input.cookie.trim() || /[\r\n]/.test(input.cookie))
    throw new Error("Valid storefront session cookie required");
  const theme = oracleThemeSchema.parse(await dependencies.readTheme(input.previewThemeId));
  if (
    theme.id !== `gid://shopify/OnlineStoreTheme/${input.previewThemeId}` ||
    theme.role !== "UNPUBLISHED" ||
    theme.processing ||
    theme.processingFailed
  )
    throw new Error(
      "Oracle preview theme must be the requested unpublished, successfully processed theme",
    );
  const url = new URL(input.path, `https://${input.config.domain}`);
  if (url.hostname !== input.config.domain)
    throw new Error("Capture path changed the pinned domain");
  url.searchParams.set("preview_theme_id", input.previewThemeId);
  await dependencies.verifyThemeFiles?.(theme);
  const fetcher = dependencies.fetcher ?? fetch;
  async function capture(): Promise<string> {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      headers: { Cookie: input.cookie, Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `Storefront capture failed (HTTP ${response.status}); redirects and password gates must be resolved explicitly`,
      );
    if (!response.headers.get("content-type")?.includes("text/html"))
      throw new Error("Storefront capture did not return HTML");
    return response.text();
  }
  const first = await capture();
  const second = await capture();
  await dependencies.verifyThemeFiles?.(theme);
  return { capturedAt: new Date().toISOString(), privateRawHtml: [first, second] };
}

/** Captures an already-seeded, already-uploaded unpublished theme. Performs no setup mutations. */
export async function captureOraclePage(
  input: CaptureInput,
  dependencies: CaptureDependencies,
): Promise<CapturedPage> {
  const pair = await captureOracleHtmlPair(input, dependencies);
  const [first, second] = pair.privateRawHtml;
  const a = summarizeHtml(first, input.summaryOptions);
  const b = summarizeHtml(second, input.summaryOptions);
  assertStableCapture(a.summary, b.summary);
  return {
    publicSummary: a.summary,
    capturedAt: pair.capturedAt,
    privateRawHtml: pair.privateRawHtml,
    privateSectionText: a.sectionText,
  };
}
