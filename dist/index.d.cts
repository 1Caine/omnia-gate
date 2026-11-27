interface SignInChallenge {
    /** The website asking, as a host name: "example.com". */
    domain: string;
    handle: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
    /** What the sign-in is for, shown to whoever reads the log. Optional. */
    statement?: string;
}

/**
 * Omnia Gate, the core. Everything here works on the Fetch API: a guard
 * takes a `Request` and answers either "let it through" or the `Response` to
 * send instead. The adapters for Express, Next.js and Hono are thin wrappers
 * around these guards.
 *
 * Gate is non-custodial. It never sees a payer's key and never holds money:
 * a paying agent sends USDC on Elysium straight to the site's own wallet,
 * with the platform fee as a split of the same transaction.
 */

/** The public Omnia deployment. Set `omniaUrl` or the `OMNIA_URL` variable to use another one. */
declare const DEFAULT_OMNIA_URL = "https://omniasuper.app";
/** The public address of the Omnia relayer, which signs the receipts the store gateway attaches to forwarded calls. */
declare const OMNIA_RELAYER = "0x2d42a8b3EcBCAB9e00de02D5CeA02D9587b7fA75";
/** An agent whose identity has been checked against its Omnia passport. */
interface GateAgent {
    /** The handle without the suffix: "scout". */
    handle: string;
    /** The Omnia ID as it is written: "scout.omnia". */
    id: string;
    /** The agent's 0x address on Elysium. Its key signs its requests and holds its own wallet. */
    address: string;
    /** True when a wallet has signed as the owner of this agent. */
    ownerVerified: boolean;
}
/** Remembers what has been seen, so a signed request or a sign-in answer is accepted once. */
interface NonceStore {
    /** True when `key` has not been claimed before. The claim is kept for `ttlSeconds`. */
    claim(key: string, ttlSeconds: number): boolean | Promise<boolean>;
}
interface GateConfig {
    /** The Omnia deployment to check passports and settle payments with. Defaults to `OMNIA_URL`, then the public one. */
    omniaUrl?: string;
    /** The site's own Omnia ID, needed for `charge`. Defaults to `OMNIA_HANDLE`. */
    handle?: string;
    /** The site's own private key (0x and 64 hex characters), needed for `charge`. Defaults to `OMNIA_SECRET_KEY`. It signs requests to Omnia and is never sent. */
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
interface GatePayment {
    /** The hash of the transaction on Elysium that settled the payment. */
    transaction: string;
    explorer: string;
    network: string;
    /** The wallet the USDC left: the agent's own address, or its guarded wallet. */
    payer: string;
    /** The payer's Omnia ID when it has one. */
    payerId: string | null;
    /** What was paid in total, what reached the site and what the platform fee was, in USDC. */
    amount: string;
    toPublisher: string;
    platformFee: string;
}
type Denied = {
    ok: false;
    response: Response;
};
type Allowed<T> = {
    ok: true;
    headers: Record<string, string>;
} & T;
type PassportResult = Allowed<{
    agent: GateAgent;
}> | Denied;
type ChargeResult = Allowed<{
    payment: GatePayment;
}> | Denied;
type GuardResult = Allowed<{
    agent?: GateAgent;
    payment?: GatePayment;
}> | Denied;
/** A check on one incoming request. `needsBody` tells an adapter whether the body has to be read for it. */
interface Guard<R extends GuardResult = GuardResult> {
    (req: Request): Promise<R>;
    needsBody: boolean;
}
interface PassportOptions {
    /**
     * The path the agent signed, when it is not the path of `req.url`: for
     * example behind a proxy that rewrites paths. It must be the path and query
     * the agent called on your site.
     */
    path?: (req: Request) => string;
}
interface ChargeOptions {
    /** The price of one request: a decimal USDC string such as "0.01", or micros as a bigint. */
    price: string | bigint;
    /** One line that says what is being paid for. Shown to the payer. */
    description?: string;
    /** The wallet that is paid. Defaults to the site's own Omnia address. */
    payTo?: string;
    /** The URL written into the offer, when it is not `req.url`. */
    resource?: (req: Request) => string;
}
interface Receipt {
    slug: string;
    paymentId: string;
    payer: string;
    micros: string;
    timestamp: number;
    signer: string;
    signature: string;
}
type ReceiptFailure = "malformed" | "signer" | "signature" | "expired" | "slug";
type SignInFailure = "malformed" | "nonce" | "handle" | "domain" | "expired" | "signature" | "replay";
/** A problem with how Gate is set up, as opposed to a problem with a request. */
declare class GateError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** A nonce store kept in this process. Enough for one server. Several servers need a shared store. */
declare function memoryNonceStore(max?: number): NonceStore;
/**
 * Check the signed request headers of an incoming request and say which
 * agent sent it. The signature covers the method, the path with its query and
 * the body, and each one is accepted once.
 */
declare function requirePassport(options?: PassportOptions & GateConfig): Guard<PassportResult>;
/**
 * Sign in with Omnia, step one: make the challenge the agent will sign.
 * Nothing is stored: the nonce is an HMAC, made with your own secret, over the
 * domain, the handle and the times.
 */
declare function createChallenge(input: {
    domain: string;
    handle: string;
    statement?: string;
    ttlSeconds?: number;
    now?: Date;
} & GateConfig): Promise<SignInChallenge>;
/**
 * Sign in with Omnia, step two: check the agent's answer. It resolves the
 * handle's key from Omnia and checks the domain, the expiry, the nonce and
 * the signature. An answer is accepted once.
 */
declare function verifySignIn(input: {
    challenge: SignInChallenge;
    signature: string;
    domain: string;
    now?: Date;
} & GateConfig): Promise<{
    ok: true;
    agent: GateAgent;
} | {
    ok: false;
    reason: SignInFailure;
}>;
/**
 * Charge for a request. Without a payment the answer is 402 with an x402
 * offer. With one, Omnia checks and settles it, and the request goes through
 * with a PAYMENT-RESPONSE header. The payment settles before your handler runs.
 *
 * A refusal the payer can remedy is answered 402 with Omnia's code and details:
 * `approval_required` (the wallet's first payment needs a USDC permit),
 * `sponsorship_unavailable` (the payer submits the payment and pays its own gas)
 * and `stale_transaction`. The Omnia SDK answers all three by itself.
 */
declare function charge(options: ChargeOptions & GateConfig): Guard<ChargeResult>;
/**
 * Check the `x-omnia-receipt` header that the Omnia store gateway attaches
 * when it forwards a paid call to a publisher's endpoint. A valid receipt
 * means the call was paid for. `relayer` is the relayer's public address.
 */
declare function verifyReceipt(headerValue: string | null | undefined, options: {
    relayer: string;
    maxAgeSeconds?: number;
    slug?: string;
    now?: number;
}): Promise<{
    ok: true;
    receipt: Receipt;
} | {
    ok: false;
    reason: ReceiptFailure;
}>;
interface Gate {
    /** Check who is calling. See `requirePassport`. */
    requirePassport(options?: PassportOptions): Guard<PassportResult>;
    /** Charge for a request. See `charge`. */
    charge(options: ChargeOptions): Guard<ChargeResult>;
    createChallenge(input: {
        domain: string;
        handle: string;
        statement?: string;
        ttlSeconds?: number;
        now?: Date;
    }): Promise<SignInChallenge>;
    verifySignIn(input: {
        challenge: SignInChallenge;
        signature: string;
        domain: string;
        now?: Date;
    }): Promise<{
        ok: true;
        agent: GateAgent;
    } | {
        ok: false;
        reason: SignInFailure;
    }>;
    /** Check a store gateway receipt against the Omnia relayer. */
    verifyReceipt(headerValue: string | null | undefined, options?: {
        relayer?: string;
        maxAgeSeconds?: number;
        slug?: string;
    }): ReturnType<typeof verifyReceipt>;
    /** Look up an agent's passport, with the same five minute memory the guards use. */
    lookup(handle: string): Promise<GateAgent | null>;
}
/** Gate with its settings given once. With no arguments it reads `OMNIA_HANDLE`, `OMNIA_SECRET_KEY` and `OMNIA_URL`. */
declare function createGate(config?: GateConfig): Gate;

/**
 * Thin adapters that put a Gate guard in front of a handler: Express-style
 * `(req, res, next)`, Fetch-style route handlers (Next.js, Bun, Deno,
 * Cloudflare Workers) and Hono. None of them imports a framework.
 */

/** What the guards learned about a request. */
interface GateInfo {
    /** Set by `requirePassport`. */
    agent?: GateAgent;
    /** Set by `charge`. */
    payment?: GatePayment;
}
type AnyGuard = Guard<GuardResult>;
/** The core shape: a request in, and either the response to send instead or null to let it through. */
declare function asMiddleware(guard: AnyGuard | AnyGuard[]): (req: Request) => Promise<Response | null>;
/**
 * Wrap a route handler. The guards run first, in order. When they pass, the
 * handler gets what they learned as its third argument, and the headers of a
 * settled payment are added to its response.
 */
declare function withGate<C = unknown>(guard: AnyGuard | AnyGuard[], handler: (req: Request, ctx: C, omnia: GateInfo) => Response | Promise<Response>): (req: Request, ctx: C) => Promise<Response>;
interface HonoContext {
    req: {
        raw: Request;
    };
    set(key: string, value: unknown): void;
    header(name: string, value: string): void;
}
/** Hono middleware. What the guards learned is at `c.get("omnia")`. */
declare function honoGate(guard: AnyGuard | AnyGuard[]): (c: HonoContext, next: () => Promise<void>) => Promise<Response | void>;
/** The parts of a Node request this adapter reads. Express, Connect, Fastify's raw request and plain `http` all fit. */
interface NodeRequestLike {
    method?: string;
    url?: string;
    originalUrl?: string;
    protocol?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
    rawBody?: unknown;
    readableEnded?: boolean;
    socket?: {
        encrypted?: boolean;
    } | null;
    omnia?: GateInfo;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}
interface NodeResponseLike {
    statusCode: number;
    setHeader(name: string, value: string): unknown;
    end(body?: string): unknown;
}
/**
 * Express-style middleware. When the guards pass, what they learned is at
 * `req.omnia` (`req.omnia.agent`, `req.omnia.payment`).
 */
declare function expressGate(guard: AnyGuard | AnyGuard[]): (req: NodeRequestLike, res: NodeResponseLike, next: (error?: unknown) => void) => Promise<void>;

export { type Allowed, type ChargeOptions, type ChargeResult, DEFAULT_OMNIA_URL, type Denied, type Gate, type GateAgent, type GateConfig, GateError, type GateInfo, type GatePayment, type Guard, type GuardResult, type NodeRequestLike, type NodeResponseLike, type NonceStore, OMNIA_RELAYER, type PassportOptions, type PassportResult, type Receipt, type ReceiptFailure, type SignInChallenge, type SignInFailure, asMiddleware, charge, createChallenge, createGate, expressGate, honoGate, memoryNonceStore, requirePassport, verifyReceipt, verifySignIn, withGate };
