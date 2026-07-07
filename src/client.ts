/**
 * `@snapnedit/sdk` — a zero-runtime-dependency, isomorphic (Node 18+ /
 * browser) client for the snapnedit AI operations HTTP api. Talks to the
 * api purely over `fetch`; nothing here ever touches `node:crypto`, `zod`,
 * or any other package-specific runtime.
 *
 * Type-only coupling to `@snapnedit/shared`: every import from that
 * package below is `import type` (`ErrorCode`, `JobStatus`, `OperationId`,
 * `SignedUrl`). `@snapnedit/shared`'s package barrel (`src/index.ts`)
 * re-exports `hash.ts` and `session.ts`, both of which import `node:crypto`
 * at the top level, and `schemas.ts`, which imports `zod` — importing
 * *any* runtime binding from `@snapnedit/shared` (even one that itself
 * looks innocuous, like `OPERATION_IDS`) would pull that whole barrel's
 * runtime graph into this package's bundle, breaking both the "zero
 * runtime deps" and "isomorphic/browser-safe" requirements. `type`-only
 * imports are erased entirely by `tsc`, so none of that graph survives
 * into `dist/`. Response bodies are validated by hand (see the
 * `validate*`/`asRecord`/`asString` helpers below and `errors.ts`'s
 * `asErrorCode`) rather than by re-using `@snapnedit/shared`'s zod schemas,
 * for the same reason.
 */
import type { ErrorCode, JobStatus, OperationId, SignedUrl } from '@snapnedit/shared';
import { asErrorCode, SnapneditApiError, SnapneditTimeoutError } from './errors.js';

/**
 * Injectable fetch signature — a narrowed view of the global `fetch` that
 * every environment's real `fetch` (Node 18+'s undici-backed global,
 * browsers') satisfies structurally. Production code defaults to the
 * global `fetch`; tests inject a scripted fake so the whole client can be
 * exercised with no live network. Intentionally NOT wrapped in an SSRF
 * guard (contrast `@snapnedit/providers`' `FetchLike`) — this client
 * always talks to one caller-configured `baseUrl` the SDK consumer already
 * trusts, not to arbitrary third-party URLs derived from untrusted input.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Raw bytes a caller may hand the SDK: works identically in Node and the browser. */
export type BinaryInput = Uint8Array | Blob;

export interface CreateClientOptions {
  /** Origin of the snapnedit api, e.g. `https://api.snapnedit.com` or `http://localhost:8787`. No trailing slash required. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` on every request to `baseUrl`. */
  apiKey: string;
  /** Defaults to the global `fetch`. Inject a fake for tests / non-standard runtimes. */
  fetch?: FetchLike;
}

export interface RunOptions {
  /** Extra operation params (e.g. `{ prompt: '...' }` for `generative-fill`). `maskAssetId` is set automatically when `mask` is provided — do not set it here. */
  params?: Record<string, unknown>;
  /** A second image to upload for mask-guided operations (`magic-eraser`, `generative-fill`). */
  mask?: BinaryInput;
  /** MIME type of `input` (and, if `mask` is a `Uint8Array`, of `mask` too). Inferred from `Blob.type` when omitted; defaults to `application/octet-stream`. */
  mime?: string;
  /** Delay between `GET /jobs/:id` polls. Default 1000ms. */
  pollIntervalMs?: number;
  /** Total budget for polling before {@link SnapneditTimeoutError} is thrown. Default 120_000ms. */
  timeoutMs?: number;
}

export interface RunResult {
  output: Uint8Array;
  mime: string;
}

export interface UploadResult {
  assetId: string;
}

export interface CreateJobResult {
  jobId: string;
  status: JobStatus;
}

export interface SnapneditClient {
  /**
   * The full flow: upload `input` (and `opts.mask`, if given) -> `POST
   * /jobs` -> poll `GET /jobs/:id` until terminal -> download the result.
   * Throws {@link SnapneditApiError} on a failed job or any non-2xx api
   * response (payment_required for a 402), or {@link SnapneditTimeoutError}
   * if polling exceeds `opts.timeoutMs`.
   */
  run(operation: OperationId, input: BinaryInput, opts?: RunOptions): Promise<RunResult>;
  /** Uploads one asset: `POST /uploads` -> `PUT <presigned url>` -> `POST /uploads/:id/confirm`. */
  upload(bytes: BinaryInput, mime?: string): Promise<UploadResult>;
  /** `POST /jobs`. `status` may already be terminal (`succeeded`) on a cache hit. */
  createJob(operation: OperationId, inputAssetId: string, params?: Record<string, unknown>): Promise<CreateJobResult>;
  /** `GET /jobs/:id`. Non-throwing on a non-terminal or `failed`/`canceled` status — just returns it. */
  getJob(jobId: string): Promise<JobStatus>;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Resolves a presigned url (`upload.url` / `download.url`) against `baseUrl`: passes an already-absolute url through unchanged, resolves a relative one (e.g. local dev's `/_local/...`) against `baseUrl`'s origin. */
function resolvePresignedUrl(baseUrl: string, maybeRelative: string): string {
  return new URL(maybeRelative, baseUrl).toString();
}

function isBlob(input: BinaryInput): input is Blob {
  return typeof Blob !== 'undefined' && input instanceof Blob;
}

function byteLength(input: BinaryInput): number {
  return isBlob(input) ? input.size : input.byteLength;
}

function defaultMime(input: BinaryInput): string {
  if (isBlob(input) && input.type) {
    return input.type;
  }
  return 'application/octet-stream';
}

function authHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

function errMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Response validation — every `fetch().json()` result is narrowed through
// one of these before it's trusted as a typed shape. No blind casts: each
// field is checked with `typeof`/membership before being assigned to its
// typed slot.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, field: string, sourceUrl: string): string {
  if (typeof value !== 'string') {
    throw new SnapneditApiError('internal', 0, `${sourceUrl} response is missing string field "${field}"`);
  }
  return value;
}

function validateSignedUrl(value: unknown, sourceUrl: string): SignedUrl {
  const rec = asRecord(value);
  if (!rec) {
    throw new SnapneditApiError('internal', 0, `${sourceUrl} response is missing a signed-url object`);
  }
  return { url: asString(rec.url, 'url', sourceUrl), expiresAt: asString(rec.expiresAt, 'expiresAt', sourceUrl) };
}

function validateUploadResponse(json: unknown, sourceUrl: string): { assetId: string; upload: SignedUrl } {
  const rec = asRecord(json);
  if (!rec) {
    throw new SnapneditApiError('internal', 0, `${sourceUrl} returned a malformed upload response`);
  }
  return { assetId: asString(rec.assetId, 'assetId', sourceUrl), upload: validateSignedUrl(rec.upload, sourceUrl) };
}

function validateConfirmResponse(json: unknown, sourceUrl: string): { assetId: string } {
  const rec = asRecord(json);
  if (!rec) {
    throw new SnapneditApiError('internal', 0, `${sourceUrl} returned a malformed confirm response`);
  }
  return { assetId: asString(rec.assetId, 'assetId', sourceUrl) };
}

function validateJobStatus(json: unknown, sourceUrl: string): JobStatus {
  const rec = asRecord(json);
  if (!rec) {
    throw new SnapneditApiError('internal', 0, `${sourceUrl} returned a malformed job status`);
  }
  const state = rec.state;
  switch (state) {
    case 'queued':
      return { state: 'queued' };
    case 'processing':
      return { state: 'processing', startedAt: asString(rec.startedAt, 'startedAt', sourceUrl) };
    case 'succeeded':
      return {
        state: 'succeeded',
        outputAssetId: asString(rec.outputAssetId, 'outputAssetId', sourceUrl),
        download: validateSignedUrl(rec.download, sourceUrl),
      };
    case 'failed':
      return {
        state: 'failed',
        errorCode: asErrorCode(rec.errorCode),
        message: asString(rec.message, 'message', sourceUrl),
      };
    case 'canceled':
      return { state: 'canceled' };
    default:
      throw new SnapneditApiError('internal', 0, `${sourceUrl} returned an unknown job state: ${String(state)}`);
  }
}

function validateCreateJobResponse(json: unknown, sourceUrl: string): { jobId: string; status: JobStatus } {
  const rec = asRecord(json);
  if (!rec) {
    throw new SnapneditApiError('internal', 0, `${sourceUrl} returned a malformed job-create response`);
  }
  return { jobId: asString(rec.jobId, 'jobId', sourceUrl), status: validateJobStatus(rec.status, sourceUrl) };
}

/** `{ error: { code, message } }` — the uniform error body every api route sends on a non-2xx (see `apps/api/src/http-errors.ts`'s `sendError`). */
async function parseErrorResponse(response: Response, url: string): Promise<SnapneditApiError> {
  const fallback = (): SnapneditApiError =>
    new SnapneditApiError('internal', response.status, `request to ${url} failed with status ${response.status}`);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return fallback();
  }

  const errObj = asRecord(asRecord(json)?.error);
  if (!errObj) {
    return fallback();
  }

  const code: ErrorCode = asErrorCode(errObj.code);
  const message = typeof errObj.message === 'string' ? errObj.message : fallback().message;
  return new SnapneditApiError(code, response.status, message);
}

/** Runs one request; non-2xx -> throws a typed {@link SnapneditApiError} (see {@link parseErrorResponse}); 2xx -> parses+validates the JSON body via `validate`. */
async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  validate: (json: unknown, sourceUrl: string) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    throw new SnapneditApiError('internal', 0, `network error calling ${url}: ${errMessage(cause)}`);
  }

  if (!response.ok) {
    throw await parseErrorResponse(response, url);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (cause) {
    throw new SnapneditApiError('internal', response.status, `${url} returned a non-JSON 2xx response: ${errMessage(cause)}`);
  }

  return validate(json, url);
}

function isTerminal(status: JobStatus): boolean {
  return status.state === 'succeeded' || status.state === 'failed' || status.state === 'canceled';
}

export function createClient(options: CreateClientOptions): SnapneditClient {
  const baseUrl = options.baseUrl;
  const apiKey = options.apiKey;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  function apiUrl(path: string): string {
    return `${trimTrailingSlash(baseUrl)}${path}`;
  }

  async function upload(bytes: BinaryInput, mime?: string): Promise<UploadResult> {
    const resolvedMime = mime ?? defaultMime(bytes);
    const declaredBytes = byteLength(bytes);

    const createUrl = apiUrl('/uploads');
    const created = await requestJson(
      fetchImpl,
      createUrl,
      {
        method: 'POST',
        headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mime: resolvedMime, bytes: declaredBytes }),
      },
      validateUploadResponse,
    );

    // The presigned PUT url is self-authenticating (query-string signature
    // for local dev; a real cloud provider's presigned-URL scheme in prod)
    // — deliberately NOT sent with an `Authorization: Bearer` header, which
    // some presigned-URL schemes (e.g. S3 SigV4) reject outright as a
    // conflicting second auth mechanism.
    const putUrl = resolvePresignedUrl(baseUrl, created.upload.url);
    let putResponse: Response;
    try {
      putResponse = await fetchImpl(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': resolvedMime },
        body: bytes,
      });
    } catch (cause) {
      throw new SnapneditApiError('internal', 0, `network error PUTting to ${putUrl}: ${errMessage(cause)}`);
    }
    if (!putResponse.ok) {
      throw new SnapneditApiError(
        'internal',
        putResponse.status,
        `PUT to ${putUrl} failed with status ${putResponse.status}`,
      );
    }

    const confirmUrl = apiUrl(`/uploads/${created.assetId}/confirm`);
    await requestJson(
      fetchImpl,
      confirmUrl,
      { method: 'POST', headers: authHeaders(apiKey) },
      validateConfirmResponse,
    );

    return { assetId: created.assetId };
  }

  async function createJob(
    operation: OperationId,
    inputAssetId: string,
    params: Record<string, unknown> = {},
  ): Promise<CreateJobResult> {
    const url = apiUrl('/jobs');
    return requestJson(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, inputAssetId, params }),
      },
      validateCreateJobResponse,
    );
  }

  async function getJob(jobId: string): Promise<JobStatus> {
    const url = apiUrl(`/jobs/${jobId}`);
    return requestJson(fetchImpl, url, { method: 'GET', headers: authHeaders(apiKey) }, validateJobStatus);
  }

  async function pollJob(jobId: string, opts: RunOptions): Promise<JobStatus> {
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const status = await getJob(jobId);
      if (isTerminal(status)) {
        return status;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SnapneditTimeoutError(
          `polling job ${jobId} exceeded timeoutMs (${timeoutMs}ms) without reaching a terminal state`,
        );
      }
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  async function downloadOutput(signed: SignedUrl): Promise<RunResult> {
    const url = resolvePresignedUrl(baseUrl, signed.url);
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET' });
    } catch (cause) {
      throw new SnapneditApiError('internal', 0, `network error downloading ${url}: ${errMessage(cause)}`);
    }
    if (!response.ok) {
      throw new SnapneditApiError('internal', response.status, `download from ${url} failed with status ${response.status}`);
    }
    const buf = await response.arrayBuffer();
    const mime = response.headers.get('content-type') ?? 'application/octet-stream';
    return { output: new Uint8Array(buf), mime };
  }

  async function run(operation: OperationId, input: BinaryInput, opts: RunOptions = {}): Promise<RunResult> {
    const inputMime = opts.mime ?? defaultMime(input);
    const { assetId: inputAssetId } = await upload(input, inputMime);

    const params: Record<string, unknown> = { ...(opts.params ?? {}) };
    if (opts.mask !== undefined) {
      const { assetId: maskAssetId } = await upload(opts.mask, opts.mime ?? defaultMime(opts.mask));
      params.maskAssetId = maskAssetId;
    }

    const created = await createJob(operation, inputAssetId, params);
    const finalStatus = isTerminal(created.status) ? created.status : await pollJob(created.jobId, opts);

    switch (finalStatus.state) {
      case 'succeeded':
        return downloadOutput(finalStatus.download);
      case 'failed':
        throw new SnapneditApiError(finalStatus.errorCode, 200, finalStatus.message);
      case 'canceled':
        throw new SnapneditApiError('internal', 200, `job ${created.jobId} was canceled`);
      case 'queued':
      case 'processing':
        // Unreachable: `finalStatus` is always `pollJob`'s (terminal-only)
        // return value, or `created.status` when `isTerminal` already
        // confirmed it terminal. Handled explicitly (rather than a
        // non-exhaustive cast) so `JobStatus` gaining a new state is a
        // compile error here, not a silent runtime fallthrough.
        throw new SnapneditTimeoutError(`job ${created.jobId} did not reach a terminal state`);
    }
  }

  return { run, upload, createJob, getJob };
}
