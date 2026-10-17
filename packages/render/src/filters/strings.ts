import { type Liquid, toValue } from "liquidjs";
import { handleize } from "./handle.js";
import { blake3, hmacSha1, sha1 } from "./hashes.js";

function text(value: unknown): string {
  return String(toValue(value) ?? "");
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
/** Ruby's URI.escape: everything except unreserved and reserved URI characters is percent-encoded. */
function uriEscape(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return byte < 0x80 && /[-_.!~*'()a-zA-Z\d;/?:@&=+$,[\]]/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** String filters whose output depends only on their input, as measured on a Shopify store. */
export function registerStringFilters(engine: Liquid): void {
  engine.registerFilter("sha1", (value: unknown) => sha1(text(value)));
  engine.registerFilter("hmac_sha1", (value: unknown, key: unknown) =>
    hmacSha1(text(value), text(key)),
  );
  engine.registerFilter("blake3", (value: unknown) => blake3(text(value)));
  engine.registerFilter("base64_url_safe_encode", (value: unknown) =>
    base64(new TextEncoder().encode(text(value)))
      .replaceAll("+", "-")
      .replaceAll("/", "_"),
  );
  engine.registerFilter("base64_url_safe_decode", (value: unknown) => {
    let input = text(value);
    // Like Ruby's urlsafe_decode64: unpadded input is padded, then decoded strictly.
    if (!input.endsWith("=") && input.length % 4 !== 0)
      input = input.padEnd(input.length + 4 - (input.length % 4), "=");
    const standard = input.replaceAll("-", "+").replaceAll("_", "/");
    if (
      standard.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(standard)
    )
      throw new Error("invalid base64 provided to base64_url_safe_decode");
    const binary = atob(standard);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  });
  engine.registerFilter("camelize", (value: unknown) =>
    handleize(text(value))
      .split(/[-_]+/)
      .map((word) => (word ? `${word[0]?.toUpperCase()}${word.slice(1)}` : ""))
      .join(""),
  );
  engine.registerFilter("url_escape", (value: unknown) => uriEscape(text(value)));
  engine.registerFilter("url_param_escape", (value: unknown) =>
    uriEscape(text(value)).replaceAll("&", "%26"),
  );
  engine.registerFilter("highlight", (value: unknown, term: unknown) => {
    const input = text(value),
      search = text(term);
    if (!search) return input;
    const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return input.replace(pattern, (match) => `<strong class="highlight">${match}</strong>`);
  });
}
