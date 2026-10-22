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
  if (unavailable !== "show" && matches.some((candidate) => candidate.available === undefined)) {
    missingAvailability();
    return undefined;
  }
  if (unavailable === "hide") matches = matches.filter((candidate) => candidate.available);
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
  if (unavailable === "last")
    matches = [
      ...matches.filter((item) => item.available),
      ...matches.filter((item) => !item.available),
    ];
  return matches.slice(0, 1000);
}
