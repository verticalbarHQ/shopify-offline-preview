import { handleize } from "./handle.js";
import { availableFields, type LiquidRecord, liquidPrice } from "./objects.js";
import { filterOperatorConfigurable, type Snapshot } from "./schema.js";

type Product = Snapshot["products"][number];
type Filter = Snapshot["filters"][number];
export interface QueryMember {
  source: Product;
  value: LiquidRecord;
}
export type Track = <T extends object>(
  value: T,
  type: string,
  path?: string | null,
  sourceKeys?: Readonly<Record<string, string | null>>,
) => T;

function metafieldValues(input: unknown): string[] {
  let value = input;
  let list = false;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    list = "type" in value && String(value.type).startsWith("list.");
    value = value.value;
  }
  if (list && typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      /* A malformed list matches as its literal text. */
    }
  }
  return (Array.isArray(value) ? value : [value]).map((entry) => String(entry));
}
/** Product membership for the documented filter parameters that snapshot data can decide. */
function predicate(filter: Filter): ((product: Product, value: string) => boolean) | null {
  const id = filter.id;
  if (id === "filter.p.vendor") return (product, value) => product.vendor === value;
  if (id === "filter.p.product_type") return (product, value) => product.productType === value;
  if (id === "filter.p.tag") return (product, value) => product.tags.includes(value);
  if (id === "filter.v.availability")
    return (product, value) =>
      product.variants.some((variant) => variant.available === (value === "1" || value === "true"));
  const option = /^filter\.v\.option\.(.+)$/.exec(id)?.[1];
  if (option !== undefined)
    return (product, value) => {
      const name = product.options.find((entry) => handleize(entry.name) === option)?.name;
      return product.variants.some((variant) =>
        variant.optionValues.some((entry) => entry.name === name && entry.value === value),
      );
    };
  const metafield = /^filter\.p\.m\.([^.]+)\.(.+)$/.exec(id);
  if (metafield) {
    const [, namespace = "", key = ""] = metafield;
    return (product, value) => {
      const values = metafieldValues(product.metafields[namespace]?.[key]);
      return filter.type === "boolean"
        ? values.some((entry) => (entry === "true") === (value === "1" || value === "true"))
        : values.includes(value);
    };
  }
  return null;
}

/**
 * Applies the storefront filter and sort parameters of the current URL to the products of the
 * collection being viewed. Parameters the snapshot cannot decide are reported, never guessed.
 */
export function storefrontQuery(
  snapshot: Snapshot,
  path: string,
  members: QueryMember[],
  options: {
    apply: boolean;
    sortBy: string | null;
    defaultSortBy: string;
    track: Track;
    unsupported(message: string): void;
    missing(message: string): void;
  },
): { products: LiquidRecord[]; filters: LiquidRecord[] } {
  const query = new URL(path, "https://offline.invalid");
  const link = (url: URL) => url.pathname + url.search;
  const without = (mutate: (url: URL) => void) => {
    const url = new URL(query);
    mutate(url);
    url.searchParams.delete("page");
    return link(url);
  };
  function price(name: string): number | null {
    const value = query.searchParams.get(name);
    if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
    try {
      return liquidPrice(value);
    } catch {
      return null;
    }
  }
  const conditions = snapshot.filters.map((filter) => {
    if (filter.type === "price_range") {
      const minimum = price(`${filter.id}.gte`),
        maximum = price(`${filter.id}.lte`);
      return {
        active: minimum !== null || maximum !== null,
        test: (product: Product) =>
          product.variants.some((variant) => {
            const amount = liquidPrice(variant.price);
            return (
              (minimum === null || amount >= minimum) && (maximum === null || amount <= maximum)
            );
          }),
        matches: null,
        operator: null,
        all: false,
      };
    }
    const selected = query.searchParams.getAll(filter.id);
    const matches = predicate(filter);
    const operator = filterOperatorConfigurable(filter) ? filter.operator : "OR";
    if (selected.length && !matches && options.apply)
      options.unsupported(
        `Storefront filter ${filter.id} cannot be decided from the snapshot; results are not filtered by it.`,
      );
    if (selected.length > 1 && operator === undefined)
      options.missing(
        `The operator of storefront filter ${filter.id} is absent from the snapshot; selected values are combined with OR.`,
      );
    const all = operator === "AND";
    return {
      active: selected.length > 0 && matches !== null,
      test: (product: Product) =>
        matches === null ||
        (all
          ? selected.every((value) => matches(product, value))
          : selected.some((value) => matches(product, value))),
      matches,
      operator,
      all,
    };
  });
  const passes = (product: Product, skip: number) =>
    conditions.every(
      (condition, index) => index === skip || !condition.active || condition.test(product),
    );
  const filtered = options.apply ? members.filter((member) => passes(member.source, -1)) : members;
  const products = options.apply ? sort(filtered) : filtered.map((member) => member.value);

  function sort(list: QueryMember[]): LiquidRecord[] {
    const order = options.sortBy;
    if (order === null || order === options.defaultSortBy) return list.map((m) => m.value);
    const collator = new Intl.Collator(snapshot.shop.locale, { sensitivity: "base" });
    const minimum = (product: Product) =>
      Math.min(...product.variants.map((variant) => liquidPrice(variant.price)));
    const compare: Record<string, (a: Product, b: Product) => number> = {
      "title-ascending": (a, b) => collator.compare(a.title, b.title),
      "title-descending": (a, b) => collator.compare(b.title, a.title),
      "price-ascending": (a, b) => minimum(a) - minimum(b),
      "price-descending": (a, b) => minimum(b) - minimum(a),
      "created-ascending": (a, b) =>
        Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)),
      "created-descending": (a, b) =>
        Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)),
    };
    const by = compare[order];
    if (
      !by ||
      (order.startsWith("created-") && list.some((member) => member.source.createdAt === undefined))
    ) {
      if (["manual", "best-selling", "created-ascending", "created-descending"].includes(order))
        options.unsupported(
          `Collection sort ${order} cannot be decided from the snapshot; the snapshot order is used.`,
        );
      return list.map((m) => m.value);
    }
    // Array#sort is stable, so ties keep the collection's snapshot order.
    return [...list].sort((a, b) => by(a.source, b.source)).map((m) => m.value);
  }

  const filters = snapshot.filters.map((filter, index) => {
    const condition = conditions[index];
    if (filter.type === "price_range") {
      const minimum = `${filter.id}.gte`,
        maximum = `${filter.id}.lte`;
      return options.track(
        {
          id: filter.id,
          label: filter.label,
          type: filter.type,
          param_name: filter.id,
          values: [],
          active_values: [],
          inactive_values: [],
          operator: null,
          presentation: null,
          min_value: options.track({ param_name: minimum, value: price(minimum) }, "filter_value"),
          max_value: options.track({ param_name: maximum, value: price(maximum) }, "filter_value"),
          range_max: members.reduce(
            (highest, member) => Math.max(highest, Number(member.value.price_max) || 0),
            0,
          ),
          url_to_remove: without((url) => {
            url.searchParams.delete(minimum);
            url.searchParams.delete(maximum);
          }),
        },
        "filter",
        `filters[${index}]`,
      );
    }
    const selected = query.searchParams.getAll(filter.id);
    const matches = condition?.matches ?? null;
    const values = filter.values.map((entry, valueIndex) => {
      const active = selected.includes(entry.value);
      return options.track(
        {
          param_name: filter.id,
          value: entry.value,
          label: entry.label,
          active,
          ...(matches === null
            ? {}
            : {
                // Faceted count: the other active filters apply. This filter's own selection
                // narrows the count only when its values combine with AND.
                count: members.filter(
                  (member) =>
                    passes(member.source, index) &&
                    (!condition?.all || condition.test(member.source)) &&
                    matches(member.source, entry.value),
                ).length,
              }),
          url_to_add: without((url) => {
            if (!active) url.searchParams.append(filter.id, entry.value);
          }),
          url_to_remove: without((url) => {
            // Removing one value keeps every other parameter in its original order.
            url.search = new URLSearchParams(
              [...url.searchParams].filter(
                ([name, value]) => name !== filter.id || value !== entry.value,
              ),
            ).toString();
          }),
        },
        "filter_value",
        `filters[${index}].values[${valueIndex}]`,
        { param_name: "id", active: null, count: null, url_to_add: null, url_to_remove: null },
      );
    });
    const pick = (accepted: string[]) =>
      values.find((value) => accepted.includes(String(value.value))) ?? null;
    return options.track(
      {
        id: filter.id,
        label: filter.label,
        type: filter.type,
        param_name: filter.id,
        values: options.track(values, "filter_value", `filters[${index}].values`),
        active_values: values.filter((value) => value.active),
        inactive_values: values.filter((value) => !value.active),
        ...availableFields({ operator: condition === undefined ? "OR" : condition.operator }),
        ...(filter.type === "boolean"
          ? {
              presentation: null,
              true_value: pick(["1", "true"]),
              false_value: pick(["0", "false"]),
            }
          : {}),
        url_to_remove: without((url) => url.searchParams.delete(filter.id)),
      },
      "filter",
      `filters[${index}]`,
      { param_name: "id", operator: null, active_values: "values", inactive_values: "values" },
    );
  });
  return { products, filters };
}
