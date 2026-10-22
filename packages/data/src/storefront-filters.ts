import { handleize } from "./handle.js";
import { availableFields, type LiquidRecord, liquidPrice } from "./objects.js";
import { filterOperatorConfigurable, type Snapshot } from "./schema.js";

type Product = Snapshot["products"][number];
type Filter = NonNullable<Snapshot["filters"]>[number];
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
type Truth = boolean | undefined;
const anyKnown = (values: Truth[]): Truth =>
  values.includes(true) ? true : values.includes(undefined) ? undefined : false;
const allKnown = (values: Truth[]): Truth =>
  values.includes(false) ? false : values.includes(undefined) ? undefined : true;
function predicate(filter: Filter): ((product: Product, value: string) => Truth) | null {
  const id = filter.id;
  if (id === "filter.p.vendor") return (product, value) => product.vendor === value;
  if (id === "filter.p.product_type") return (product, value) => product.productType === value;
  if (id === "filter.p.tag") return (product, value) => product.tags.includes(value);
  if (id === "filter.v.availability")
    return (product, value) =>
      anyKnown(
        product.variants.map((variant) =>
          variant.available === undefined
            ? undefined
            : variant.available === (value === "1" || value === "true"),
        ),
      );
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
): {
  products: LiquidRecord[] | undefined;
  productsCount: number | undefined;
  filters: LiquidRecord[];
} {
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
  const conditions = (snapshot.filters ?? []).map((filter) => {
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
    const configured = "operator" in filter ? filter.operator : undefined;
    const operator = filterOperatorConfigurable(filter) ? configured : "OR";
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
        (filter.id === "filter.v.availability" &&
        new Set(selected.map((value) => value === "1" || value === "true")).size === 2
          ? product.variants.length > 0
          : (all ? allKnown : anyKnown)(selected.map((value) => matches(product, value)))),
      matches,
      operator,
      all,
    };
  });
  const passes = (product: Product, skip: number) =>
    allKnown(
      conditions.map(
        (condition, index) => index === skip || !condition.active || condition.test(product),
      ),
    );
  const membership = options.apply
    ? members.map((member) => passes(member.source, -1))
    : members.map(() => true);
  const filtered = members.filter((_member, index) => membership[index] === true);
  const unknownMembership = membership.includes(undefined);
  let products: LiquidRecord[] | undefined;

  function sort(list: QueryMember[]): LiquidRecord[] {
    const order = options.sortBy;
    if (order === null || order === options.defaultSortBy) return list.map((m) => m.value);
    if (order.startsWith("title-") && snapshot.shop.locale === undefined) {
      options.missing(
        "shop.locale is absent; title sort cannot be localized, snapshot order is retained.",
      );
      return list.map((m) => m.value);
    }
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

  // Shopify offers no filters when nothing matched before filtering: an empty collection, or
  // search terms that match no product. Filters that narrow a result to nothing stay offered.
  const filters = (members.length ? (snapshot.filters ?? []) : []).map((filter, index) => {
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
                ...availableFields({
                  count: (() => {
                    const included = members.map((member) =>
                      allKnown([
                        passes(member.source, index),
                        !condition?.all || condition.test(member.source),
                        matches(member.source, entry.value),
                      ]),
                    );
                    return included.includes(undefined)
                      ? undefined
                      : included.filter((value) => value === true).length;
                  })(),
                }),
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
  return {
    get products() {
      if (unknownMembership) {
        options.missing("Collection membership depends on absent variant.available.");
        return undefined;
      }
      products ??= options.apply ? sort(filtered) : filtered.map((member) => member.value);
      return products;
    },
    get productsCount() {
      if (unknownMembership) {
        options.missing("Collection membership depends on absent variant.available.");
        return undefined;
      }
      return filtered.length;
    },
    filters,
  };
}
