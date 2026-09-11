import type { ErrorCode } from '@snapnedit/shared';

/**
 * Typed error for a non-2xx api response OR a job that reached `state:
 * 'failed'`. Carries the api's `ErrorCode` (imported as a TYPE ONLY — see
 * this package's README/report for why the SDK never imports a runtime
 * value from `@snapnedit/shared`) alongside the HTTP status that produced
 * it, so callers can branch on `err.code` without string-matching
 * `err.message`.
 *
 * A 402 `payment_required` response (insufficient credits / free-tier
 * limit) surfaces as this error with `code === 'payment_required'` — no
 * separate error class, since the shape callers need (`code`, `status`,
 * `message`) is identical to every other typed api error.
 */
export class SnapneditApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number, message: string) {
    super(message);
    this.name = 'SnapneditApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Thrown by {@link import('./client.js').createClient}'s `run()` when
 * polling `GET /jobs/:id` never reaches a terminal state within
 * `opts.timeoutMs`. Distinct from {@link SnapneditApiError} because a
 * client-side poll timeout isn't an api response at all — there is no
 * `ErrorCode`/HTTP status to attach.
 */
export class SnapneditTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapneditTimeoutError';
  }
}

/**
 * Mirrors `@snapnedit/shared`'s `ERROR_CODES` runtime array. Duplicated
 * (never imported) because importing anything but *types* from
 * `@snapnedit/shared` would pull that package's index barrel — which
 * transitively imports `node:crypto` (`hash.ts`, `session.ts`) and `zod` —
 * into this zero-runtime-dependency, browser-safe package. See
 * `packages/sdk/src/client.ts`'s module doc comment for the full rationale.
 *
 * Kept in sync by hand with `packages/shared/src/errors.ts`. An error code
 * the api sends that isn't (yet) in this list still round-trips safely —
 * {@link asErrorCode} falls back to `'internal'` — so drift degrades
 * gracefully instead of throwing.
 */
const KNOWN_ERROR_CODES = [
  'invalid_input',
  'unsupported_mime',
  'too_large',
  'not_found',
  'provider_failed',
  'provider_exhausted',
  'rate_limited',
  'bot_check_failed',
  'unauthorized',
  'forbidden',
  'payment_required',
  'internal',
] as const;

/**
 * Narrows an arbitrary (but already-known-to-be-`unknown`) response field
 * to `ErrorCode`, validated by membership in {@link KNOWN_ERROR_CODES}
 * rather than a blind cast. Falls back to `'internal'` for anything that
 * isn't a recognized code (including a non-string value), so a future api
 * error code this list hasn't been updated for still produces a usable
 * (if generic) typed error instead of throwing while parsing the error
 * response itself.
 */
export function asErrorCode(value: unknown): ErrorCode {
  if (typeof value === 'string' && (KNOWN_ERROR_CODES as readonly string[]).includes(value)) {
    return value as ErrorCode;
  }
  return 'internal';
}
