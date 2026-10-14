import {
  type Context,
  evalTokenValue,
  type Liquid,
  Tag,
  type TagToken,
  type Token,
  type TopLevelToken,
  TypeGuards,
  toPromise,
  type ValueToken,
} from "liquidjs";

interface Counters {
  named: Map<unknown, number>;
  literals: Map<string, number>;
  variables: Map<Tag, number>;
}
function hasLookup(token: Token): boolean {
  return (
    TypeGuards.isPropertyAccessToken(token) ||
    (TypeGuards.isRangeToken(token) && (hasLookup(token.lhs) || hasLookup(token.rhs)))
  );
}
function literalKey(token: Token): unknown {
  if (TypeGuards.isQuotedToken(token)) return ["string", token.content];
  if (TypeGuards.isNumberToken(token)) return ["number", Number(token.content)];
  if (TypeGuards.isLiteralToken(token))
    return ["literal", token.literal === "null" ? "nil" : token.literal];
  if (TypeGuards.isRangeToken(token))
    return ["range", literalKey(token.lhs), literalKey(token.rhs)];
  throw new Error("Unsupported cycle literal");
}
function cycleText(value: unknown): string {
  return Array.isArray(value) ? value.map(cycleText).join("") : String(value ?? "");
}

/** Cycle grouping and render isolation use only public tag/token/context APIs. */
export function registerCycleTag(engine: Liquid): void {
  engine.registerTag(
    "cycle",
    class extends Tag {
      private readonly candidates: ValueToken[] = [];
      private readonly group?: ValueToken;
      private readonly fingerprint?: string;
      constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid) {
        super(token, tokens, liquid);
        const first = this.tokenizer.readValue();
        this.tokenizer.skipBlank();
        if (first && this.tokenizer.peek() === ":") {
          this.group = first;
          this.tokenizer.advance();
        } else if (first) this.candidates.push(first);
        while (!this.tokenizer.end()) {
          const value = this.tokenizer.readValue();
          if (value) this.candidates.push(value);
          this.tokenizer.readTo(",");
        }
        this.tokenizer.assert(this.candidates.length, "Cycle requires candidates");
        if (!this.group && !this.candidates.some(hasLookup))
          this.fingerprint = JSON.stringify(this.candidates.map(literalKey));
      }
      *arguments() {
        yield* this.candidates;
        if (this.group) yield this.group;
      }
      async render(context: Context): Promise<string> {
        const counters = context.getRegister<Counters>("sop-cycle-counters", {
          named: new Map(),
          literals: new Map(),
          variables: new Map(),
        });
        let index: number;
        let advance: (value: number) => void;
        if (this.group) {
          const value = await toPromise(evalTokenValue(this.group, context));
          const key = value instanceof Number ? Number(value) : value;
          index = counters.named.get(key) ?? 0;
          advance = (next) => counters.named.set(key, next);
        } else if (this.fingerprint !== undefined) {
          const key = this.fingerprint;
          index = counters.literals.get(key) ?? 0;
          advance = (next) => counters.literals.set(key, next);
        } else {
          index = counters.variables.get(this) ?? 0;
          advance = (next) => counters.variables.set(this, next);
        }
        // The shared count keeps increasing even when another tag changes list length.
        const candidate = this.candidates[index % this.candidates.length];
        let value: unknown;
        if (candidate && TypeGuards.isRangeToken(candidate)) {
          const left = await toPromise(evalTokenValue(candidate.lhs, context));
          const right = await toPromise(evalTokenValue(candidate.rhs, context));
          value = `${Math.trunc(Number(left))}..${Math.trunc(Number(right))}`;
        } else value = await toPromise(evalTokenValue(candidate, context));
        advance(index + 1);
        return cycleText(value);
      }
    },
  );
}
