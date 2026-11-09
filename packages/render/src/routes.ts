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
  | "article"
  | "list-collections";
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
  return routeFromLookup(
    input,
    (kind, key) => {
      if (kind === "article") {
        const [blog, handle] = JSON.parse(key) as [string, string];
        return snapshot.blogs
          .find((value) => value.handle === blog)
          ?.articles.find((value) => value.handle === handle);
      }
      return snapshot[
        kind === "product"
          ? "products"
          : kind === "collection"
            ? "collections"
            : kind === "page"
              ? "pages"
              : "blogs"
      ].find((value) => value.handle === key);
    },
    hasTemplate,
  );
}
export function routeFromLookup(
  input: string,
  find: (
    kind: "product" | "collection" | "page" | "blog" | "article",
    key: string,
  ) => { templateSuffix?: string | null } | null | undefined,
  hasTemplate: (file: string) => boolean,
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
  else if (namespace === "collections" && decoded.length === 1) pageType = "list-collections";
  else if (namespace === "products" && handle && decoded.length === 2) {
    const product = find("product", handle);
    if (product) {
      pageType = "product";
      resource = { kind: "product", handle };
      suffix = product.templateSuffix ?? null;
    }
  } else if (namespace === "collections" && handle && decoded.length === 2) {
    const collection = find("collection", handle);
    if (collection) {
      pageType = "collection";
      resource = { kind: "collection", handle };
      suffix = collection.templateSuffix ?? null;
    } else if (handle === "all") {
      pageType = "collection";
      resource = { kind: "all-collection", handle };
    }
  } else if (namespace === "pages" && handle && decoded.length === 2) {
    const page = find("page", handle);
    if (page) {
      pageType = "page";
      resource = { kind: "page", handle };
      suffix = page.templateSuffix ?? null;
    }
  } else if (namespace === "blogs" && handle && (decoded.length === 2 || decoded.length === 3)) {
    const blog = find("blog", handle);
    if (blog && !articleHandle) {
      pageType = "blog";
      resource = { kind: "blog", handle };
      suffix = blog.templateSuffix ?? null;
    }
    if (blog && articleHandle) {
      const article = find("article", JSON.stringify([handle, articleHandle]));
      if (article) {
        pageType = "article";
        resource = { kind: "article", handle: articleHandle, blogHandle: handle };
        suffix = article.templateSuffix ?? null;
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
  const templates = suffixes.flatMap((candidate) =>
    ["json", "liquid"].map((extension) =>
      themePath(`templates/${pageType}${candidate ? `.${candidate}` : ""}.${extension}`),
    ),
  );
  const requested = templates[0] ?? themePath(`templates/${pageType}.json`);
  // An absent default template stays fatal when it is loaded.
  const template = templates.find(hasTemplate) ?? themePath(`templates/${pageType}.json`);
  if (template.replace(/\.(?:json|liquid)$/, "") !== requested.replace(/\.(?:json|liquid)$/, ""))
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

export async function resolveSourceRoute(
  session: import("../../data/src/source-session.js").SourceSession,
  input: string,
  hasTemplate: (file: string) => boolean,
): Promise<ResolvedRoute> {
  const descriptors = new Map<string, import("../../data/src/render-source.js").RenderDescriptor>();
  const requests: { kind: "product" | "collection" | "page" | "blog" | "article"; key: string }[] =
    [];
  // Resolve only identities touched by routing, before loading their normalized bodies.
  routeFromLookup(
    input,
    (kind, key) => {
      requests.push({ kind, key });
      return { templateSuffix: null };
    },
    hasTemplate,
  );
  await Promise.all(
    requests.map(async ({ kind, key }) => {
      const descriptor = await session.resolve(kind, key);
      if (descriptor) descriptors.set(JSON.stringify([kind, key]), descriptor);
    }),
  );
  return routeFromLookup(
    input,
    (kind, key) => descriptors.get(JSON.stringify([kind, key])),
    hasTemplate,
  );
}
