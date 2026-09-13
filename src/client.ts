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
// The bring-your-own-storage wire types come from the `@snapnedit/shared`
// SUBPATH (`/jobRequest`), not its barrel — and, like every other import in
// this file, `import type` only. `jobRequest.ts` is itself browser-safe (its
// only import is `zod`), but importing a *value* from it would still put zod
// in this package's runtime graph; taking the types alone keeps the "zero
// runtime dependencies" promise intact while guaranteeing the SDK and the api
// describe a destination with literally the same type.
import type { JobDelivery, JobDestination, JobInputKind } from '@snapnedit/shared/jobRequest';
import type { DesignDocument, DesignSpec, MultiPageDesignSpec, RenderDesignInput } from './design.js';
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

/**
 * BRING YOUR OWN STORAGE, input half: an image that is ALREADY in the
 * caller's own bucket, named by a url the SERVER fetches — so the bytes never
 * pass through the caller's process at all, and no `POST /uploads` happens.
 *
 * Use a short-lived presigned GET (or any publicly reachable https url). The
 * api accepts https only, refuses private/loopback/link-local/metadata
 * addresses, follows no redirects, times out at 30s and stops reading at the
 * same size ceiling `POST /uploads` enforces. A fetch that fails for any of
 * those reasons is a terminal `input_fetch_failed` job failure with the
 * credits refunded.
 *
 * Requires an API key (or embed token): an anonymous caller supplying one
 * gets a `403 forbidden`.
 */
export interface JobUrlInput {
  url: string;
}

/** A job's input: an uploaded asset id (`upload()`'s `assetId`) or an external {@link JobUrlInput}. */
export type JobInputRef = string | JobUrlInput;

/**
 * The bring-your-own-storage half of a job's representation, present on
 * {@link CreateJobResult}, {@link JobView} and {@link RunResult}.
 *
 * Note what is NOT here: the input url, the destination url and the
 * destination headers. The api never echoes those back — a presigned url is a
 * bearer credential for the caller's bucket — so a caller only learns WHICH
 * KIND of input the job had, THAT a destination exists, and how delivery went.
 */
export interface JobEnvelope {
  input: { kind: JobInputKind };
  destination: { type: 'presigned-put' } | null;
  delivery: JobDelivery | null;
}

/** What `GET /jobs/:id` returns: the job's {@link JobStatus} plus its {@link JobEnvelope}. */
export type JobView = JobStatus & JobEnvelope;

export interface CreateClientOptions {
  /** Origin of the snapnedit api, e.g. `https://api.snapnedit.com` or `http://localhost:8787`. No trailing slash required. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` on every request to `baseUrl`. */
  apiKey: string;
  /** Defaults to the global `fetch`. Inject a fake for tests / non-standard runtimes. */
  fetch?: FetchLike;
}

/** Options for {@link SnapneditClient.createJob}. */
export interface CreateJobOptions {
  /**
   * BRING YOUR OWN STORAGE, output half: a presigned PUT the server delivers
   * the RESULT bytes to, so they never round-trip through the caller. The
   * wire type verbatim — `{ type: 'presigned-put', url, headers? }`.
   *
   * `headers` are the ones the presigned signature requires; only
   * `content-type`, `cache-control`, `content-disposition` and `x-amz-*` /
   * `x-goog-*` / `x-ms-*` are accepted (at most 16), anything else is a `400`.
   * Requires an API key (or embed token) — anonymous gets a `403 forbidden`.
   */
  destination?: JobDestination;
}

export interface RunOptions extends CreateJobOptions {
  /** Extra operation params (e.g. `{ prompt: '...' }` for `generative-fill`). `maskAssetId` is set automatically when `mask` is provided — do not set it here. */
  params?: Record<string, unknown>;
  /** A second image to upload for mask-guided operations (`magic-eraser`, `generative-fill`). Masks are asset-only — there is no url form. */
  mask?: BinaryInput;
  /** MIME type of `input` (and, if `mask` is a `Uint8Array`, of `mask` too). Inferred from `Blob.type` when omitted; defaults to `application/octet-stream`. Ignored for a {@link JobUrlInput}, whose type the server sniffs from the fetched bytes. */
  mime?: string;
  /** Delay between `GET /jobs/:id` polls. Default 1000ms. */
  pollIntervalMs?: number;
  /** Total budget for polling before {@link SnapneditTimeoutError} is thrown. Default 120_000ms. */
  timeoutMs?: number;
  /**
   * Whether `run()` should download the result bytes itself.
   *
   * Defaults to TRUE for an ordinary run, and to FALSE when a
   * {@link CreateJobOptions.destination} was given AND the server reports
   * `delivery.status === 'delivered'` — the whole point of a destination is
   * that the bytes go straight to the caller's bucket, so pulling them back
   * through this process would undo it. A delivery that FAILED still
   * downloads by default, so a caller is never left empty-handed.
   *
   * Set it explicitly to override either way: `true` to get the bytes as well
   * as the delivery, `false` to skip the download and just poll to completion.
   * The result always carries `download` (a presigned url) so a skipped
   * download can be performed later regardless.
   */
  download?: boolean;
}

/** Fields every {@link RunResult} carries, downloaded or not. */
interface RunResultBase extends JobEnvelope {
  /** Id of the job that produced this result. */
  jobId: string;
  /** Presigned url for the result, whether or not `run()` downloaded it. */
  download: SignedUrl;
}

/** A {@link RunResult} whose bytes were downloaded (the default). */
export interface RunDownloadedResult extends RunResultBase {
  downloaded: true;
  output: Uint8Array;
  mime: string;
}

/** A {@link RunResult} whose download was skipped — see {@link RunOptions.download}. The bytes are in the caller's bucket (`delivery`) and/or at `download.url`. */
export interface RunDeliveredResult extends RunResultBase {
  downloaded: false;
  output?: undefined;
  mime?: undefined;
}

/**
 * What `run()` resolves to. Discriminated by `downloaded`: the ordinary path
 * is `{ downloaded: true, output, mime, ... }`, and a delivered-to-your-bucket
 * run is `{ downloaded: false, ... }` with no bytes attached.
 */
export type RunResult = RunDownloadedResult | RunDeliveredResult;

export interface UploadResult {
  assetId: string;
}

export interface CreateJobResult extends JobEnvelope {
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
   *
   * Bring your own storage: pass `{ url }` as `input` to have the SERVER
   * fetch the image (no upload step at all), and/or `opts.destination` to
   * have it PUT the result straight into your bucket — in which case the
   * download is skipped by default and the returned {@link RunResult} is
   * `{ downloaded: false, delivery, download, ... }`. See
   * {@link RunOptions.download}.
   */
  run(operation: OperationId, input: BinaryInput | JobUrlInput, opts?: RunOptions): Promise<RunResult>;
  /** Uploads one asset: `POST /uploads` -> `PUT <presigned url>` -> `POST /uploads/:id/confirm`. */
  upload(bytes: BinaryInput, mime?: string): Promise<UploadResult>;
  /**
   * `POST /jobs`. `input` is an uploaded asset id or a `{ url }` the server
   * fetches; `opts.destination` is a presigned PUT for the result. `status`
   * may already be terminal (`succeeded`) on a cache hit.
   */
  createJob(
    operation: OperationId,
    input: JobInputRef,
    params?: Record<string, unknown>,
    opts?: CreateJobOptions,
  ): Promise<CreateJobResult>;
  /** `GET /jobs/:id`. Non-throwing on a non-terminal or `failed`/`canceled` status — just returns it, with the `input`/`destination`/`delivery` envelope. */
  getJob(jobId: string): Promise<JobView>;
  /**
   * CREATE a design from a declarative {@link DesignSpec} — `POST /designs`.
   * Returns the compiled editor `Document` (opaque; feed it to {@link renderDesign}
   * or load it in the editor). This is how an agent composes a design, not just
   * runs an image op.
   */
  createDesign(spec: DesignSpec): Promise<{ document: DesignDocument }>;
  /**
   * CREATE a MULTI-PAGE design — `POST /designs` with `{ pages: [...] }`.
   * Returns one compiled `Document` per page, in order.
   */
  createDesignPages(spec: MultiPageDesignSpec): Promise<{ documents: DesignDocument[] }>;
  /**
   * RENDER a design to image bytes — `POST /designs/render`, server-side (no
   * browser). Pass a `spec` OR an already-created `document` for a single-page
   * image (png/jpeg); pass `pages`/`documents` (or `format: 'pdf'`) for a PDF.
   */
  renderDesign(input: RenderDesignInput): Promise<Uint8Array>;
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

/**
 * True for the `{ url }` form of a job input. Checked structurally (a plain
 * object with a string `url`) rather than by excluding `Uint8Array`/`Blob`,
 * so it stays correct in a runtime where one of those globals is polyfilled
 * or absent — and a `Blob`, which has no `url` property, can never match.
 */
function isUrlInput(input: BinaryInput | JobInputRef): input is JobUrlInput {
  return typeof input === 'object' && input !== null && typeof (input as { url?: unknown }).url === 'string';
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

/**
 * Narrows the bring-your-own-storage envelope (`input` / `destination` /
 * `delivery`) off a job response.
 *
 * Deliberately LENIENT where the rest of this file is strict: an api that
 * predates bring-your-own-storage sends none of these keys, and a plain
 * upload-and-download caller must not start throwing against such a
 * deployment. A missing envelope therefore reads as the only thing it can
 * mean — an asset input, no destination, no delivery — while a PRESENT one is
 * still narrowed field by field, never cast.
 */
function validateJobEnvelope(rec: Record<string, unknown>): JobEnvelope {
  const input = asRecord(rec.input);
  const kind: JobInputKind = input?.kind === 'url' ? 'url' : 'asset';
  const destination = asRecord(rec.destination);
  const delivery = asRecord(rec.delivery);
  return {
    input: { kind },
    destination: destination?.type === 'presigned-put' ? { type: 'presigned-put' } : null,
    delivery: delivery ? validateJobDelivery(delivery) : null,
  };
}

/** Narrows a `delivery` object. An unrecognized `status` degrades to `'pending'` rather than throwing, for the same forward-compatibility reason {@link asErrorCode} falls back to `'internal'`. */
function validateJobDelivery(rec: Record<string, unknown>): JobDelivery {
  const status =
    rec.status === 'delivered' || rec.status === 'failed' || rec.status === 'pending' ? rec.status : 'pending';
  return {
    status,
    attempts: typeof rec.attempts === 'number' ? rec.attempts : 0,
    ...(typeof rec.deliveredAt === 'string' ? { deliveredAt: rec.deliveredAt } : {}),
    ...(typeof rec.statusCode === 'number' ? { statusCode: rec.statusCode } : {}),
    ...(typeof rec.error === 'string' ? { error: rec.error } : {}),
  };
}

/** `GET /jobs/:id`: the status union and the envelope, spread into one object by the api. */
function validateJobView(json: unknown, sourceUrl: string): JobView {
  const rec = asRecord(json);
  if (!rec) {
    throw new SnapneditApiError('internal', 0, `${sourceUrl} returned a malformed job status`);
  }
  return { ...validateJobStatus(rec, sourceUrl), ...validateJobEnvelope(rec) };
}

function validateCreateJobResponse(json: unknown, sourceUrl: string): CreateJobResult {
  const rec = asRecord(json);
  if (!rec) {
    throw new SnapneditApiError('internal', 0, `${sourceUrl} returned a malformed job-create response`);
  }
  return {
    jobId: asString(rec.jobId, 'jobId', sourceUrl),
    status: validateJobStatus(rec.status, sourceUrl),
    ...validateJobEnvelope(rec),
  };
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
    input: JobInputRef,
    params: Record<string, unknown> = {},
    opts: CreateJobOptions = {},
  ): Promise<CreateJobResult> {
    const url = apiUrl('/jobs');
    // Exactly one of `inputAssetId` / `inputUrl` — the api rejects a body
    // carrying both or neither, so the ref decides which key is emitted.
    const inputBody = isUrlInput(input) ? { inputUrl: input.url } : { inputAssetId: input };
    return requestJson(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation,
          ...inputBody,
          params,
          ...(opts.destination !== undefined ? { destination: opts.destination } : {}),
        }),
      },
      validateCreateJobResponse,
    );
  }

  async function getJob(jobId: string): Promise<JobView> {
    const url = apiUrl(`/jobs/${jobId}`);
    return requestJson(fetchImpl, url, { method: 'GET', headers: authHeaders(apiKey) }, validateJobView);
  }

  async function pollJob(jobId: string, opts: RunOptions): Promise<JobView> {
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

  async function downloadOutput(signed: SignedUrl): Promise<{ output: Uint8Array; mime: string }> {
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

  async function run(
    operation: OperationId,
    input: BinaryInput | JobUrlInput,
    opts: RunOptions = {},
  ): Promise<RunResult> {
    // A `{ url }` input skips the upload entirely — the server fetches those
    // bytes itself. Anything else is uploaded first, exactly as before.
    const inputRef: JobInputRef = isUrlInput(input) ? input : (await upload(input, opts.mime ?? defaultMime(input))).assetId;

    const params: Record<string, unknown> = { ...(opts.params ?? {}) };
    if (opts.mask !== undefined) {
      // `opts.mime` describes `input`, not `mask` — a mask uploaded as a
      // `Blob` carries its own declared type (`Blob.type`), which wins over
      // `opts.mime` for the mask's upload. Only a non-`Blob` (`Uint8Array`)
      // mask, which has no type of its own to report, falls back to
      // `opts.mime` (then the generic binary default).
      const maskMime = isBlob(opts.mask) ? defaultMime(opts.mask) : (opts.mime ?? defaultMime(opts.mask));
      const { assetId: maskAssetId } = await upload(opts.mask, maskMime);
      params.maskAssetId = maskAssetId;
    }

    const created = await createJob(
      operation,
      inputRef,
      params,
      opts.destination !== undefined ? { destination: opts.destination } : {},
    );
    const final: JobView = isTerminal(created.status)
      ? { ...created.status, input: created.input, destination: created.destination, delivery: created.delivery }
      : await pollJob(created.jobId, opts);
    const finalStatus: JobStatus = final;

    switch (finalStatus.state) {
      case 'succeeded': {
        const envelope: JobEnvelope = {
          input: final.input,
          destination: final.destination,
          delivery: final.delivery,
        };
        // A destination whose delivery SUCCEEDED is the one case where
        // pulling the bytes back through this process would defeat the
        // purpose — they are already in the caller's bucket. Everything else
        // (no destination at all, or a delivery that failed) downloads, so a
        // caller is never silently left with nothing. `opts.download`
        // overrides either way.
        const delivered = final.delivery?.status === 'delivered';
        const shouldDownload = opts.download ?? !(opts.destination !== undefined && delivered);
        const base = { jobId: created.jobId, download: finalStatus.download, ...envelope };
        if (!shouldDownload) {
          return { downloaded: false, ...base };
        }
        const { output, mime } = await downloadOutput(finalStatus.download);
        return { downloaded: true, output, mime, ...base };
      }
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
        // compile error here, not a silent runtime fallthrough. A plain
        // `Error` (not `SnapneditTimeoutError`) — this is an internal
        // invariant violation in this client's own control flow, not the
        // distinct "polling actually ran out of time" condition
        // `SnapneditTimeoutError` means (see `pollJob`, the only genuine
        // throw site for that error).
        throw new Error(`snapnedit sdk internal invariant violated: job ${created.jobId} resolved to non-terminal state "${finalStatus.state}" outside of polling`);
    }
  }

  async function createDesign(spec: DesignSpec): Promise<{ document: DesignDocument }> {
    const url = apiUrl('/designs');
    return requestJson(
      fetchImpl,
      url,
      { method: 'POST', headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(spec) },
      (json, sourceUrl) => {
        const rec = asRecord(json);
        const doc = rec ? asRecord(rec.document) : null;
        if (!doc) {
          throw new SnapneditApiError('internal', 0, `${sourceUrl} returned no document`);
        }
        return { document: doc };
      },
    );
  }

  async function createDesignPages(spec: MultiPageDesignSpec): Promise<{ documents: DesignDocument[] }> {
    const url = apiUrl('/designs');
    return requestJson(
      fetchImpl,
      url,
      { method: 'POST', headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(spec) },
      (json, sourceUrl) => {
        const rec = asRecord(json);
        const list = rec ? rec.documents : null;
        if (!Array.isArray(list)) {
          throw new SnapneditApiError('internal', 0, `${sourceUrl} returned no documents array`);
        }
        const documents = list.map((entry, i) => {
          const doc = asRecord(entry);
          if (!doc) {
            throw new SnapneditApiError('internal', 0, `${sourceUrl} returned a malformed document at index ${String(i)}`);
          }
          return doc;
        });
        return { documents };
      },
    );
  }

  async function renderDesign(input: RenderDesignInput): Promise<Uint8Array> {
    const url = apiUrl('/designs/render');
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
    } catch (cause) {
      throw new SnapneditApiError('internal', 0, `network error POSTing to ${url}: ${errMessage(cause)}`);
    }
    if (!res.ok) {
      throw new SnapneditApiError('internal', res.status, `${url} returned ${String(res.status)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  return { run, upload, createJob, getJob, createDesign, createDesignPages, renderDesign };
}
