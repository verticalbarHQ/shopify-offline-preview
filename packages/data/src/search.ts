export type SearchPurpose = "results" | "count" | "facets";

export interface SearchCandidate<T> {
  type: "product" | "page" | "article";
  value: T;
  text: string;
  available: boolean | undefined;
  price: number | null;
}
/** Unambiguous fixture queries use documented word/prefix matching; ranking gaps stay explicit. */
export function searchResults<T>(
  candidates: SearchCandidate<T>[],
  path: string,
  unsupported: (message: string) => void,
  missingAvailability: () => void,
  purpose: SearchPurpose = "results",
): SearchCandidate<T>[] | undefined {
  const url = new URL(path, "https://offline.invalid");
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query) return [];
  if (/[":()*]|\b(?:AND|OR|NOT)\b/.test(query)) {
    unsupported("Storefront search operators, phrases and explicit wildcards are not implemented.");
    return [];
  }
  const normalize = (text: string) =>
    text
      .normalize("NFC")
      .toLocaleLowerCase("en")
      .match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = normalize(query);
  if (!terms.length) return [];
  const types = new Set((url.searchParams.get("type") ?? "product,page,article").split(","));
  const prefix = url.searchParams.get("options[prefix]") ?? "last";
  const unavailable = url.searchParams.get("options[unavailable_products]") ?? "last";
  if (!["last", "none"].includes(prefix) || !["show", "hide", "last"].includes(unavailable)) {
    unsupported("The requested storefront search options are not implemented.");
    return [];
  }
  let matches = candidates.filter((candidate) => {
    if (!types.has(candidate.type)) return false;
    const words = normalize(candidate.text.replace(/<[^>]*>/g, " "));
    return terms.every((term, index) =>
      words.some((word) =>
        index === terms.length - 1 && prefix === "last" ? word.startsWith(term) : word === term,
      ),
    );
  });
  const unknownStock = matches.some((candidate) => candidate.available === undefined);
  if (unavailable !== "show" && unknownStock) {
    // In last mode stock changes only order. Counts remain known; facets also remain
    // known unless the 1000-result cutoff makes their membership depend on that order.
    if (
      unavailable === "last" &&
      (purpose === "count" || (purpose === "facets" && matches.length <= 1000))
    )
      return matches.slice(0, 1000);
    if (unavailable === "hide" && purpose === "count") {
      const known = matches.filter((candidate) => candidate.available === true);
      if (known.length >= 1000) return known.slice(0, 1000);
      missingAvailability();
      return undefined;
    }
  }
  if (unavailable === "hide")
    matches = matches.filter((candidate) => candidate.available !== false);
  const sort = url.searchParams.get("sort_by") ?? "relevance";
  if (sort === "price-ascending" || sort === "price-descending") {
    const direction = sort === "price-ascending" ? 1 : -1;
    matches = [...matches].sort((a, b) =>
      a.price === null
        ? b.price === null
          ? 0
          : 1
        : b.price === null
          ? -1
          : direction * (a.price - b.price),
    );
  } else if (sort === "relevance") {
    if (matches.length > 1)
      unsupported(
        "Shopify search relevance ranking is not reproduced; matching items retain source order.",
      );
  } else
    unsupported(
      `Search sort order ${sort} is not implemented; matching items retain source order.`,
    );
  if (unknownStock && unavailable !== "show") {
    const totalTrue = matches.filter((item) => item.available === true).length;
    const totalUnknown = matches.filter((item) => item.available === undefined).length;
    let beforeTrue = 0,
      beforeFalse = 0,
      beforeUnknown = 0;
    // Bounds over every completion of unknown stock. Facets need membership in
    // the first 1000; ordered results additionally need each included rank fixed.
    const ranked = matches.map((item) => {
      const min = item.available === false ? totalTrue + beforeFalse + beforeUnknown : beforeTrue;
      const max =
        unavailable === "hide" || item.available === true
          ? beforeTrue + beforeUnknown
          : totalTrue + beforeFalse + totalUnknown - (item.available === undefined ? 1 : 0);
      const optional = unavailable === "hide" && item.available === undefined;
      if (item.available === true) beforeTrue++;
      else if (item.available === false) beforeFalse++;
      else beforeUnknown++;
      return { item, min, max, optional };
    });
    if (
      ranked.some(
        ({ min, max, optional }) =>
          min < 1000 && (optional || (purpose === "facets" ? max >= 1000 : min !== max)),
      )
    ) {
      missingAvailability();
      return undefined;
    }
    return ranked
      .filter(({ min }) => min < 1000)
      .sort((a, b) => a.min - b.min)
      .map(({ item }) => item);
  }
  if (unavailable === "last")
    matches = [
      ...matches.filter((item) => item.available),
      ...matches.filter((item) => !item.available),
    ];
  return matches.slice(0, 1000);
}
