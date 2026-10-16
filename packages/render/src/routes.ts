import type { Diagnostic } from "../../check/src/contracts.js";
import type { Snapshot } from "../../data/src/schema.js";
import { themePath } from "../../theme/src/index.js";

export type PageType =
  | "index"
  | "product"
  | "collection"
  | "page"
  | "search"
  | "cart"
  | "404"
  | "blog"
  | "article";
export interface ResolvedRoute {
  path: string;
  pageType: PageType;
  template: string;
  resource: {
    kind: "product" | "collection" | "all-collection" | "page" | "blog" | "article";
    handle: string;
    blogHandle?: string;
  } | null;
  query: { variant: string | null; page: string | null; q: string; sortBy: string | null };
  diagnostics: Diagnostic[];
}

/**
 * Resolves source resources only; missing resources are never synthesized. With `hasTemplate`,
 * an alternate template absent from the theme falls back to the assigned, then default template.
 */
export function resolveRoute(
  snapshot: Snapshot,
  input: string,
  hasTemplate: (file: string) => boolean = () => true,
): ResolvedRoute {
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\"))
    throw new Error("Render requires a local URL path");
  const url = new URL(input, "https://offline.invalid");
  const path = url.pathname.replace(/\/$/, "") || "/";
  let pageType: PageType = "404";
  let resource: ResolvedRoute["resource"] = null;
  let suffix: string | null = null;
  const diagnostics: Diagnostic[] = [];
  const parts = path.split("/").slice(1);
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    decoded = [];
  }
  if (decoded.some((part) => part.includes("/") || part.includes("\\"))) decoded = [];
  const [namespace, handle, articleHandle] = decoded;
  if (path === "/") pageType = "index";
  else if (path === "/search") pageType = "search";
  else if (path === "/cart") pageType = "cart";
  else if (namespace === "products" && handle && decoded.length === 2) {
    const product = snapshot.products.find((item) => item.handle === handle);
    if (product) {
      pageType = "product";
      resource = { kind: "product", handle };
      suffix = product.templateSuffix;
    }
  } else if (namespace === "collections" && handle && decoded.length === 2) {
    const collection = snapshot.collections.find((item) => item.handle === handle);
    if (collection) {
      pageType = "collection";
      resource = { kind: "collection", handle };
      suffix = collection.templateSuffix;
    } else if (handle === "all") {
      pageType = "collection";
      resource = { kind: "all-collection", handle };
    }
  } else if (namespace === "pages" && handle && decoded.length === 2) {
    const page = snapshot.pages.find((item) => item.handle === handle);
    if (page) {
      pageType = "page";
      resource = { kind: "page", handle };
      suffix = page.templateSuffix;
    }
  } else if (namespace === "blogs" && handle && (decoded.length === 2 || decoded.length === 3)) {
    const blog = snapshot.blogs.find((item) => item.handle === handle);
    if (blog && !articleHandle) {
      pageType = "blog";
      resource = { kind: "blog", handle };
      suffix = blog.templateSuffix;
    }
    if (blog && articleHandle) {
      const article = blog.articles.find((item) => item.handle === articleHandle);
      if (article) {
        pageType = "article";
        resource = { kind: "article", handle: articleHandle, blogHandle: handle };
        suffix = article.templateSuffix;
      }
    }
  }
  if (pageType === "404" && ["products", "collections", "pages", "blogs"].includes(namespace ?? ""))
    diagnostics.push({
      code: "missing-resource",
      severity: "warning",
      file: null,
      line: null,
      nodeId: null,
      message: "The requested resource is not present in the local snapshot.",
    });
  const view = url.searchParams.get("view");
  const suffixes = [...new Set([...(view === null ? [] : [view || null]), suffix, null])];
  for (const candidate of suffixes)
    if (candidate !== null && !/^[a-zA-Z0-9_-]+$/.test(candidate))
      throw new Error("Invalid alternate template suffix");
  const templates = suffixes.map((candidate) =>
    themePath(`templates/${pageType}${candidate ? `.${candidate}` : ""}.json`),
  );
  const requested = templates[0] ?? themePath(`templates/${pageType}.json`);
  // An absent default template stays fatal when it is loaded.
  const template = templates.find(hasTemplate) ?? templates.at(-1) ?? requested;
  if (template !== requested)
    diagnostics.push({
      code: "missing-resource",
      severity: "warning",
      file: null,
      line: null,
      nodeId: null,
      message: `Template ${requested} is absent from the theme; ${template} is rendered.`,
    });
  return {
    path: url.pathname + url.search,
    pageType,
    template,
    resource,
    query: {
      variant: url.searchParams.get("variant"),
      page: url.searchParams.get("page"),
      q: url.searchParams.get("q") ?? "",
      sortBy: url.searchParams.get("sort_by"),
    },
    diagnostics,
  };
}
