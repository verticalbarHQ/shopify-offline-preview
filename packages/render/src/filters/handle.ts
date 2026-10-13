import { toValue } from "liquidjs";

const latin: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  þ: "th",
  ð: "d",
  đ: "d",
  ı: "i",
};
export function handleize(input: unknown): string {
  return String(toValue(input) ?? "")
    .toLocaleLowerCase("en")
    .replace(/[ßæœøłþðđı]/g, (character) => latin[character] ?? character)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC")
    .replace(/["'’‘]/g, "")
    .replace(/[^\p{L}\p{N}_]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}
