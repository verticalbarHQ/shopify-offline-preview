import { type Context, type Liquid, toPromise } from "liquidjs";
import { isCollectionProductList, liquidObjectKind } from "../../data/src/objects.js";
import {
  type UnknownBackupValue,
  UnknownCapturedValue,
  UnknownSelectedVariant,
  unknown,
  unknownBackupValue,
  unknownSelectedVariant,
} from "./backup-values.js";
import { DawnBackupAdapter, type DawnBackupPreviewOptions } from "./dawn-backup-adapter.js";

export { capturedBackupOutput, unknownBackupFact, unknownBackupValue } from "./backup-values.js";
export type { DawnBackupPreviewOptions } from "./dawn-backup-adapter.js";

export interface BackupPreviewOptions {
  /** Host permission to format old captures; never a claimed captured shop setting. */
  standardMoneyFormat?: boolean;
  /** Explicit theme compatibility. Omit for generic value guards only. */
  dawn?: DawnBackupPreviewOptions;
}

const selectedVariantProperties = new Set([
  "selected_or_first_available_variant",
  "first_available_variant",
]);
const guardedProperties = new Set([
  "available",
  "price",
  "price_min",
  "price_max",
  "price_varies",
  "unit_price",
  "unit_price_measurement",
  "compare_at_price",
  "compare_at_price_min",
  "compare_at_price_max",
  "compare_at_price_varies",
  "selected_or_first_available_variant",
  "first_available_variant",
]);

/** Request-local unknown propagation, independent of theme files and host decoration. */
export class BackupPreviewGuard {
  readonly dawn: DawnBackupAdapter | undefined;
  constructor(
    private readonly diagnostic: (message: string) => void,
    options: BackupPreviewOptions,
  ) {
    this.dawn = options.dawn ? new DawnBackupAdapter(options.dawn, diagnostic) : undefined;
  }
  private readonly contexts = new WeakMap<
    Context,
    { reads: number; mediaReferenceRoot?: unknown; directMediaReference: boolean }
  >();
  private unknownReads = 0;
  private readonly derivedCollectionLists = new WeakSet<unknown[]>();
  private collectionList(value: unknown): value is unknown[] {
    return (
      isCollectionProductList(value) ||
      (Array.isArray(value) && this.derivedCollectionLists.has(value))
    );
  }
  skipLoop(value: unknown): boolean {
    return (
      unknownBackupValue(value) || (!!this.dawn && this.collectionList(value) && value.length === 0)
    );
  }
  private unknown(context: Context): UnknownBackupValue {
    this.prepare(context);
    const state = this.contexts.get(context);
    if (!state) throw new Error("Backup context guard is not initialized");
    state.reads++;
    this.unknownReads++;
    return unknown;
  }
  /** Keep captured list completeness and uncertainty across Liquid's value pipeline. */
  wrapFilters(engine: Liquid): void {
    const guard = this;
    const transforms = new Set([
      "sort",
      "sort_natural",
      "reverse",
      "compact",
      "uniq",
      "where",
      "reject",
      "find",
      "find_index",
      "has",
      "map",
      "concat",
      "slice",
    ]);
    for (const [name, native] of Object.entries(engine.filters)) {
      if (typeof native !== "function") continue;
      engine.registerFilter(name, async function (input: unknown, ...args: unknown[]) {
        if (unknownBackupValue(input)) return guard.unknown(this.context);
        const lists = [input, ...args].filter((value) => guard.collectionList(value));
        if (transforms.has(name) && lists.some((value) => value.includes(null))) {
          guard.diagnostic(
            `Filter ${name} omitted: missing collection members cannot be filtered or reordered.`,
          );
          return guard.unknown(this.context);
        }
        const before = guard.reads(this.context);
        const result: unknown = await toPromise(native.call(this, input, ...args));
        if (guard.reads(this.context) !== before || unknownBackupValue(result))
          return guard.unknown(this.context);
        if (/^money(?:_|$)/.test(name) && typeof result === "string" && result.trim())
          guard.dawn?.recordMoney(this.context, result);
        if (Array.isArray(result) && lists.length > 0) guard.derivedCollectionLists.add(result);
        return result;
      });
    }
  }

  prepare(context: Context): void {
    if (this.contexts.has(context)) return;
    const state: { reads: number; mediaReferenceRoot?: unknown; directMediaReference: boolean } = {
      reads: 0,
      directMediaReference: false,
    };
    this.contexts.set(context, state);
    const guard = this;
    const getFromScope = context._getFromScope;
    context._getFromScope = function* (scope, paths, strictVariables) {
      const parts = typeof paths === "string" ? paths.split(".") : paths;
      const media = parts.indexOf("featured_media");
      const referenceOnly =
        media >= 0 &&
        (media === parts.length - 1 || (media === parts.length - 2 && parts[media + 1] === "id"));
      const previousRoot = state.mediaReferenceRoot,
        previousDirect = state.directMediaReference;
      // A missing selected-media reference must not hide the independently saved product gallery.
      // Root selection/identity and every commercial lookup retain their ordinary unknown guards.
      state.mediaReferenceRoot =
        referenceOnly &&
        (media === 1 || (media > 1 && selectedVariantProperties.has(String(parts[media - 1]))))
          ? parts[media - 1]
          : undefined;
      state.directMediaReference = referenceOnly && media === 0;
      try {
        return yield* getFromScope.call(this, scope, paths, strictVariables);
      } finally {
        state.mediaReferenceRoot = previousRoot;
        state.directMediaReference = previousDirect;
      }
    };
    const read = context.readProperty;
    context.readProperty = function (
      object: Parameters<Context["readProperty"]>[0],
      key: Parameters<Context["readProperty"]>[1],
    ) {
      const value: unknown = read.call(this, object, key);
      if (
        (state.mediaReferenceRoot !== undefined &&
          key === state.mediaReferenceRoot &&
          (value instanceof UnknownSelectedVariant ||
            (value === undefined &&
              selectedVariantProperties.has(String(key)) &&
              liquidObjectKind(object) === "product"))) ||
        (state.directMediaReference &&
          key === "featured_media" &&
          object instanceof UnknownSelectedVariant)
      )
        return undefined;
      if (unknownBackupValue(value) || unknownBackupValue(object)) {
        state.reads++;
        guard.unknownReads++;
        return object instanceof UnknownSelectedVariant
          ? unknown
          : unknownBackupValue(value)
            ? value
            : unknown;
      }
      if (
        key === "products" &&
        value === undefined &&
        liquidObjectKind(object) === "collection" &&
        typeof read.call(this, object, "all_products_count") === "number"
      ) {
        state.reads++;
        guard.unknownReads++;
        return unknown;
      }
      if (
        guardedProperties.has(String(key)) &&
        (object === undefined ||
          object === null ||
          (value === undefined && ["product", "variant"].includes(liquidObjectKind(object) ?? "")))
      ) {
        state.reads++;
        guard.unknownReads++;
        return selectedVariantProperties.has(String(key)) && liquidObjectKind(object) === "product"
          ? unknownSelectedVariant
          : unknown;
      }
      return value;
    };
  }
  reads(context: Context): number {
    this.prepare(context);
    const state = this.contexts.get(context);
    if (!state) throw new Error("Backup context guard is not initialized");
    return state.reads;
  }
  captureReads(): number {
    return this.unknownReads;
  }
  assignment(context: Context, before: number, key: string | undefined): void {
    if (key && this.reads(context) !== before && !unknownBackupValue(context.bottom()[key]))
      context.bottom()[key] = unknown;
  }
  capture(context: Context, before: number, key: string | undefined): void {
    if (!key || this.captureReads() === before) return;
    const output: unknown = context.bottom()[key];
    context.bottom()[key] = new UnknownCapturedValue(typeof output === "string" ? output : "");
  }
}
