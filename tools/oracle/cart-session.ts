import { isDeepStrictEqual } from "node:util";
import { type Node as JsonNode, type ParseError, parseTree } from "jsonc-parser";
import { z } from "zod";
import { liquidPrice } from "../../packages/data/src/objects.js";
import { applyScenario, validateSnapshotReferences } from "../../packages/data/src/scenarios.js";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import { oracleThemeSchema } from "./admin-read.js";
import { type CaptureDependencies, type CaptureInput, captureOraclePage } from "./capture.js";
import { type ContextCaptureDependencies, captureOracleContextPage } from "./capture-context.js";
import type { createOracleSeedBindingLedger } from "./seed-binding-ledger.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import { seedBindingKey } from "./seed-requests.js";
import { createOracleSeedStateReader } from "./seed-state-reader.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class OracleCartError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "scope-mismatch"
      | "session-not-empty"
      | "authorization-denied"
      | "request-failed"
      | "cart-mismatch"
      | "session-invalid"
      | "concurrent-operation",
  ) {
    super(`Oracle cart session failed: ${code}`);
    this.name = "OracleCartError";
  }
}
const decimal = z.string().regex(/^[1-9]\d*$/),
  money = z.number().int().nonnegative().safe(),
  lineSchema = z.object({
    id: decimal,
    variant_id: decimal,
    product_id: decimal,
    handle: z.string(),
    key: z.string().min(1).max(1024),
    quantity: z.number().int().positive().safe(),
    price: money,
    original_price: money,
    final_price: money,
    line_price: money,
    original_line_price: money,
    final_line_price: money,
    total_discount: money,
    properties: z.record(z.string(), z.json()).nullable(),
    selling_plan_allocation: z.json().nullable().optional(),
    discounts: z.array(z.json()),
    line_level_discount_allocations: z.array(z.json()),
  }),
  cartSchema = z.object({
    token: z.string().min(1).max(4096),
    note: z.string().nullable(),
    currency: z.string(),
    attributes: z.record(z.string(), z.json()),
    item_count: z.number().int().nonnegative().safe(),
    items: z.array(lineSchema).max(250),
    original_total_price: money,
    items_subtotal_price: money,
    total_price: money,
    total_discount: money,
    cart_level_discount_applications: z.array(z.json()),
    discount_codes: z.array(z.json()),
  });
type Cart = z.infer<typeof cartSchema>;
interface Target {
  productHandle: string;
  productId: string;
  variantId: string;
  quantity: number;
  price: number;
}
export interface OracleCartContext {
  domain: string;
  shopId: string;
  fixtureHash: string;
  caseId: string;
  path: string;
  stateHash: string;
  stage: "note" | "add";
}
export interface OracleCartDependencies {
  /** Trusted action-time authorization for this isolated storefront session, never a default approval. */
  authorize(context: OracleCartContext): Promise<void>;
  /** One verified access cookie (storefront_digest or _shopify_essential) from an isolated browser. Cart/customer cookies are refused. */
  passwordCookie: string;
  /** Separate storefront transport; no Admin credential is attached. */
  fetcher?: typeof fetch;
}
export interface VerifiedOracleCart {
  readonly kind: "verified-oracle-cart";
}
interface CartObservation {
  domain: string;
  shopId: string;
  fixtureHash: string;
  stateHash: string;
  caseId: string;
  path: string;
  lines: { productHandle: string; variantId: string; quantity: number; key: string }[];
  note: string | null;
}
interface Session {
  owner: object;
  observation: CartObservation;
  cart: Cart | null;
  targets: Target[];
  fetcher: typeof fetch;
  cookies: Map<string, string>;
  valid: boolean;
}
const sessions = new WeakMap<VerifiedOracleCart, Session>();
export function inspectVerifiedOracleCart(receipt: VerifiedOracleCart): CartObservation {
  const session = sessions.get(receipt);
  if (!session?.valid) throw new OracleCartError("session-invalid");
  return structuredClone(session.observation);
}
async function bodyText(response: Response, limit = 2 * 1024 * 1024): Promise<string> {
  const reader = response.body?.getReader(),
    decoder = new TextDecoder("utf8", { fatal: true });
  if (!reader) throw new OracleCartError("request-failed");
  let text = "",
    size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new OracleCartError("request-failed");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
/** Preserve JSON numeric identifiers lexically, including values above IEEE-754 precision. */
function parseCart(text: string): Cart {
  const errors: ParseError[] = [],
    tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false }),
    edits: { offset: number; length: number; value: string }[] = [];
  if (!tree || errors.length) throw new OracleCartError("cart-mismatch");
  function visit(node: JsonNode) {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const [key, value] = property.children ?? [];
        if (!key || !value || keys.has(key.value)) throw new OracleCartError("cart-mismatch");
        keys.add(key.value);
        if (["id", "variant_id", "product_id"].includes(key.value) && value.type === "number") {
          const raw = text.slice(value.offset, value.offset + value.length);
          if (!/^[1-9]\d*$/.test(raw)) throw new OracleCartError("cart-mismatch");
          edits.push({ offset: value.offset, length: value.length, value: JSON.stringify(raw) });
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  for (const edit of edits.sort((a, b) => b.offset - a.offset))
    text = text.slice(0, edit.offset) + edit.value + text.slice(edit.offset + edit.length);
  return cartSchema.parse(JSON.parse(text));
}
function cookieHeader(session: Session) {
  return [...session.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
function receiveCookies(session: Session, response: Response, domain: string) {
  for (const cookie of response.headers.getSetCookie()) {
    if (/[\r\n]/.test(cookie)) throw new OracleCartError("request-failed");
    const [pair = "", ...attributes] = cookie.split(";"),
      split = pair.indexOf("="),
      name = pair.slice(0, split).trim(),
      value = pair.slice(split + 1).trim();
    if (split < 1 || !/^[\w-]+$/.test(name) || !/^[\x21-\x3A\x3C-\x7E]*$/.test(value))
      throw new OracleCartError("request-failed");
    let expired = false;
    for (const attribute of attributes) {
      const [key = "", ...rest] = attribute.trim().split("="),
        setting = rest.join("=");
      if (key.toLowerCase() === "domain" && setting.replace(/^\./, "").toLowerCase() !== domain)
        throw new OracleCartError("request-failed");
      if (key.toLowerCase() === "path" && setting !== "/")
        throw new OracleCartError("request-failed");
      if (key.toLowerCase() === "max-age" && Number(setting) <= 0) expired = true;
      if (key.toLowerCase() === "expires" && Date.parse(setting) <= Date.now()) expired = true;
    }
    if (expired || value === "") session.cookies.delete(name);
    else session.cookies.set(name, value);
    if (session.cookies.size > 64 || cookieHeader(session).length > 16384)
      throw new OracleCartError("request-failed");
  }
}
function assertCart(cart: Cart, targets: Target[], currency: string, note: string | null) {
  if (cart.note !== (note || null) && cart.note !== note)
    throw new OracleCartError("cart-mismatch");
  const sum = targets.reduce(
      (total, target) => total + BigInt(target.price) * BigInt(target.quantity),
      0n,
    ),
    count = targets.reduce((total, target) => total + target.quantity, 0);
  if (
    cart.currency !== currency ||
    cart.items.length !== targets.length ||
    cart.item_count !== count ||
    BigInt(cart.total_price) !== sum ||
    BigInt(cart.original_total_price) !== sum ||
    BigInt(cart.items_subtotal_price) !== sum ||
    cart.total_discount !== 0 ||
    cart.cart_level_discount_applications.length ||
    cart.discount_codes.length ||
    Object.keys(cart.attributes).length ||
    new Set(cart.items.map((line) => line.key)).size !== cart.items.length
  )
    throw new OracleCartError("cart-mismatch");
  for (const target of targets) {
    const line = cart.items.find((line) => line.variant_id === target.variantId);
    if (
      !line ||
      line.id !== target.variantId ||
      line.product_id !== target.productId ||
      line.handle !== target.productHandle ||
      !line.key.startsWith(`${target.variantId}:`) ||
      line.quantity !== target.quantity ||
      line.price !== target.price ||
      line.original_price !== target.price ||
      line.final_price !== target.price ||
      BigInt(line.line_price) !== BigInt(target.price) * BigInt(target.quantity) ||
      line.original_line_price !== line.line_price ||
      line.final_line_price !== line.line_price ||
      line.total_discount !== 0 ||
      Object.keys(line.properties ?? {}).length ||
      line.selling_plan_allocation != null ||
      line.discounts.length ||
      line.line_level_discount_allocations.length
    )
      throw new OracleCartError("cart-mismatch");
  }
}

/** Private, isolated Ajax cart setup/capture. No clearing/adoption of an existing cart, checkout, live entrypoint or credential provisioning. */
export function createOracleCartSessions(
  inputConfig: OracleConfig,
  input: Snapshot,
  shopId: string,
  token: string,
  ledger: ReturnType<typeof createOracleSeedBindingLedger>,
  adminFetcher: typeof fetch = fetch,
) {
  const config = oracleConfigSchema.parse(inputConfig),
    snapshot = snapshotSchema.parse(input),
    plan = buildOracleSeedPlan(config, snapshot),
    owner = {},
    reader = createOracleSeedStateReader(config, snapshot, shopId, token, ledger, {
      fetcher: adminFetcher,
    });
  if (plan.issues.length) throw new OracleCartError("invalid-input");
  let busy = false;
  async function operation<T>(fn: () => Promise<T>) {
    if (busy) throw new OracleCartError("concurrent-operation");
    busy = true;
    try {
      return await fn();
    } catch (error) {
      if (error instanceof OracleCartError) throw error;
      throw new OracleCartError("request-failed");
    } finally {
      busy = false;
    }
  }
  async function verify(stateHash: string, targets: Target[]) {
    await reader.guard();
    for (const handle of new Set(targets.map((target) => target.productHandle))) {
      const task = plan.states
        .find((state) => state.hash === stateHash)
        ?.tasks.find((task) => task.resource === "product" && task.identity[0] === handle);
      if (!task) throw new OracleCartError("scope-mismatch");
      await reader.verifyTask(stateHash, task.key);
      if (!(await reader.publication(stateHash, task.key)))
        throw new OracleCartError("scope-mismatch");
    }
  }
  async function request(
    session: Session,
    path: string,
    payload?: unknown,
    html = false,
  ): Promise<Response> {
    const url = new URL(path, `https://${config.domain}`);
    if (
      url.origin !== `https://${config.domain}` ||
      (html
        ? payload !== undefined
        : !["/cart.js", "/cart/update.js", "/cart/add.js"].includes(url.pathname))
    )
      throw new OracleCartError("scope-mismatch");
    const response = await session.fetcher(url, {
      method: payload === undefined ? "GET" : "POST",
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(30000),
      headers: {
        Cookie: cookieHeader(session),
        Accept: html ? "text/html" : "application/json",
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok || response.redirected || (response.url && response.url !== String(url)))
      throw new OracleCartError("request-failed");
    receiveCookies(session, response, config.domain);
    return response;
  }
  async function read(session: Session): Promise<Cart> {
    const response = await request(session, "/cart.js");
    if (
      !/^(application\/json|text\/javascript)(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      throw new OracleCartError("request-failed");
    return parseCart(await bodyText(response));
  }
  async function captureSession<T>(
    receipt: VerifiedOracleCart,
    input: Omit<CaptureInput, "config" | "path" | "cookie">,
    dependencies: Omit<CaptureDependencies, "fetcher">,
    perform: (
      input: CaptureInput,
      dependencies: CaptureDependencies & {
        verifyThemeFiles: NonNullable<CaptureDependencies["verifyThemeFiles"]>;
      },
    ) => Promise<T>,
  ): Promise<T> {
    const session = sessions.get(receipt);
    if (!session?.valid || !session.cart || session.owner !== owner)
      throw new OracleCartError("session-invalid");
    try {
      if (typeof dependencies.verifyThemeFiles !== "function")
        throw new OracleCartError("invalid-input");
      const checkTheme = async () => {
        const theme = oracleThemeSchema.parse(await dependencies.readTheme(input.previewThemeId));
        if (
          theme.id !== `gid://shopify/OnlineStoreTheme/${input.previewThemeId}` ||
          theme.role !== "UNPUBLISHED" ||
          theme.processing ||
          theme.processingFailed
        )
          throw new OracleCartError("scope-mismatch");
        await dependencies.verifyThemeFiles?.(theme);
      };
      await verify(session.observation.stateHash, session.targets);
      if (!isDeepStrictEqual(await read(session), session.cart))
        throw new OracleCartError("cart-mismatch");
      const capture = await perform(
        { ...input, config, path: session.observation.path, cookie: cookieHeader(session) },
        {
          ...dependencies,
          verifyThemeFiles: checkTheme,
          readIdentity: async () => {
            const identity = await dependencies.readIdentity();
            if (identity.id !== shopId) throw new OracleCartError("scope-mismatch");
            return identity;
          },
          fetcher: async (url, init) => {
            if (init?.method !== "GET") throw new OracleCartError("scope-mismatch");
            const target = new URL(String(url));
            const expected = new URL(session.observation.path, `https://${config.domain}`);
            expected.searchParams.set("preview_theme_id", input.previewThemeId);
            if (target.href !== expected.href) throw new OracleCartError("scope-mismatch");
            const response = await request(
                session,
                target.pathname + target.search,
                undefined,
                true,
              ),
              text = await bodyText(response, 4 * 1024 * 1024);
            return new Response(text, { status: response.status, headers: response.headers });
          },
        },
      );
      await checkTheme();
      if (!isDeepStrictEqual(await read(session), session.cart))
        throw new OracleCartError("cart-mismatch");
      await verify(session.observation.stateHash, session.targets);
      return capture;
    } catch (error) {
      session.valid = false;
      throw error;
    }
  }
  return {
    prepare: (caseId: string, dependencies: OracleCartDependencies): Promise<VerifiedOracleCart> =>
      operation(async () => {
        const prepared = plan.requests.find((request) => request.caseId === caseId),
          desired = prepared
            ? (prepared.cart ?? applyScenario(snapshot, prepared.scenario).cart)
            : null;
        if (!prepared || !desired || typeof dependencies.authorize !== "function")
          throw new OracleCartError("invalid-input");
        const note = desired.note,
          stateHash = prepared.stateHash,
          state = plan.states.find((state) => state.hash === stateHash);
        if (!state) throw new OracleCartError("invalid-input");
        // Only the password-gate cookie crosses into the newly owned cart session.
        if (
          !/^(storefront_digest|_shopify_essential)=[\x21-\x3A\x3C-\x7E]+$/.test(
            dependencies.passwordCookie,
          ) ||
          dependencies.passwordCookie.length > 8192
        )
          throw new OracleCartError("invalid-input");
        const targets: Target[] = desired.lines.map((line) => {
          const task = state.tasks.find(
              (task) => task.resource === "product" && task.identity[0] === line.productHandle,
            ),
            product = task ? snapshotSchema.shape.products.element.parse(task.source) : undefined,
            variant = product?.variants.find((variant) => variant.id === line.variantId);
          if (
            !product ||
            !variant ||
            line.parentRelationship != null ||
            line.itemComponents?.length
          )
            throw new OracleCartError("invalid-input");
          const productId = ledger
              .get(seedBindingKey("product-id", line.productHandle))
              .split("/")
              .at(-1),
            variantId = ledger
              .get(seedBindingKey("variant-id", line.productHandle, line.variantId))
              .split("/")
              .at(-1);
          if (!productId || !variantId || !variant.available)
            throw new OracleCartError("scope-mismatch");
          return {
            productHandle: line.productHandle,
            productId,
            variantId,
            quantity: line.quantity,
            price: liquidPrice(variant.price),
          };
        });
        if (new Set(targets.map((target) => target.variantId)).size !== targets.length)
          throw new OracleCartError("invalid-input");
        await verify(prepared.stateHash, targets);
        const observation: CartObservation = {
            domain: config.domain,
            shopId,
            fixtureHash: plan.fixtureHash,
            stateHash: prepared.stateHash,
            caseId,
            path: prepared.path,
            lines: [],
            note: desired.note,
          },
          session: Session = {
            owner,
            observation,
            cart: null,
            targets,
            fetcher: dependencies.fetcher ?? fetch,
            cookies: new Map([
              [
                dependencies.passwordCookie.slice(0, dependencies.passwordCookie.indexOf("=")),
                dependencies.passwordCookie.slice(dependencies.passwordCookie.indexOf("=") + 1),
              ],
            ]),
            valid: false,
          };
        const initial = await read(session);
        if (
          initial.items.length ||
          initial.item_count ||
          initial.note ||
          Object.keys(initial.attributes).length
        )
          throw new OracleCartError("session-not-empty");
        assertCart(initial, [], snapshot.shop.currency, "");
        let expected = initial;
        async function post(stage: "note" | "add", path: string, payload: unknown) {
          try {
            await dependencies.authorize({ ...observation, stage });
          } catch {
            throw new OracleCartError("authorization-denied");
          }
          await verify(stateHash, targets);
          if (!isDeepStrictEqual(await read(session), expected))
            throw new OracleCartError("cart-mismatch");
          const response = await request(session, path, payload);
          await bodyText(response); // Bounded, drained response; only fresh GET readback certifies the outcome.
          const after = await read(session);
          if (after.token !== initial.token) throw new OracleCartError("cart-mismatch");
          assertCart(after, stage === "note" ? [] : targets, snapshot.shop.currency, note);
          expected = after;
        }
        if (desired.note) await post("note", "/cart/update.js", { note: desired.note });
        if (targets.length)
          await post("add", "/cart/add.js", {
            items: targets.map((target) => ({ id: target.variantId, quantity: target.quantity })),
          });
        const actual = await read(session);
        if (!isDeepStrictEqual(actual, expected)) throw new OracleCartError("cart-mismatch");
        assertCart(actual, targets, snapshot.shop.currency, desired.note);
        await verify(prepared.stateHash, targets);
        observation.lines = actual.items.map((line) => ({
          productHandle: line.handle,
          variantId: line.variant_id,
          quantity: line.quantity,
          key: line.key,
        }));
        session.cart = actual;
        session.valid = true;
        const receipt: VerifiedOracleCart = Object.freeze({ kind: "verified-oracle-cart" });
        sessions.set(receipt, session);
        return receipt;
      }),
    capture: (
      receipt: VerifiedOracleCart,
      input: Omit<CaptureInput, "config" | "path" | "cookie">,
      dependencies: Omit<CaptureDependencies, "fetcher">,
    ) => operation(() => captureSession(receipt, input, dependencies, captureOraclePage)),
    captureContext: (
      receipt: VerifiedOracleCart,
      input: Omit<CaptureInput, "config" | "path" | "cookie">,
      dependencies: Omit<ContextCaptureDependencies, "fetcher">,
    ) =>
      operation(() =>
        captureSession(receipt, input, dependencies, (request, adapters) =>
          captureOracleContextPage(request, shopId, {
            ...adapters,
            readCaptureContextSource: dependencies.readCaptureContextSource,
          }),
        ),
      ),
  };
}

/** Apply actual session order and line keys to the generated-ID-calibrated case, without inventing Native flags. */
export function applyOracleCart(
  config: OracleConfig,
  original: Snapshot,
  shopId: string,
  caseId: string,
  derived: Snapshot,
  receipt: VerifiedOracleCart,
) {
  const plan = buildOracleSeedPlan(config, original),
    request = plan.requests.find((request) => request.caseId === caseId),
    observed = inspectVerifiedOracleCart(receipt),
    snapshot = snapshotSchema.parse(derived),
    session = sessions.get(receipt);
  if (
    plan.issues.length ||
    !request ||
    !session ||
    observed.domain !== config.domain ||
    observed.shopId !== shopId ||
    observed.fixtureHash !== plan.fixtureHash ||
    observed.caseId !== caseId ||
    observed.stateHash !== request.stateHash
  )
    throw new OracleCartError("scope-mismatch");
  if (snapshot.cart.note !== observed.note || snapshot.cart.lines.length !== observed.lines.length)
    throw new OracleCartError("cart-mismatch");
  const lines = observed.lines.map((actual) => {
    const target = session.targets.find((target) => target.variantId === actual.variantId),
      candidates = snapshot.cart.lines.filter(
        (line) =>
          line.productHandle === actual.productHandle &&
          line.variantId === actual.variantId &&
          line.quantity === actual.quantity,
      ),
      product = snapshot.products.find((product) => product.handle === actual.productHandle);
    if (
      !target ||
      candidates.length !== 1 ||
      !product ||
      product.id !== target.productId ||
      !product.variants.some(
        (variant) => variant.id === actual.variantId && liquidPrice(variant.price) === target.price,
      )
    )
      throw new OracleCartError("cart-mismatch");
    return {
      ...candidates[0],
      productHandle: actual.productHandle,
      variantId: actual.variantId,
      quantity: actual.quantity,
      key: actual.key,
    };
  });
  snapshot.cart.lines = lines;
  validateSnapshotReferences(snapshot);
  return {
    snapshot,
    captureReady: false as const,
    omissions: [
      "native-cart-flags-and-line-context",
      "capture-clock",
      "all-state-fixture-assembly",
    ],
  };
}
