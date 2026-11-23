/**
 * Thin adapters that put a Gate guard in front of a handler: Express-style
 * `(req, res, next)`, Fetch-style route handlers (Next.js, Bun, Deno,
 * Cloudflare Workers) and Hono. None of them imports a framework.
 */
import type { GateAgent, GatePayment, Guard, GuardResult } from "./gate";

/** What the guards learned about a request. */
export interface GateInfo {
  /** Set by `requirePassport`. */
  agent?: GateAgent;
  /** Set by `charge`. */
  payment?: GatePayment;
}

type AnyGuard = Guard<GuardResult>;

async function runAll(guards: AnyGuard[], req: Request): Promise<{ ok: true; info: GateInfo; headers: Record<string, string> } | { ok: false; response: Response }> {
  const info: GateInfo = {};
  const headers: Record<string, string> = {};
  for (const g of guards) {
    const out = await g(req);
    if (!out.ok) return out;
    if (out.agent) info.agent = out.agent;
    if (out.payment) info.payment = out.payment;
    Object.assign(headers, out.headers);
  }
  return { ok: true, info, headers };
}

const list = (guard: AnyGuard | AnyGuard[]): AnyGuard[] => (Array.isArray(guard) ? guard : [guard]);

/** The core shape: a request in, and either the response to send instead or null to let it through. */
export function asMiddleware(guard: AnyGuard | AnyGuard[]): (req: Request) => Promise<Response | null> {
  const guards = list(guard);
  return async (req) => {
    const out = await runAll(guards, req);
    return out.ok ? null : out.response;
  };
}

// ---------------------------------------------------------------------------
// Fetch-style handlers: Next.js route handlers, Bun, Deno, Workers
// ---------------------------------------------------------------------------

/**
 * Wrap a route handler. The guards run first, in order. When they pass, the
 * handler gets what they learned as its third argument, and the headers of a
 * settled payment are added to its response.
 */
export function withGate<C = unknown>(
  guard: AnyGuard | AnyGuard[],
  handler: (req: Request, ctx: C, omnia: GateInfo) => Response | Promise<Response>,
): (req: Request, ctx: C) => Promise<Response> {
  const guards = list(guard);
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
      // Some responses have headers that cannot be changed. Copy the response instead.
      const copy = new Response(res.body, res);
      for (const [k, v] of extra) copy.headers.set(k, v);
      return copy;
    }
  };
}

// ---------------------------------------------------------------------------
// Hono
// ---------------------------------------------------------------------------

interface HonoContext {
  req: { raw: Request };
  set(key: string, value: unknown): void;
  header(name: string, value: string): void;
}

/** Hono middleware. What the guards learned is at `c.get("omnia")`. */
export function honoGate(guard: AnyGuard | AnyGuard[]): (c: HonoContext, next: () => Promise<void>) => Promise<Response | void> {
  const guards = list(guard);
  return async (c, next) => {
    const out = await runAll(guards, c.req.raw);
    if (!out.ok) return out.response;
    c.set("omnia", out.info);
    await next();
    for (const [k, v] of Object.entries(out.headers)) c.header(k, v);
  };
}

// ---------------------------------------------------------------------------
// Express-style (req, res, next)
// ---------------------------------------------------------------------------

/** The parts of a Node request this adapter reads. Express, Connect, Fastify's raw request and plain `http` all fit. */
export interface NodeRequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  protocol?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
  readableEnded?: boolean;
  socket?: { encrypted?: boolean } | null;
  omnia?: GateInfo;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

const MAX_BODY = 1_000_000;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();

class BodyTooLarge extends Error {}

/**
 * The exact bytes of the body, which is what an agent's signature covers.
 * Put Gate before your body parser, or keep the raw bytes in `req.rawBody`.
 * A body that was already parsed is written out again as compact JSON, which
 * matches what the Omnia SDK sends.
 */
async function bodyBytes(req: NodeRequestLike): Promise<Uint8Array> {
  const enc = new TextEncoder();
  if (req.rawBody instanceof Uint8Array) return req.rawBody;
  if (typeof req.rawBody === "string") return enc.encode(req.rawBody);
  if (req.body instanceof Uint8Array) return req.body;
  if (typeof req.body === "string") return enc.encode(req.body);
  if (req.body !== undefined && req.body !== null) {
    const length = first(req.headers["content-length"]);
    const empty = typeof req.body === "object" && Object.keys(req.body as object).length === 0 && (!length || length === "0") && !req.headers["transfer-encoding"];
    return empty ? new Uint8Array() : enc.encode(JSON.stringify(req.body));
  }
  if (req.readableEnded || typeof req[Symbol.asyncIterator] !== "function") return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<unknown>) {
    const part = typeof chunk === "string" ? enc.encode(chunk) : (chunk as Uint8Array);
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
  // The stream is used up now. Leave the body where a handler, or a body parser that runs later, will find it.
  req.rawBody = bytes;
  const marked = req as NodeRequestLike & { _body?: boolean };
  if ((first(req.headers["content-type"]) ?? "").includes("json") && size > 0) {
    try {
      req.body = JSON.parse(new TextDecoder().decode(bytes));
      marked._body = true;
    } catch {
      // Not JSON after all. The raw bytes are still in req.rawBody.
    }
  }
  return bytes;
}

async function toRequest(req: NodeRequestLike, withBody: boolean): Promise<Request> {
  const method = (req.method ?? "GET").toUpperCase();
  const proto = first(req.headers["x-forwarded-proto"]) ?? req.protocol ?? (req.socket?.encrypted ? "https" : "http");
  const host = first(req.headers["x-forwarded-host"]) ?? first(req.headers.host) ?? "localhost";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const hasBody = withBody && method !== "GET" && method !== "HEAD";
  const body = hasBody ? await bodyBytes(req) : undefined;
  return new Request(`${proto}://${host}${req.originalUrl ?? req.url ?? "/"}`, { method, headers, body: body && body.length > 0 ? (body as BodyInit) : undefined });
}

async function sendResponse(res: NodeResponseLike, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(await response.text());
}

/**
 * Express-style middleware. When the guards pass, what they learned is at
 * `req.omnia` (`req.omnia.agent`, `req.omnia.payment`).
 */
export function expressGate(guard: AnyGuard | AnyGuard[]): (req: NodeRequestLike, res: NodeResponseLike, next: (error?: unknown) => void) => Promise<void> {
  const guards = list(guard);
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
