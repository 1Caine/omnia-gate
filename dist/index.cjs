"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  DEFAULT_OMNIA_URL: () => DEFAULT_OMNIA_URL,
  GateError: () => GateError,
  OMNIA_RELAYER: () => OMNIA_RELAYER,
  asMiddleware: () => asMiddleware,
  charge: () => charge,
  createChallenge: () => createChallenge,
  createGate: () => createGate,
  expressGate: () => expressGate,
  honoGate: () => honoGate,
  memoryNonceStore: () => memoryNonceStore,
  requirePassport: () => requirePassport,
  verifyReceipt: () => verifyReceipt,
  verifySignIn: () => verifySignIn,
  withGate: () => withGate
});
module.exports = __toCommonJS(src_exports);

// src/gate.ts
var import_protocol = require("omnia-sdk/protocol");
var DEFAULT_OMNIA_URL = "https://omniasuper.app";
var OMNIA_RELAYER = "5u3WuuuhmTWXnUt3WFyRKsWiEessZRCDTZjw4mQA7wqW";
var PAYMENT = { required: "payment-required", signature: "payment-signature", response: "payment-response" };
var EXPOSE = { "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" };
var GateError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "GateError";
    this.code = code;
  }
};
var utf8 = new TextEncoder();
function encodeHeader(value) {
  let bin = "";
  for (const b of utf8.encode(JSON.stringify(value))) bin += String.fromCharCode(b);
  return btoa(bin);
}
function decodeBase64Json(value) {
  const bin = atob(value.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}
function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
var deny = (status, code, message, headers = {}) => ({
  ok: false,
  response: json(status, { error: { code, message } }, headers)
});
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
var MICROS = 1000000n;
function priceMicros(price) {
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
function usdc(micros) {
  const frac = (micros % MICROS).toString().padStart(6, "0").replace(/0+$/, "");
  return `${micros / MICROS}${frac ? `.${frac}` : ""}`;
}
function memoryNonceStore(max = 2e5) {
  const seen = /* @__PURE__ */ new Map();
  let swept = 0;
  return {
    claim(key, ttlSeconds) {
      const now = Date.now();
      if (now - swept > 3e4 || seen.size >= max) {
        for (const [k, until2] of seen) if (until2 <= now) seen.delete(k);
        for (const k of seen.keys()) {
          if (seen.size < max) break;
          seen.delete(k);
        }
        swept = now;
      }
      const until = seen.get(key);
      if (until !== void 0 && until > now) return false;
      seen.set(key, now + ttlSeconds * 1e3);
      return true;
    }
  };
}
var sharedNonces = memoryNonceStore();
var sharedKeys = /* @__PURE__ */ new Map();
function context(config = {}) {
  const env = config.env ?? (typeof process !== "undefined" && process.env ? process.env : {});
  const omniaUrl = (config.omniaUrl ?? env.OMNIA_URL ?? DEFAULT_OMNIA_URL).replace(/\/+$/, "");
  const doFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const ttl = config.keyTtlMs ?? 3e5;
  const skew = config.skewSeconds ?? 60;
  const site = () => {
    const handle = config.handle ?? env.OMNIA_HANDLE;
    const secret = config.secretKey ?? env.OMNIA_SECRET_KEY;
    if (!handle || !secret) {
      throw new GateError("site_identity_missing", "Charging needs the site's own Omnia ID. Set OMNIA_HANDLE and OMNIA_SECRET_KEY, or pass handle and secretKey.");
    }
    try {
      return { handle: (0, import_protocol.normalizeHandle)(handle), seed: (0, import_protocol.seedFromSecret)(secret) };
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
        sharedKeys.set(key, { agent: null, until: now + Math.min(ttl, 3e4) });
        return null;
      }
      if (!res.ok) throw new GateError("omnia_unreachable", `Omnia answered ${res.status} when asked for a passport.`);
      const a = (await res.json())?.agent;
      if (!a || a.handle !== handle || typeof a.address !== "string") throw new GateError("omnia_unreachable", "Omnia's answer was not a passport.");
      const agent = { handle, id: (0, import_protocol.displayHandle)(handle), address: a.address, ownerVerified: a.ownerVerified === true };
      if (sharedKeys.size > 5e4) sharedKeys.clear();
      sharedKeys.set(key, { agent, until: now + ttl });
      return agent;
    },
    async signInSecret() {
      const given = config.signInSecret ?? env.OMNIA_GATE_SECRET;
      if (given) return given;
      let seed;
      try {
        seed = site().seed;
      } catch {
        throw new GateError("sign_in_secret_missing", "Sign in with Omnia needs a secret of your own for its nonces. Set OMNIA_GATE_SECRET, or pass signInSecret.");
      }
      const tag = utf8.encode("omnia-gate:v1:signin-secret\n");
      const bytes = new Uint8Array(tag.length + seed.length);
      bytes.set(tag, 0);
      bytes.set(seed, tag.length);
      return (0, import_protocol.sha256Hex)(bytes);
    },
    async post(path, body) {
      const { handle, seed } = site();
      const url = new URL(`${omniaUrl}/api/v1${path}`);
      const text = JSON.stringify(body);
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...await (0, import_protocol.signRequest)(seed, handle, "POST", url.pathname, text) },
        body: text
      });
      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    }
  };
}
function guard(needsBody, fn) {
  return Object.assign(fn, { needsBody });
}
var AUTH_MESSAGES = {
  missing: "This endpoint needs a signed request: the x-omnia-id, x-omnia-ts, x-omnia-nonce and x-omnia-sig headers.",
  handle: "The Omnia ID in x-omnia-id is not registered.",
  expired: "The request's timestamp is too far from this server's clock.",
  signature: "The signature does not match the Omnia ID's key. It covers the method, the path and query as called on this site, and the body."
};
function passportGuard(ctx, options = {}) {
  return guard(true, async (req) => {
    if (!req.headers.get(import_protocol.HEADER.signature)) return deny(401, "auth_missing", AUTH_MESSAGES.missing);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? new Uint8Array() : new Uint8Array(await req.clone().arrayBuffer());
    let agent = null;
    let verdict;
    try {
      verdict = await (0, import_protocol.verifyRequest)({
        headers: req.headers,
        method,
        path: options.path?.(req) ?? url.pathname + url.search,
        body,
        resolve: async (handle) => (agent = await ctx.lookup(handle))?.address ?? null,
        skewSeconds: ctx.skew
      });
    } catch {
      return deny(503, "omnia_unreachable", "The passport could not be checked right now. Try again in a moment.");
    }
    if (!verdict.ok) return deny(401, `auth_${verdict.reason}`, AUTH_MESSAGES[verdict.reason]);
    if (!await ctx.nonces.claim(`request:${verdict.handle}:${verdict.nonce}`, ctx.skew * 2 + 1)) {
      return deny(401, "auth_replay", "This signed request has already been used.");
    }
    return { ok: true, agent, headers: {} };
  });
}
function requirePassport(options = {}) {
  return passportGuard(context(options), options);
}
function signInNonce(secret, c) {
  return (0, import_protocol.hmacHex)(secret, ["omnia-gate:v1:signin", c.domain, c.handle, c.issuedAt, c.expiresAt, c.statement ?? ""].join("\n")).then((h) => h.slice(0, 32));
}
async function makeChallenge(ctx, input) {
  const domain = String(input.domain ?? "").trim().toLowerCase();
  if (!domain || /[\s/]/.test(domain)) throw new GateError("invalid_domain", "domain is the host name of your site, such as example.com.");
  let handle;
  try {
    handle = (0, import_protocol.normalizeHandle)(input.handle);
  } catch (e) {
    throw new GateError("invalid_handle", e.message);
  }
  if (input.statement !== void 0 && (/[\r\n]/.test(input.statement) || input.statement.length > 200)) {
    throw new GateError("invalid_statement", "A statement is one line of at most 200 characters.");
  }
  const now = input.now ?? /* @__PURE__ */ new Date();
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 300, 30), 3600);
  const base = {
    domain,
    handle,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1e3).toISOString(),
    ...input.statement ? { statement: input.statement } : {}
  };
  return { ...base, nonce: await signInNonce(await ctx.signInSecret(), base) };
}
async function checkSignIn(ctx, input) {
  const c = input.challenge;
  if (!c || typeof c !== "object" || typeof input.signature !== "string") return { ok: false, reason: "malformed" };
  for (const k of ["domain", "handle", "nonce", "issuedAt", "expiresAt"]) {
    if (typeof c[k] !== "string") return { ok: false, reason: "malformed" };
  }
  if (c.statement !== void 0 && typeof c.statement !== "string") return { ok: false, reason: "malformed" };
  let handle;
  try {
    handle = (0, import_protocol.normalizeHandle)(c.handle);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const challenge = { ...c, handle };
  if (!sameText(await signInNonce(await ctx.signInSecret(), challenge), c.nonce)) return { ok: false, reason: "nonce" };
  const agent = await ctx.lookup(handle);
  if (!agent) return { ok: false, reason: "handle" };
  const verdict = await (0, import_protocol.verifySignIn)(challenge, input.signature, agent.address, { domain: String(input.domain).trim().toLowerCase(), now: input.now });
  if (!verdict.ok) return verdict;
  const left = Math.ceil((Date.parse(c.expiresAt) - (input.now ?? /* @__PURE__ */ new Date()).getTime()) / 1e3);
  if (!await ctx.nonces.claim(`signin:${c.nonce}`, Math.max(left, 1) + 1)) return { ok: false, reason: "replay" };
  return { ok: true, agent };
}
function createChallenge(input) {
  return makeChallenge(context(input), input);
}
function verifySignIn(input) {
  return checkSignIn(context(input), input);
}
function isOffer(body) {
  return body !== null && body.x402Version === 2 && Array.isArray(body.accepts) && body.accepts.length > 0;
}
function upstreamError(body) {
  const e = body?.error;
  if (e && typeof e === "object" && typeof e.message === "string") return { code: typeof e.code === "string" ? e.code : "payment_failed", message: e.message };
  if (typeof body?.errorReason === "string") return { code: "payment_failed", message: body.errorReason };
  return { code: "payment_failed", message: "The payment was not accepted." };
}
function chargeGuard(ctx, options) {
  const micros = priceMicros(options.price);
  return guard(false, async (req) => {
    const terms = {
      priceMicros: micros.toString(),
      resource: options.resource?.(req) ?? req.url,
      ...options.payTo ? { payTo: options.payTo } : {}
    };
    const payment = req.headers.get(PAYMENT.signature);
    if (!payment) {
      const out2 = await ctx.post("/facilitator/offer", { ...terms, ...options.description ? { description: options.description } : {} }).catch(() => null);
      if (!out2 || out2.status !== 200 || !isOffer(out2.body)) {
        const why2 = out2 ? upstreamError(out2.body) : { code: "omnia_unreachable", message: "Omnia could not be reached." };
        return deny(503, "payment_unavailable", `This resource is paid for through Omnia, and an offer could not be made right now: ${why2.message}`);
      }
      const required = out2.body;
      return {
        ok: false,
        // The body is the x402 offer itself, so its `error` is the offer's plain text. The code and the sentence sit beside it.
        response: json(
          402,
          { code: "payment_required", message: `This request costs ${usdc(micros)} USDC. Pay with the PAYMENT-SIGNATURE header and send the request again.`, ...required },
          { [PAYMENT.required]: encodeHeader(required), ...EXPOSE }
        )
      };
    }
    const out = await ctx.post("/facilitator/settle", { ...terms, payment }).catch(() => null);
    if (!out) return deny(503, "payment_unavailable", "The payment could not be checked right now. It was not charged. Try again in a moment.");
    const b = out.body;
    if (out.status === 200 && b && b.success === true && typeof b.transaction === "string") {
      const settlement = { success: true, transaction: b.transaction, network: String(b.network ?? ""), payer: String(b.payer ?? "") };
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
          platformFee: String(b.platformFee ?? "")
        },
        headers: { [PAYMENT.response]: encodeHeader(settlement), ...EXPOSE }
      };
    }
    const why = upstreamError(b);
    const failed = b && typeof b.transaction === "string" ? { [PAYMENT.response]: encodeHeader({ success: false, transaction: b.transaction, network: b.network, payer: b.payer, errorReason: why.message }), ...EXPOSE } : {};
    if (out.status === 429) return deny(429, why.code, why.message);
    if (out.status === 400 || out.status === 402 || out.status === 409) return deny(402, why.code, why.message, failed);
    return deny(503, "payment_unavailable", `The payment could not be settled right now: ${why.message}`);
  });
}
function charge(options) {
  return chargeGuard(context(options), options);
}
async function verifyReceipt(headerValue, options) {
  if (!headerValue) return { ok: false, reason: "malformed" };
  let r;
  try {
    r = decodeBase64Json(headerValue);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!r || typeof r !== "object" || typeof r.slug !== "string" || typeof r.paymentId !== "string" || typeof r.payer !== "string" || typeof r.micros !== "string" || typeof r.timestamp !== "number" || !Number.isInteger(r.timestamp) || typeof r.signer !== "string" || typeof r.signature !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (r.signer !== options.relayer) return { ok: false, reason: "signer" };
  const text = `omnia:v1:receipt
${r.slug}
${r.paymentId}
${r.payer}
${r.micros}
${r.timestamp}`;
  if (!await (0, import_protocol.verifyText)(options.relayer, text, r.signature)) return { ok: false, reason: "signature" };
  const now = options.now ?? Math.floor(Date.now() / 1e3);
  if (Math.abs(now - r.timestamp) > (options.maxAgeSeconds ?? 300)) return { ok: false, reason: "expired" };
  if (options.slug !== void 0 && r.slug !== options.slug) return { ok: false, reason: "slug" };
  return { ok: true, receipt: r };
}
function createGate(config = {}) {
  const ctx = context(config);
  return {
    requirePassport: (options = {}) => passportGuard(ctx, options),
    charge: (options) => chargeGuard(ctx, options),
    createChallenge: (input) => makeChallenge(ctx, input),
    verifySignIn: (input) => checkSignIn(ctx, input),
    verifyReceipt: (headerValue, options = {}) => verifyReceipt(headerValue, { ...options, relayer: options.relayer ?? OMNIA_RELAYER }),
    lookup: (handle) => ctx.lookup((0, import_protocol.normalizeHandle)(handle))
  };
}

// src/adapters.ts
async function runAll(guards, req) {
  const info = {};
  const headers = {};
  for (const g of guards) {
    const out = await g(req);
    if (!out.ok) return out;
    if (out.agent) info.agent = out.agent;
    if (out.payment) info.payment = out.payment;
    Object.assign(headers, out.headers);
  }
  return { ok: true, info, headers };
}
var list = (guard2) => Array.isArray(guard2) ? guard2 : [guard2];
function asMiddleware(guard2) {
  const guards = list(guard2);
  return async (req) => {
    const out = await runAll(guards, req);
    return out.ok ? null : out.response;
  };
}
function withGate(guard2, handler) {
  const guards = list(guard2);
  return async (req, ctx) => {
    const out = await runAll(guards, req);
    if (!out.ok) return out.response;
    const res = await handler(req, ctx, out.info);
    const extra = Object.entries(out.headers);
    if (extra.length === 0) return res;
    try {
      for (const [k, v] of extra) res.headers.set(k, v);
      return res;
    } catch {
      const copy = new Response(res.body, res);
      for (const [k, v] of extra) copy.headers.set(k, v);
      return copy;
    }
  };
}
function honoGate(guard2) {
  const guards = list(guard2);
  return async (c, next) => {
    const out = await runAll(guards, c.req.raw);
    if (!out.ok) return out.response;
    c.set("omnia", out.info);
    await next();
    for (const [k, v] of Object.entries(out.headers)) c.header(k, v);
  };
}
var MAX_BODY = 1e6;
var first = (v) => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
var BodyTooLarge = class extends Error {
};
async function bodyBytes(req) {
  const enc = new TextEncoder();
  if (req.rawBody instanceof Uint8Array) return req.rawBody;
  if (typeof req.rawBody === "string") return enc.encode(req.rawBody);
  if (req.body instanceof Uint8Array) return req.body;
  if (typeof req.body === "string") return enc.encode(req.body);
  if (req.body !== void 0 && req.body !== null) {
    const length = first(req.headers["content-length"]);
    const empty = typeof req.body === "object" && Object.keys(req.body).length === 0 && (!length || length === "0") && !req.headers["transfer-encoding"];
    return empty ? new Uint8Array() : enc.encode(JSON.stringify(req.body));
  }
  if (req.readableEnded || typeof req[Symbol.asyncIterator] !== "function") return new Uint8Array();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const part = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    size += part.length;
    if (size > MAX_BODY) throw new BodyTooLarge();
    chunks.push(part);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  req.rawBody = bytes;
  const marked = req;
  if ((first(req.headers["content-type"]) ?? "").includes("json") && size > 0) {
    try {
      req.body = JSON.parse(new TextDecoder().decode(bytes));
      marked._body = true;
    } catch {
    }
  }
  return bytes;
}
async function toRequest(req, withBody) {
  const method = (req.method ?? "GET").toUpperCase();
  const proto = first(req.headers["x-forwarded-proto"]) ?? req.protocol ?? (req.socket?.encrypted ? "https" : "http");
  const host = first(req.headers["x-forwarded-host"]) ?? first(req.headers.host) ?? "localhost";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === void 0) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const hasBody = withBody && method !== "GET" && method !== "HEAD";
  const body = hasBody ? await bodyBytes(req) : void 0;
  return new Request(`${proto}://${host}${req.originalUrl ?? req.url ?? "/"}`, { method, headers, body: body && body.length > 0 ? body : void 0 });
}
async function sendResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(await response.text());
}
function expressGate(guard2) {
  const guards = list(guard2);
  const withBody = guards.some((g) => g.needsBody);
  return async (req, res, next) => {
    try {
      const out = await runAll(guards, await toRequest(req, withBody));
      if (!out.ok) return await sendResponse(res, out.response);
      req.omnia = { ...req.omnia, ...out.info };
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
      next();
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { code: "too_large", message: "The request body is larger than 1 MB." } }));
        return;
      }
      next(e);
    }
  };
}
