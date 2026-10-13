export type * from "./generated/objects.js";
export { registry } from "./generated/registry.js";

export type FeatureKind = "filter" | "tag" | "object" | "object-property";

/** Only actual oracle results may populate this registry. Empty during M0. */
export interface ImplementationEvidence {
  kind: FeatureKind;
  name: string;
  registered: boolean;
  oracleCases: readonly string[];
}

export function isImplemented(evidence: ImplementationEvidence | undefined): boolean {
  return evidence?.registered === true && evidence.oracleCases.length > 0;
}
