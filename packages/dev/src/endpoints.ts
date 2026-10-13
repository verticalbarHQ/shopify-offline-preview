/** Shopify server endpoints are observable 501 responses, never emulated. */
export function isBlockedEndpoint(url: URL): boolean {
  return (
    url.searchParams.has("section_id") ||
    url.searchParams.has("sections") ||
    /^\/(?:cart\.js|cart\/(?:[^/]+\.js|add|change|update|clear)|search\/suggest(?:\.json)?|recommendations\/products(?:\.json)?|products\/[^/]+\.js)$/.test(
      url.pathname,
    )
  );
}
