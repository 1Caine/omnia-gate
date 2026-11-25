# omnia-gate

Make a site or an API ready for AI agents in a few lines.

Site: [omniasuper.app](https://omniasuper.app). Docs: [omniasuper.app/docs](https://omniasuper.app/docs). X: [@OmniaSuperApp](https://x.com/OmniaSuperApp).

- **Passport.** Know which agent is calling, proven by a signed request. No API keys to issue.
- **Sign in with Omnia.** Agents sign in with their Omnia ID. No forms and no passwords.
- **Charge.** Take a payment per request, in USDC on Solana through x402.

Gate is non-custodial. It never sees a payer's key and never holds funds. A paying agent sends USDC straight to your own wallet, with the platform fee as a split of the same Solana transaction.

## Install

```sh
npm install omnia-gate
```

Charging needs an Omnia ID for your site, because that is the wallet that gets paid. Create one with `npx -y omnia-cli init my-site`, then set two variables on your server:

```sh
OMNIA_HANDLE=my-site
OMNIA_SECRET_KEY=...   # from ~/.omnia/identity.json, kept on your server
```

The wallet must hold some USDC before it can be paid, so send it any amount once. Passport checks and sign-in need no Omnia ID of your own.

## Express

```js
import express from "express";
import { createGate, expressGate } from "omnia-gate";

const gate = createGate(); // reads OMNIA_HANDLE and OMNIA_SECRET_KEY
const app = express();

app.get("/report", expressGate(gate.charge({ price: "0.01" })), (req, res) => {
  res.json({ report: "the paid content", paidBy: req.omnia.payment.payer });
});
app.get("/whoami", expressGate(gate.requirePassport()), (req, res) => res.json(req.omnia.agent));
app.listen(3000);
```

## Next.js route handler

```ts
import { createGate, withGate } from "omnia-gate";

const gate = createGate(); // reads OMNIA_HANDLE and OMNIA_SECRET_KEY

export const GET = withGate(gate.charge({ price: "0.01", description: "Daily report" }), async (req, ctx, omnia) => {
  return Response.json({ report: "the paid content", paidBy: omnia.payment?.payer });
});
```

`withGate` works with any handler of the shape `(request) => Response`: Next.js, Bun, Deno and Cloudflare Workers. Pass a list to combine guards: `withGate([gate.requirePassport(), gate.charge({ price: "0.05" })], handler)`.

## Hono

```ts
import { Hono } from "hono";
import { createGate, honoGate } from "omnia-gate";

const gate = createGate();
const app = new Hono();
app.get("/report", honoGate(gate.charge({ price: "0.01" })), (c) => c.json({ report: "the paid content", paidBy: c.get("omnia").payment.payer }));
```

## The core

Everything is built on one shape. A guard takes a Fetch `Request` and answers either `{ ok: true, ... }` or `{ ok: false, response }`, where `response` is what to send instead. `asMiddleware(guard)` turns that into `(request) => Promise<Response | null>` for frameworks not listed here.

### `requirePassport(options?)`

Checks the four signed request headers (`x-omnia-id`, `x-omnia-ts`, `x-omnia-nonce`, `x-omnia-sig`) and returns the agent: `{ handle, id, address, ownerVerified }`.

- The agent's key is resolved from `GET {omnia}/api/v1/agents/{handle}` and kept in memory for five minutes.
- A signed request is accepted once. Used nonces are kept in memory, which covers one process. With several servers, pass a shared `nonceStore`.
- The signature covers the method, the path with its query, and the body. The path must be the path the agent called on your site. Behind a proxy that rewrites paths, pass `path: (req) => ...`.
- In Express, put Gate before your body parser, or keep the raw bytes in `req.rawBody`. The signature is made over the exact bytes of the body.

An agent calls your site with the Omnia SDK like this:

```ts
await omnia.fetch("https://your.site/orders", { method: "POST", body: JSON.stringify(order) }, { sign: true });
```

### `createChallenge(...)` and `verifySignIn(...)`

```ts
const challenge = await gate.createChallenge({ domain: "your.site", handle: "scout" });
// Send the challenge to the agent. It answers with omnia.signIn(challenge).
const result = await gate.verifySignIn({ challenge, signature, domain: "your.site" });
if (result.ok) startSession(result.agent);
```

Nothing is stored between the two steps. The nonce is an HMAC, made with your own secret, over the domain, the handle and the times, so only a challenge your site issued verifies. The check covers the domain, the expiry, the nonce and the signature, and an answer is accepted once. The secret comes from `signInSecret`, then `OMNIA_GATE_SECRET`, and is otherwise derived from your site's key.

### `charge({ price, description? })`

Without a payment, the answer is 402 with an x402 version 2 offer in the `PAYMENT-REQUIRED` header. Gate asks Omnia to build the offer (`POST /api/v1/facilitator/offer`, signed as your site). On the paid retry it asks Omnia to check and settle the payment (`POST /api/v1/facilitator/settle`). When the payment has confirmed, the request goes through and the response carries a `PAYMENT-RESPONSE` header.

- `price` is a decimal USDC string such as `"0.01"`, or micros as a `bigint`.
- The payment settles before your handler runs. If your handler can fail, refund the payer yourself or make the handler safe to retry.
- `payTo` sends the money to another wallet than your site's own.
- The Omnia relayer pays the Solana network fee of a payer's first 200 payments each day, so your site needs USDC only and so do most payers. Past that a payer pays its own network fee, and the payment settles the same way.

An agent pays your site with the Omnia SDK like this:

```ts
const res = await omnia.fetch("https://your.site/report", {}, { maxPrice: "0.01" });
```

### `verifyReceipt(headerValue, { relayer })`

For publishers in the Omnia store. When the store gateway forwards a paid call to your endpoint, it attaches an `x-omnia-receipt` header signed by the Omnia relayer. A valid receipt means the call was paid for, so your endpoint can refuse everything else.

```ts
import { verifyReceipt, OMNIA_RELAYER } from "omnia-gate";

const check = await verifyReceipt(request.headers.get("x-omnia-receipt"), { relayer: OMNIA_RELAYER, slug: "my-tool" });
if (!check.ok) return new Response("Not paid", { status: 402 });
```

The receipt names the program, the payment, the payer and the amount, and is refused when it is older than five minutes (`maxAgeSeconds`).

## Settings

`createGate(config)` and every standalone function take the same settings.

| Setting | Default | What it is |
| --- | --- | --- |
| `omniaUrl` | `OMNIA_URL`, then the public deployment | The Omnia deployment to use. |
| `handle`, `secretKey` | `OMNIA_HANDLE`, `OMNIA_SECRET_KEY` | Your site's own Omnia ID, for `charge`. |
| `signInSecret` | `OMNIA_GATE_SECRET`, then derived from your key | The secret behind sign-in nonces. |
| `keyTtlMs` | 300000 | How long a resolved passport is kept. |
| `skewSeconds` | 60 | How far a request's timestamp may be from your clock. |
| `nonceStore` | in memory | Where used nonces are kept. |

## License

MIT
