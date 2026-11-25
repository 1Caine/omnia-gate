/**
 * Omnia Gate, the core. Everything here works on the Fetch API: a guard
 * takes a `Request` and answers either "let it through" or the `Response` to
 * send instead. The adapters for Express, Next.js and Hono are thin wrappers
 * around these guards.
 *
 * Gate is non-custodial. It never sees a payer's key and never holds money:
 * a paying agent sends USDC straight to the site's own wallet, with the
 * platform fee as a split of the same Solana transaction.
 */
import {
  HEADER,
  displayHandle,
  hmacHex,
  normalizeHandle,
  seedFromSecret,
  sha256Hex,
  signRequest,
  verifyRequest,
  verifySignIn as verifySignInSignature,
  verifyText,
  type SignInChallenge,
} from "../../sdk/src/protocol";
import type { PaymentRequired, SettlementResponse } from "../../sdk/src/x402";

/** The public Omnia deployment. Set `omniaUrl` or the `OMNIA_URL` variable to use another one. */
export const DEFAULT_OMNIA_URL = "https://omniasuper.app";

/** The public address of the Omnia relayer, which signs the receipts the store gateway attaches to forwarded calls. */
export const OMNIA_RELAYER = "5u3WuuuhmTWXnUt3WFyRKsWiEessZRCDTZjw4mQA7wqW";

const PAYMENT = { required: "payment-required", signature: "payment-signature", response: "payment-response" } as const;
const EXPOSE = { "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" } as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An agent whose identity has been checked against its Omnia passport. */
export interface GateAgent {
  /** The handle without the suffix: "scout". */
  handle: string;
  /** The Omnia ID as it is written: "scout.omnia". */
  id: string;
  /** The agent's public key in base58, which is also its Solana address. */
  address: string;
  /** True when a wallet has signed as the owner of this agent. */
  ownerVerified: boolean;
}

/** Remembers what has been seen, so a signed request or a sign-in answer is accepted once. */
export interface NonceStore {
  /** True when `key` has not been claimed before. The claim is kept for `ttlSeconds`. */
  claim(key: string, ttlSeconds: number): boolean | Promise<boolean>;
}

export interface GateConfig {
  /** The Omnia deployment to check passports and settle payments with. Defaults to `OMNIA_URL`, then the public one. */
  omniaUrl?: string;
  /** The site's own Omnia ID, needed for `charge`. Defaults to `OMNIA_HANDLE`. */
  handle?: string;
  /** The site's own secret key, needed for `charge`. Defaults to `OMNIA_SECRET_KEY`. It signs requests to Omnia and is never sent. */
  secretKey?: string | Uint8Array | number[];
  /** The secret that makes sign-in nonces. Defaults to `OMNIA_GATE_SECRET`, then to a value derived from the site's secret key. */
  signInSecret?: string;
  /** How long a resolved passport is kept in memory. Five minutes by default. */
  keyTtlMs?: number;
  /** How far a signed request's timestamp may be from this server's clock. 60 seconds by default. */
  skewSeconds?: number;
  /** Where used nonces are remembered. In memory by default, which covers one process. */
  nonceStore?: NonceStore;
  /** A fetch implementation, for tests and unusual runtimes. */
  fetch?: typeof fetch;
  /** Environment to read the defaults from. `process.env` by default. */
  env?: Record<string, string | undefined>;
}

export interface GatePayment {
  /** The Solana transaction signature. */
  transaction: string;
  explorer: string;
  network: string;
  /** The wallet the USDC left. */
  payer: string;
  /** The payer's Omnia ID when it has one. */
  payerId: string | null;
  /** What was paid in total, what reached the site and what the platform fee was, in USDC. */
  amount: string;
  toPublisher: string;
  platformFee: string;
}

export type Denied = { ok: false; response: Response };
export type Allowed<T> = { ok: true; headers: Record<string, string> } & T;
export type PassportResult = Allowed<{ agent: GateAgent }> | Denied;
export type ChargeResult = Allowed<{ payment: GatePayment }> | Denied;
export type GuardResult = Allowed<{ agent?: GateAgent; payment?: GatePayment }> | Denied;

/** A check on one incoming request. `needsBody` tells an adapter whether the body has to be read for it. */
export interface Guard<R extends GuardResult = GuardResult> {
  (req: Request): Promise<R>;
  needsBody: boolean;
}

export interface PassportOptions {
  /**
   * The path the agent signed, when it is not the path of `req.url`: for
   * example behind a proxy that rewrites paths. It must be the path and query
   * the agent called on your site.
   */
  path?: (req: Request) => string;
}

export interface ChargeOptions {
  /** The price of one request: a decimal USDC string such as "0.01", or micros as a bigint. */
  price: string | bigint;
  /** One line that says what is being paid for. Shown to the payer. */
  description?: string;
  /** The wallet that is paid. Defaults to the site's own Omnia address. */
  payTo?: string;
  /** The URL written into the offer, when it is not `req.url`. */
  resource?: (req: Request) => string;
}

export interface Receipt {
  slug: string;
  paymentId: string;
  payer: string;
  micros: string;
  timestamp: number;
  signer: string;
  signature: string;
}

export type ReceiptFailure = "malformed" | "signer" | "signature" | "expired" | "slug";
export type SignInFailure = "malformed" | "nonce" | "handle" | "domain" | "expired" | "signature" | "replay";

/** A problem with how Gate is set up, as opposed to a problem with a request. */
export class GateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GateError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

function encodeHeader(value: unknown): string {
  let bin = "";
  for (const b of utf8.encode(JSON.stringify(value))) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeBase64Json(value: string): unknown {
  const bin = atob(value.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

const deny = (status: number, code: string, message: string, headers: Record<string, string> = {}): Denied => ({
  ok: false,
  response: json(status, { error: { code, message } }, headers),
});

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MICROS = 1_000_000n;

function priceMicros(price: string | bigint): bigint {
  if (typeof price === "bigint") {
    if (price <= 0n) throw new GateError("invalid_price", "A price must be more than zero.");
    return price;
  }
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(String(price).trim());
  if (!m) throw new GateError("invalid_price", `"${price}" is not a USDC price. Write a decimal with at most 6 places, for example "0.01".`);
  const micros = BigInt(m[1]) * MICROS + BigInt((m[2] ?? "").padEnd(6, "0"));
  if (micros <= 0n) throw new GateError("invalid_price", "A price must be more than zero.");
  return micros;
}

function usdc(micros: bigint): string {
  const frac = (micros % MICROS).toString().padStart(6, "0").replace(/0+$/, "");
  return `${micros / MICROS}${frac ? `.${frac}` : ""}`;
}

/** A nonce store kept in this process. Enough for one server. Several servers need a shared store. */
export function memoryNonceStore(max = 200_000): NonceStore {
  const seen = new Map<string, number>();
  let swept = 0;
  return {
    claim(key, ttlSeconds) {
      const now = Date.now();
      if (now - swept > 30_000 || seen.size >= max) {
        for (const [k, until] of seen) if (until <= now) seen.delete(k);
        // Still full: let go of the oldest claims, which are the closest to expiring.
        for (const k of seen.keys()) {
          if (seen.size < max) break;
          seen.delete(k);
        }
        swept = now;
      }
      const until = seen.get(key);
      if (until !== undefined && until > now) return false;
      seen.set(key, now + ttlSeconds * 1000);
      return true;
    },
  };
}

const sharedNonces = memoryNonceStore();
const sharedKeys = new Map<string, { agent: GateAgent | null; until: number }>();

// ---------------------------------------------------------------------------
// Context: what the guards share
// ---------------------------------------------------------------------------

interface Context {
  omniaUrl: string;
  skew: number;
  nonces: NonceStore;
  lookup(handle: string): Promise<GateAgent | null>;
  site(): { handle: string; seed: Uint8Array };
  signInSecret(): Promise<string>;
  post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }>;
}

function context(config: GateConfig = {}): Context {
  const env = config.env ?? (typeof process !== "undefined" && process.env ? process.env : {});
  const omniaUrl = (config.omniaUrl ?? env.OMNIA_URL ?? DEFAULT_OMNIA_URL).replace(/\/+$/, "");
  const doFetch: typeof fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const ttl = config.keyTtlMs ?? 300_000;
  const skew = config.skewSeconds ?? 60;

  const site = () => {
    const handle = config.handle ?? env.OMNIA_HANDLE;
    const secret = config.secretKey ?? env.OMNIA_SECRET_KEY;
    if (!handle || !secret) {
      throw new GateError("site_identity_missing", "Charging needs the site's own Omnia ID. Set OMNIA_HANDLE and OMNIA_SECRET_KEY, or pass handle and secretKey.");
    }
    try {
      return { handle: normalizeHandle(handle), seed: seedFromSecret(secret) };
    } catch {
      throw new GateError("site_identity_invalid", "OMNIA_HANDLE or OMNIA_SECRET_KEY is not valid.");
    }
  };

  return {
    omniaUrl,
    skew,
    nonces: config.nonceStore ?? sharedNonces,
    site,

    async lookup(handle) {
      const key = `${omniaUrl}|${handle}`;
      const hit = sharedKeys.get(key);
      const now = Date.now();
      if (hit && hit.until > now) return hit.agent;
      const res = await doFetch(`${omniaUrl}/api/v1/agents/${handle}`, { headers: { accept: "application/json" } });
      if (res.status === 404) {
        // A handle that does not exist yet may be registered a moment later, so the miss is kept only briefly.
        sharedKeys.set(key, { agent: null, until: now + Math.min(ttl, 30_000) });
        return null;
      }
      if (!res.ok) throw new GateError("omnia_unreachable", `Omnia answered ${res.status} when asked for a passport.`);
      const a = ((await res.json()) as { agent?: Record<string, unknown> } | null)?.agent;
      if (!a || a.handle !== handle || typeof a.address !== "string") throw new GateError("omnia_unreachable", "Omnia's answer was not a passport.");
      const agent: GateAgent = { handle, id: displayHandle(handle), address: a.address, ownerVerified: a.ownerVerified === true };
      if (sharedKeys.size > 50_000) sharedKeys.clear();
      sharedKeys.set(key, { agent, until: now + ttl });
      return agent;
    },

    async signInSecret() {
      const given = config.signInSecret ?? env.OMNIA_GATE_SECRET;
      if (given) return given;
      let seed: Uint8Array;
      try {
        seed = site().seed;
      } catch {
        throw new GateError("sign_in_secret_missing", "Sign in with Omnia needs a secret of your own for its nonces. Set OMNIA_GATE_SECRET, or pass signInSecret.");
      }
      const tag = utf8.encode("omnia-gate:v1:signin-secret\n");
      const bytes = new Uint8Array(tag.length + seed.length);
      bytes.set(tag, 0);
      bytes.set(seed, tag.length);
      return sha256Hex(bytes);
    },

    async post(path, body) {
      const { handle, seed } = site();
      const url = new URL(`${omniaUrl}/api/v1${path}`);
      const text = JSON.stringify(body);
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(await signRequest(seed, handle, "POST", url.pathname, text)) },
        body: text,
      });
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = (await res.json()) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    },
  };
}

function guard<R extends GuardResult>(needsBody: boolean, fn: (req: Request) => Promise<R>): Guard<R> {
  return Object.assign(fn, { needsBody });
}

// ---------------------------------------------------------------------------
// Passport: who is calling
// ---------------------------------------------------------------------------

const AUTH_MESSAGES = {
  missing: "This endpoint needs a signed request: the x-omnia-id, x-omnia-ts, x-omnia-nonce and x-omnia-sig headers.",
  handle: "The Omnia ID in x-omnia-id is not registered.",
  expired: "The request's timestamp is too far from this server's clock.",
  signature: "The signature does not match the Omnia ID's key. It covers the method, the path and query as called on this site, and the body.",
} as const;

function passportGuard(ctx: Context, options: PassportOptions = {}): Guard<PassportResult> {
  return guard(true, async (req) => {
    if (!req.headers.get(HEADER.signature)) return deny(401, "auth_missing", AUTH_MESSAGES.missing);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? new Uint8Array() : new Uint8Array(await req.clone().arrayBuffer());
    let agent: GateAgent | null = null;
    let verdict: Awaited<ReturnType<typeof verifyRequest>>;
    try {
      verdict = await verifyRequest({
        headers: req.headers,
        method,
        path: options.path?.(req) ?? url.pathname + url.search,
        body,
        resolve: async (handle) => (agent = await ctx.lookup(handle))?.address ?? null,
        skewSeconds: ctx.skew,
      });
    } catch {
      return deny(503, "omnia_unreachable", "The passport could not be checked right now. Try again in a moment.");
    }
    if (!verdict.ok) return deny(401, `auth_${verdict.reason}`, AUTH_MESSAGES[verdict.reason]);
    // Claimed only after the signature holds, so nobody can use up another agent's nonces.
    if (!(await ctx.nonces.claim(`request:${verdict.handle}:${verdict.nonce}`, ctx.skew * 2 + 1))) {
      return deny(401, "auth_replay", "This signed request has already been used.");
    }
    return { ok: true, agent: agent as unknown as GateAgent, headers: {} };
  });
}

/**
 * Check the signed request headers of an incoming request and say which
 * agent sent it. The signature covers the method, the path with its query and
 * the body, and each one is accepted once.
 */
export function requirePassport(options: PassportOptions & GateConfig = {}): Guard<PassportResult> {
  return passportGuard(context(options), options);
}

// ---------------------------------------------------------------------------
// Sign in with Omnia
// ---------------------------------------------------------------------------

function signInNonce(secret: string, c: Pick<SignInChallenge, "domain" | "handle" | "issuedAt" | "expiresAt" | "statement">): Promise<string> {
  return hmacHex(secret, ["omnia-gate:v1:signin", c.domain, c.handle, c.issuedAt, c.expiresAt, c.statement ?? ""].join("\n")).then((h) => h.slice(0, 32));
}

async function makeChallenge(ctx: Context, input: { domain: string; handle: string; statement?: string; ttlSeconds?: number; now?: Date }): Promise<SignInChallenge> {
  const domain = String(input.domain ?? "").trim().toLowerCase();
  if (!domain || /[\s/]/.test(domain)) throw new GateError("invalid_domain", "domain is the host name of your site, such as example.com.");
  let handle: string;
  try {
    handle = normalizeHandle(input.handle);
  } catch (e) {
    throw new GateError("invalid_handle", (e as Error).message);
  }
  if (input.statement !== undefined && (/[\r\n]/.test(input.statement) || input.statement.length > 200)) {
    throw new GateError("invalid_statement", "A statement is one line of at most 200 characters.");
  }
  const now = input.now ?? new Date();
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 300, 30), 3_600);
  const base = {
    domain,
    handle,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    ...(input.statement ? { statement: input.statement } : {}),
  };
  return { ...base, nonce: await signInNonce(await ctx.signInSecret(), base) };
}

async function checkSignIn(
  ctx: Context,
  input: { challenge: SignInChallenge; signature: string; domain: string; now?: Date },
): Promise<{ ok: true; agent: GateAgent } | { ok: false; reason: SignInFailure }> {
  const c = input.challenge;
  if (!c || typeof c !== "object" || typeof input.signature !== "string") return { ok: false, reason: "malformed" };
  for (const k of ["domain", "handle", "nonce", "issuedAt", "expiresAt"] as const) {
    if (typeof c[k] !== "string") return { ok: false, reason: "malformed" };
  }
  if (c.statement !== undefined && typeof c.statement !== "string") return { ok: false, reason: "malformed" };
  let handle: string;
  try {
    handle = normalizeHandle(c.handle);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const challenge: SignInChallenge = { ...c, handle };
  // The nonce proves this site issued exactly this challenge, so nothing has to be stored between the two steps.
  if (!sameText(await signInNonce(await ctx.signInSecret(), challenge), c.nonce)) return { ok: false, reason: "nonce" };
  const agent = await ctx.lookup(handle);
  if (!agent) return { ok: false, reason: "handle" };
  const verdict = await verifySignInSignature(challenge, input.signature, agent.address, { domain: String(input.domain).trim().toLowerCase(), now: input.now });
  if (!verdict.ok) return verdict;
  const left = Math.ceil((Date.parse(c.expiresAt) - (input.now ?? new Date()).getTime()) / 1000);
  if (!(await ctx.nonces.claim(`signin:${c.nonce}`, Math.max(left, 1) + 1))) return { ok: false, reason: "replay" };
  return { ok: true, agent };
}

/**
 * Sign in with Omnia, step one: make the challenge the agent will sign.
 * Nothing is stored: the nonce is an HMAC, made with your own secret, over the
 * domain, the handle and the times.
 */
export function createChallenge(input: { domain: string; handle: string; statement?: string; ttlSeconds?: number; now?: Date } & GateConfig): Promise<SignInChallenge> {
  return makeChallenge(context(input), input);
}

/**
 * Sign in with Omnia, step two: check the agent's answer. It resolves the
 * handle's key from Omnia and checks the domain, the expiry, the nonce and
 * the signature. An answer is accepted once.
 */
export function verifySignIn(input: { challenge: SignInChallenge; signature: string; domain: string; now?: Date } & GateConfig): Promise<{ ok: true; agent: GateAgent } | { ok: false; reason: SignInFailure }> {
  return checkSignIn(context(input), input);
}

// ---------------------------------------------------------------------------
// Charge: payment per request
// ---------------------------------------------------------------------------

function isOffer(body: Record<string, unknown> | null): body is Record<string, unknown> & PaymentRequired {
  return body !== null && body.x402Version === 2 && Array.isArray(body.accepts) && body.accepts.length > 0;
}

function upstreamError(body: Record<string, unknown> | null): { code: string; message: string } {
  const e = body?.error as { code?: unknown; message?: unknown } | undefined;
  if (e && typeof e === "object" && typeof e.message === "string") return { code: typeof e.code === "string" ? e.code : "payment_failed", message: e.message };
  if (typeof body?.errorReason === "string") return { code: "payment_failed", message: body.errorReason };
  return { code: "payment_failed", message: "The payment was not accepted." };
}

function chargeGuard(ctx: Context, options: ChargeOptions): Guard<ChargeResult> {
  const micros = priceMicros(options.price);
  return guard(false, async (req) => {
    const terms = {
      priceMicros: micros.toString(),
      resource: options.resource?.(req) ?? req.url,
      ...(options.payTo ? { payTo: options.payTo } : {}),
    };
    const payment = req.headers.get(PAYMENT.signature);

    if (!payment) {
      const out = await ctx.post("/facilitator/offer", { ...terms, ...(options.description ? { description: options.description } : {}) }).catch(() => null);
      if (!out || out.status !== 200 || !isOffer(out.body)) {
        const why = out ? upstreamError(out.body) : { code: "omnia_unreachable", message: "Omnia could not be reached." };
        return deny(503, "payment_unavailable", `This resource is paid for through Omnia, and an offer could not be made right now: ${why.message}`);
      }
      const required = out.body as PaymentRequired;
      return {
        ok: false,
        // The body is the x402 offer itself, so its `error` is the offer's plain text. The code and the sentence sit beside it.
        response: json(
          402,
          { code: "payment_required", message: `This request costs ${usdc(micros)} USDC. Pay with the PAYMENT-SIGNATURE header and send the request again.`, ...required },
          { [PAYMENT.required]: encodeHeader(required), ...EXPOSE },
        ),
      };
    }

    const out = await ctx.post("/facilitator/settle", { ...terms, payment }).catch(() => null);
    if (!out) return deny(503, "payment_unavailable", "The payment could not be checked right now. It was not charged. Try again in a moment.");
    const b = out.body;
    if (out.status === 200 && b && b.success === true && typeof b.transaction === "string") {
      const settlement: SettlementResponse = { success: true, transaction: b.transaction, network: String(b.network ?? ""), payer: String(b.payer ?? "") };
      return {
        ok: true,
        payment: {
          transaction: settlement.transaction,
          explorer: `https://solscan.io/tx/${settlement.transaction}`,
          network: settlement.network,
          payer: settlement.payer,
          payerId: typeof b.payerId === "string" ? b.payerId : null,
          amount: String(b.amount ?? usdc(micros)),
          toPublisher: String(b.toPublisher ?? ""),
          platformFee: String(b.platformFee ?? ""),
        },
        headers: { [PAYMENT.response]: encodeHeader(settlement), ...EXPOSE },
      };
    }
    const why = upstreamError(b);
    const failed = b && typeof b.transaction === "string" ? { [PAYMENT.response]: encodeHeader({ success: false, transaction: b.transaction, network: b.network, payer: b.payer, errorReason: why.message }), ...EXPOSE } : {};
    if (out.status === 429) return deny(429, why.code, why.message);
    if (out.status === 400 || out.status === 402 || out.status === 409) return deny(402, why.code, why.message, failed);
    return deny(503, "payment_unavailable", `The payment could not be settled right now: ${why.message}`);
  });
}

/**
 * Charge for a request. Without a payment the answer is 402 with an x402
 * offer. With one, Omnia checks and settles it, and the request goes through
 * with a PAYMENT-RESPONSE header. The payment settles before your handler runs.
 */
export function charge(options: ChargeOptions & GateConfig): Guard<ChargeResult> {
  return chargeGuard(context(options), options);
}

// ---------------------------------------------------------------------------
// Receipts from the store gateway
// ---------------------------------------------------------------------------

/**
 * Check the `x-omnia-receipt` header that the Omnia store gateway attaches
 * when it forwards a paid call to a publisher's endpoint. A valid receipt
 * means the call was paid for. `relayer` is the relayer's public address.
 */
export async function verifyReceipt(
  headerValue: string | null | undefined,
  options: { relayer: string; maxAgeSeconds?: number; slug?: string; now?: number },
): Promise<{ ok: true; receipt: Receipt } | { ok: false; reason: ReceiptFailure }> {
  if (!headerValue) return { ok: false, reason: "malformed" };
  let r: Partial<Receipt>;
  try {
    r = decodeBase64Json(headerValue) as Partial<Receipt>;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !r ||
    typeof r !== "object" ||
    typeof r.slug !== "string" ||
    typeof r.paymentId !== "string" ||
    typeof r.payer !== "string" ||
    typeof r.micros !== "string" ||
    typeof r.timestamp !== "number" ||
    !Number.isInteger(r.timestamp) ||
    typeof r.signer !== "string" ||
    typeof r.signature !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (r.signer !== options.relayer) return { ok: false, reason: "signer" };
  const text = `omnia:v1:receipt\n${r.slug}\n${r.paymentId}\n${r.payer}\n${r.micros}\n${r.timestamp}`;
  if (!(await verifyText(options.relayer, text, r.signature))) return { ok: false, reason: "signature" };
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - r.timestamp) > (options.maxAgeSeconds ?? 300)) return { ok: false, reason: "expired" };
  if (options.slug !== undefined && r.slug !== options.slug) return { ok: false, reason: "slug" };
  return { ok: true, receipt: r as Receipt };
}

// ---------------------------------------------------------------------------
// One object with shared settings
// ---------------------------------------------------------------------------

export interface Gate {
  /** Check who is calling. See `requirePassport`. */
  requirePassport(options?: PassportOptions): Guard<PassportResult>;
  /** Charge for a request. See `charge`. */
  charge(options: ChargeOptions): Guard<ChargeResult>;
  createChallenge(input: { domain: string; handle: string; statement?: string; ttlSeconds?: number; now?: Date }): Promise<SignInChallenge>;
  verifySignIn(input: { challenge: SignInChallenge; signature: string; domain: string; now?: Date }): Promise<{ ok: true; agent: GateAgent } | { ok: false; reason: SignInFailure }>;
  /** Check a store gateway receipt against the Omnia relayer. */
  verifyReceipt(headerValue: string | null | undefined, options?: { relayer?: string; maxAgeSeconds?: number; slug?: string }): ReturnType<typeof verifyReceipt>;
  /** Look up an agent's passport, with the same five minute memory the guards use. */
  lookup(handle: string): Promise<GateAgent | null>;
}

/** Gate with its settings given once. With no arguments it reads `OMNIA_HANDLE`, `OMNIA_SECRET_KEY` and `OMNIA_URL`. */
export function createGate(config: GateConfig = {}): Gate {
  const ctx = context(config);
  return {
    requirePassport: (options = {}) => passportGuard(ctx, options),
    charge: (options) => chargeGuard(ctx, options),
    createChallenge: (input) => makeChallenge(ctx, input),
    verifySignIn: (input) => checkSignIn(ctx, input),
    verifyReceipt: (headerValue, options = {}) => verifyReceipt(headerValue, { ...options, relayer: options.relayer ?? OMNIA_RELAYER }),
    lookup: (handle) => ctx.lookup(normalizeHandle(handle)),
  };
}
