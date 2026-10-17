export type * from "./generated/objects.js";
export { registry } from "./generated/registry.js";

export type FeatureKind = "filter" | "tag" | "object" | "object-property";

/** What the preview knows about one Shopify feature (SPEC §9.10). */
export interface ImplementationEvidence {
  kind: FeatureKind;
  name: string;
  /** The offline renderer provides it. */
  registered: boolean;
  /** Only Shopify's servers produce it, so the preview leaves it out by design. */
  serverOnly?: boolean;
  /** One-off Shopify comparisons that showed it behaving like Shopify. */
  oracleCases: readonly string[];
}

/** Implemented means the preview provides the feature. */
export function isImplemented(evidence: ImplementationEvidence | undefined): boolean {
  return evidence?.registered === true;
}

/** Verified means a Shopify comparison showed the feature behaving like Shopify. */
export function isVerified(evidence: ImplementationEvidence | undefined): boolean {
  return (evidence?.oracleCases.length ?? 0) > 0;
}

export { serverOnlyFeatures } from "./server-only.js";
export { shopifyVerification } from "./verification.js";
