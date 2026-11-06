/**
 * The line a Liquid token starts on, as liquidjs `Token.getPosition()[0]` gives it (1 + the newlines before its begin
 * offset). `getPosition` counts them from the start of the template on every call; the renderer asks for the line of
 * every tag it renders and every filter it calls, which made rendering a large template quadratic (11-06: a theme's
 * page spent seconds in it). The newline offsets of each template text are found once and searched.
 */
type Positioned = { input?: unknown; begin?: unknown; getPosition(): [number, number] | number[] };

const NEWLINES = new Map<string, number[]>();
// a render reads a bounded set of templates; the cache is dropped whole when it grows past them
const MAX_TEXTS = 256;

function newlinesOf(text: string): number[] {
  let found = NEWLINES.get(text);
  if (found) return found;
  found = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) found.push(i);
  if (NEWLINES.size >= MAX_TEXTS) NEWLINES.clear();
  NEWLINES.set(text, found);
  return found;
}

export function tokenLine(token: Positioned): number {
  const { input, begin } = token;
  if (
    typeof input !== "string" ||
    typeof begin !== "number" ||
    !Number.isInteger(begin) ||
    begin < 0
  )
    return token.getPosition()[0] ?? 1;
  const newlines = newlinesOf(input);
  // newlines before `begin`: the first index whose offset is not below it
  let low = 0;
  let high = newlines.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((newlines[mid] as number) < begin) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}
