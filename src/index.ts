/**
 * omnia-gate: make a site or an API ready for AI agents.
 *
 *   requirePassport  who is calling, proven by a signed request
 *   createChallenge  Sign in with Omnia, with no forms and no passwords
 *   verifySignIn
 *   charge           payment per request, in USDC on Elysium through x402
 *   verifyReceipt    proof that a call forwarded by the Omnia store was paid
 *
 * Gate is non-custodial: it never sees a payer's key and never holds funds.
 */
export * from "./gate";
export * from "./adapters";
export type { SignInChallenge } from "../../sdk/src/protocol";
