/**
 * Outbound-webhook types + signature verification for `@snapnedit/sdk`
 * consumers. A snapnedit account with an API key can register endpoint URLs
 * that receive a signed HTTP POST every time one of its jobs finishes; this
 * module gives those receivers the TYPES of the delivery body and a
 * `verifyWebhookSignature` helper to authenticate the `X-Snapnedit-Signature`
 * header before trusting a payload.
 *
 * Kept crypto-runtime-free in the same spirit as the rest of this package
 * (see `client.ts`'s module doc): verification uses the isomorphic Web Crypto
 * API (`globalThis.crypto.subtle`, present in Node 18+ and every modern
 * browser) rather than `node:crypto`, so the whole SDK stays zero-runtime-dep
 * and browser-safe. Because Web Crypto's HMAC is async, so is
 * {@link verifyWebhookSignature}.
 *
 * The types below MIRROR the server's `@snapnedit/db` webhook contract by
 * hand (they are NOT imported — importing from `@snapnedit/db` would pull
 * Drizzle/`pg`/`node:crypto` into this browser-safe bundle). They are the
 * exact shape a receiver parses out of a delivery's JSON body.
 */

/**
 * Kind of event an outbound webhook carries. A deliberately-open string union
 * (mirrors the server's `WebhookEventType`) so new event types can be added
 * without a breaking change — a receiver should treat an unrecognized `type`
 * as a forward-compatible no-op rather than an error.
 */
export type WebhookEventType = 'job.succeeded' | 'job.failed';

/**
 * The bring-your-own-storage envelope every job event carries: which kind of
 * input the job had, whether it had a delivery destination, and how that
 * delivery went. Mirrors what `GET /jobs/:id` reports — and, like that
 * endpoint, never the input url, the destination url or its headers, which
 * are bearer credentials for the caller's own bucket.
 */
export interface WebhookJobEnvelope {
  input: { kind: 'asset' | 'url' };
  destination: { type: 'presigned-put' } | null;
  delivery: {
    status: 'pending' | 'delivered' | 'failed';
    attempts: number;
    deliveredAt?: string;
    statusCode?: number;
    error?: string;
  } | null;
  /** Credits actually debited for the job (0 for free operations, cache hits and delivery-only rows). Absent on events from servers that predate usage tracking. */
  creditCost?: number;
  /** True when the job was satisfied from the result cache. */
  cached?: boolean;
  /** True when the job only delivered an already-cached result to a destination. */
  deliveryOnly?: boolean;
}

/**
 * The `data` object inside a delivery body, discriminated by `status`. For a
 * `job.succeeded` event it carries the output asset (and an optional signed
 * `download` URL); for `job.failed` it carries the machine-readable
 * `errorCode` plus a human `message`. `operation` is the operation id as an
 * opaque string (e.g. `'remove-background'`). Both carry the
 * {@link WebhookJobEnvelope}.
 *
 * A `job.succeeded` event with `delivery.status === 'failed'` is a real
 * combination and not a contradiction: the job ran fine, only the PUT into
 * the caller's bucket did not — the result is still at `download`.
 */
export type WebhookEventData =
  | ({ jobId: string; operation: string; status: 'succeeded'; outputAssetId: string; download?: string } & WebhookJobEnvelope)
  | ({ jobId: string; operation: string; status: 'failed'; errorCode: string; message: string } & WebhookJobEnvelope);

/**
 * The full JSON body POSTed to a developer endpoint: `{ id, type, created,
 * data }`. `id` is the delivery id (also echoed in `X-Snapnedit-Delivery`),
 * `type` the {@link WebhookEventType} (also in `X-Snapnedit-Event`), `created`
 * unix seconds, `data` the {@link WebhookEventData}.
 */
export interface WebhookDeliveryBody {
  id: string;
  type: WebhookEventType;
  created: number;
  data: WebhookEventData;
}

/** Header names snapnedit sets on every webhook delivery — mirror of the server-side constants. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Snapnedit-Signature';
export const WEBHOOK_EVENT_HEADER = 'X-Snapnedit-Event';
export const WEBHOOK_DELIVERY_HEADER = 'X-Snapnedit-Delivery';

/** Options for {@link verifyWebhookSignature}. */
export interface VerifyWebhookOptions {
  /**
   * If set, also reject a delivery whose signed timestamp `t` is more than
   * this many seconds away from `now` — replay protection. Omit (the default)
   * to verify the signature only. Stripe-style receivers typically pass `300`.
   */
  toleranceSeconds?: number;
  /**
   * Current time in unix SECONDS, used only for the `toleranceSeconds` check.
   * Defaults to `Math.floor(Date.now() / 1000)`; inject a fixed value in
   * tests for determinism.
   */
  nowSeconds?: number;
}

/** Parsed form of an `X-Snapnedit-Signature: t=<unixSeconds>,v1=<hex>[,v1=<hex>...]` header. */
interface ParsedSignatureHeader {
  timestamp: number;
  /** Every `v1` value present (a rotation window can carry more than one). */
  signatures: string[];
}

/**
 * Parses `t=<unixSeconds>,v1=<hex>` (Stripe-style, comma-separated `k=v`
 * pairs; unknown keys ignored, `v1` may repeat). Returns `null` on any header
 * that lacks a numeric `t` or at least one `v1`.
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1' && value.length > 0) {
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Lower-case hex encoding of an `ArrayBuffer`. */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Constant-time equality for two equal-length ASCII strings — compares every
 * character regardless of where the first mismatch is, so verification time
 * doesn't leak how much of a forged signature was correct. Differing lengths
 * short-circuit to `false` (a length mismatch is not secret).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verifies an `X-Snapnedit-Signature` header against the raw request body and
 * an endpoint's plaintext signing secret.
 *
 * Recomputes the expected HMAC-SHA256 of `` `${t}.${rawBody}` `` (keyed by
 * `secret`, hex-encoded) — the exact string snapnedit signs — and compares it,
 * in constant time, against each `v1` in the header. `rawBody` MUST be the
 * exact bytes received (verify BEFORE `JSON.parse`; a re-serialized body may
 * differ). When `options.toleranceSeconds` is set, the signed timestamp must
 * also be within that many seconds of `options.nowSeconds` (default now).
 *
 * Returns `true` only when a signature matches (and, if requested, the
 * timestamp is fresh); `false` for a malformed header, a bad signature, or a
 * stale timestamp. It never throws for an untrusted header — a caller can
 * treat every falsy result the same way (reject the delivery).
 *
 * @example
 * ```ts
 * import { verifyWebhookSignature } from '@snapnedit/sdk';
 *
 * const raw = await request.text(); // raw body, unparsed
 * const ok = await verifyWebhookSignature(raw, request.headers.get('x-snapnedit-signature') ?? '', endpointSecret);
 * if (!ok) return new Response('bad signature', { status: 400 });
 * const event = JSON.parse(raw);
 * ```
 */
export async function verifyWebhookSignature(
  rawBody: string,
  header: string,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  if (options.toleranceSeconds !== undefined) {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - parsed.timestamp) > options.toleranceSeconds) return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(`${parsed.timestamp}.${rawBody}`));
  const expected = toHex(signed);

  return parsed.signatures.some((candidate) => timingSafeEqual(expected, candidate.toLowerCase()));
}
