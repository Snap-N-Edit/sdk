import { describe, expect, test } from 'vitest';
import { createClient, SnapneditApiError, SnapneditTimeoutError, type JobDestination, type RunResult } from '../src/index.js';

const baseUrl = 'http://localhost:8787';
const apiKey = 'sk_test_123';

type RecordedCall = { url: string; init?: RequestInit };
type Step = (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * Drives a `FetchLike` off an ordered `steps` script — call N gets
 * `steps[N]`'s response, matching this task's "scripted fetch, no live
 * network" testing brief. Once `steps` is exhausted, every further call
 * keeps getting the LAST step's response — used by the poll-timeout test
 * below, which doesn't know in advance how many `GET /jobs/:id` polls a
 * given `timeoutMs`/`pollIntervalMs` pair will produce.
 */
function scriptedFetch(steps: Step[]): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let cursor = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(init === undefined ? { url } : { url, init });
    const step = steps[cursor];
    if (cursor < steps.length - 1) {
      cursor += 1;
    }
    if (!step) {
      throw new Error(`scriptedFetch: no step scripted for call #${calls.length} (${String(init?.method)} ${url})`);
    }
    return step(url, init);
  };
  return { fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function noBody(status: number): Response {
  return new Response(null, { status });
}

/** Reads the `Authorization` header off a recorded call's `init`, via the real `Headers` API (handles every `HeadersInit` shape our client might send) rather than an unsafe cast. */
function authHeaderOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization');
}

function jsonBodyOf(init: RequestInit | undefined): unknown {
  return JSON.parse(String(init?.body ?? 'null'));
}

/**
 * Narrows a `RunResult` to the downloaded branch. `run()` skips the download
 * (and returns `{ downloaded: false }`, with no `output`) when a destination
 * delivered the bytes to the caller's bucket instead — see the
 * bring-your-own-storage suite at the bottom of this file — so a test that
 * wants bytes has to say so.
 */
function downloadedBytes(result: RunResult): number[] {
  if (!result.downloaded) {
    throw new Error('expected run() to have downloaded the result, got { downloaded: false }');
  }
  return Array.from(result.output);
}

const inputBytes = new Uint8Array([1, 2, 3, 4, 5]);
const maskBytes = new Uint8Array([10, 11, 12]);
const outputBytes = new Uint8Array([9, 8, 7, 6]);

describe('createClient().run — full success flow (upload -> job -> poll -> download)', () => {
  test('remove-background: returns the downloaded bytes+mime, and every api call (not the presigned PUT/download) carries Authorization: Bearer <apiKey>', async () => {
    const { fetch, calls } = scriptedFetch([
      // 0: POST /uploads
      (url, init) => {
        expect(url).toBe(`${baseUrl}/uploads`);
        expect(init?.method).toBe('POST');
        expect(jsonBodyOf(init)).toEqual({ mime: 'application/octet-stream', bytes: inputBytes.byteLength });
        return jsonResponse(200, {
          assetId: 'asset-in',
          upload: { url: '/_local/put-in', expiresAt: '2099-01-01T00:00:00.000Z' },
        });
      },
      // 1: PUT <presigned upload url>
      (url, init) => {
        expect(url).toBe(`${baseUrl}/_local/put-in`);
        expect(init?.method).toBe('PUT');
        return noBody(204);
      },
      // 2: POST /uploads/asset-in/confirm
      (url) => {
        expect(url).toBe(`${baseUrl}/uploads/asset-in/confirm`);
        return jsonResponse(200, { assetId: 'asset-in', contentHash: 'h1', bytes: inputBytes.byteLength });
      },
      // 3: POST /jobs
      (url, init) => {
        expect(url).toBe(`${baseUrl}/jobs`);
        expect(jsonBodyOf(init)).toEqual({ operation: 'remove-background', inputAssetId: 'asset-in', params: {} });
        return jsonResponse(202, { jobId: 'job-1', status: { state: 'queued' } });
      },
      // 4: GET /jobs/job-1 -> still processing
      (url) => {
        expect(url).toBe(`${baseUrl}/jobs/job-1`);
        return jsonResponse(200, { state: 'processing', startedAt: '2099-01-01T00:00:01.000Z' });
      },
      // 5: GET /jobs/job-1 -> succeeded
      (url) => {
        expect(url).toBe(`${baseUrl}/jobs/job-1`);
        return jsonResponse(200, {
          state: 'succeeded',
          outputAssetId: 'asset-out',
          download: { url: '/_local/get-out', expiresAt: '2099-01-01T00:10:00.000Z' },
        });
      },
      // 6: GET <presigned download url>
      (url) => {
        expect(url).toBe(`${baseUrl}/_local/get-out`);
        return new Response(outputBytes, { status: 200, headers: { 'content-type': 'image/png' } });
      },
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const result = await client.run('remove-background', inputBytes, { pollIntervalMs: 1 });

    expect(downloadedBytes(result)).toEqual(Array.from(outputBytes));
    expect(result.mime).toBe('image/png');
    expect(calls).toHaveLength(7);

    // Every call to the api itself (uploads/confirm/jobs/poll) authenticates.
    const apiCallIndices = [0, 2, 3, 4, 5];
    for (const i of apiCallIndices) {
      expect(authHeaderOf(calls[i]?.init)).toBe(`Bearer ${apiKey}`);
    }
    // The presigned PUT and download GET are self-authenticating (signed
    // urls) and deliberately do NOT carry our api bearer token — some
    // presigned-url schemes (e.g. S3 SigV4 query auth) reject a request
    // that also sends an Authorization header as a conflicting second
    // auth mechanism.
    expect(authHeaderOf(calls[1]?.init)).toBeNull();
    expect(authHeaderOf(calls[6]?.init)).toBeNull();
  });

  test('a Blob mask carries its OWN declared mime, even when opts.mime (which describes the main input) differs', async () => {
    const maskBlob = new Blob([maskBytes], { type: 'image/webp' });
    const { fetch, calls } = scriptedFetch([
      // 0-2: input upload — opts.mime ('image/png') applies here.
      (url, init) => {
        expect(jsonBodyOf(init)).toEqual({ mime: 'image/png', bytes: inputBytes.byteLength });
        return jsonResponse(200, { assetId: 'asset-in', upload: { url: '/_local/put-in', expiresAt: 'x' } });
      },
      () => noBody(204),
      () => jsonResponse(200, { assetId: 'asset-in', contentHash: 'h1', bytes: inputBytes.byteLength }),
      // 3-5: mask upload — the mask Blob's OWN type ('image/webp') must win
      // over opts.mime ('image/png'), which is only for the main input.
      (url, init) => {
        expect(jsonBodyOf(init)).toEqual({ mime: 'image/webp', bytes: maskBlob.size });
        return jsonResponse(200, { assetId: 'asset-mask', upload: { url: '/_local/put-mask', expiresAt: 'x' } });
      },
      (url, init) => {
        expect(init?.method).toBe('PUT');
        expect(new Headers(init?.headers).get('content-type')).toBe('image/webp');
        return noBody(204);
      },
      () => jsonResponse(200, { assetId: 'asset-mask', contentHash: 'h2', bytes: maskBlob.size }),
      // 6: POST /jobs — cache hit, already succeeded.
      () =>
        jsonResponse(200, {
          jobId: 'job-mime',
          status: {
            state: 'succeeded',
            outputAssetId: 'asset-out',
            download: { url: '/_local/get-out', expiresAt: 'x' },
          },
        }),
      // 7: download
      () => new Response(outputBytes, { status: 200, headers: { 'content-type': 'image/png' } }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    await client.run('generative-fill', inputBytes, {
      mask: maskBlob,
      mime: 'image/png',
      params: { prompt: 'x' },
    });

    // Two independent upload-create calls, one per mime asserted above.
    expect(calls[0]?.url).toBe(`${baseUrl}/uploads`);
    expect(calls[3]?.url).toBe(`${baseUrl}/uploads`);
  });

  test('generative-fill: uploads TWO assets (input + mask), sends maskAssetId + params, and skips polling on an immediate (cache-hit) succeeded status', async () => {
    const { fetch, calls } = scriptedFetch([
      // 0-2: input upload
      () => jsonResponse(200, { assetId: 'asset-in', upload: { url: '/_local/put-in', expiresAt: 'x' } }),
      () => noBody(204),
      () => jsonResponse(200, { assetId: 'asset-in', contentHash: 'h1', bytes: inputBytes.byteLength }),
      // 3-5: mask upload
      () => jsonResponse(200, { assetId: 'asset-mask', upload: { url: '/_local/put-mask', expiresAt: 'x' } }),
      () => noBody(204),
      () => jsonResponse(200, { assetId: 'asset-mask', contentHash: 'h2', bytes: maskBytes.byteLength }),
      // 6: POST /jobs — cache hit, already succeeded, 200 (not 202)
      (url, init) => {
        expect(url).toBe(`${baseUrl}/jobs`);
        expect(jsonBodyOf(init)).toEqual({
          operation: 'generative-fill',
          inputAssetId: 'asset-in',
          params: { prompt: 'x', maskAssetId: 'asset-mask' },
        });
        return jsonResponse(200, {
          jobId: 'job-2',
          status: {
            state: 'succeeded',
            outputAssetId: 'asset-out-2',
            download: { url: '/_local/get-out-2', expiresAt: 'x' },
          },
        });
      },
      // 7: download
      () => new Response(outputBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const result = await client.run('generative-fill', inputBytes, { mask: maskBytes, params: { prompt: 'x' } });

    expect(downloadedBytes(result)).toEqual(Array.from(outputBytes));
    expect(calls).toHaveLength(8);
    // Two independent uploads (two distinct POST /uploads calls, indices 0 and 3).
    expect(calls[0]?.url).toBe(`${baseUrl}/uploads`);
    expect(calls[3]?.url).toBe(`${baseUrl}/uploads`);
    // No poll call was made at all — the job was already terminal.
    expect(calls.some((c) => c.url === `${baseUrl}/jobs/job-2`)).toBe(false);
  });
});

describe('createClient().run — typed error handling', () => {
  test('a failed job throws SnapneditApiError carrying the job status errorCode + message', async () => {
    const { fetch } = scriptedFetch([
      () => jsonResponse(200, { assetId: 'asset-in', upload: { url: '/_local/put-in', expiresAt: 'x' } }),
      () => noBody(204),
      () => jsonResponse(200, { assetId: 'asset-in', contentHash: 'h1', bytes: inputBytes.byteLength }),
      () => jsonResponse(202, { jobId: 'job-3', status: { state: 'queued' } }),
      () => jsonResponse(200, { state: 'failed', errorCode: 'provider_failed', message: 'vendor exploded' }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });

    let caught: unknown;
    try {
      await client.run('remove-background', inputBytes, { pollIntervalMs: 1 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SnapneditApiError);
    const err = caught as SnapneditApiError;
    expect(err.code).toBe('provider_failed');
    expect(err.message).toBe('vendor exploded');
  });

  test('a 402 response throws SnapneditApiError with code "payment_required" and status 402', async () => {
    const { fetch } = scriptedFetch([
      () => jsonResponse(200, { assetId: 'asset-in', upload: { url: '/_local/put-in', expiresAt: 'x' } }),
      () => noBody(204),
      () => jsonResponse(200, { assetId: 'asset-in', contentHash: 'h1', bytes: inputBytes.byteLength }),
      () =>
        jsonResponse(402, {
          error: { code: 'payment_required', message: 'insufficient credits: operation costs 1' },
        }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });

    let caught: unknown;
    try {
      await client.run('remove-background', inputBytes);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SnapneditApiError);
    const err = caught as SnapneditApiError;
    expect(err.code).toBe('payment_required');
    expect(err.status).toBe(402);
    expect(err.message).toBe('insufficient credits: operation costs 1');
  });

  test('a poll that never reaches a terminal state throws SnapneditTimeoutError once timeoutMs elapses', async () => {
    const { fetch } = scriptedFetch([
      () => jsonResponse(200, { assetId: 'asset-in', upload: { url: '/_local/put-in', expiresAt: 'x' } }),
      () => noBody(204),
      () => jsonResponse(200, { assetId: 'asset-in', contentHash: 'h1', bytes: inputBytes.byteLength }),
      () => jsonResponse(202, { jobId: 'job-4', status: { state: 'queued' } }),
      // Repeats forever (scriptedFetch replays the last step): job never finishes.
      () => jsonResponse(200, { state: 'queued' }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });

    await expect(
      client.run('remove-background', inputBytes, { pollIntervalMs: 5, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(SnapneditTimeoutError);
  });
});

describe('lower-level client methods', () => {
  test('upload() drives the 3-call flow and returns { assetId }', async () => {
    const { fetch, calls } = scriptedFetch([
      () => jsonResponse(200, { assetId: 'asset-x', upload: { url: '/_local/put-x', expiresAt: 'x' } }),
      () => noBody(204),
      () => jsonResponse(200, { assetId: 'asset-x', contentHash: 'h', bytes: inputBytes.byteLength }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const result = await client.upload(inputBytes, 'image/png');

    expect(result).toEqual({ assetId: 'asset-x' });
    expect(calls).toHaveLength(3);
    expect(new Headers(calls[1]?.init?.headers).get('content-type')).toBe('image/png');
  });

  test('createJob() posts operation+inputAssetId+params and returns { jobId, status }', async () => {
    const { fetch } = scriptedFetch([
      (url, init) => {
        expect(url).toBe(`${baseUrl}/jobs`);
        expect(jsonBodyOf(init)).toEqual({ operation: 'upscale', inputAssetId: 'asset-y', params: { factor: 2 } });
        return jsonResponse(202, { jobId: 'job-y', status: { state: 'queued' } });
      },
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const result = await client.createJob('upscale', 'asset-y', { factor: 2 });

    expect(result).toEqual({
      jobId: 'job-y',
      status: { state: 'queued' },
      // The bring-your-own-storage envelope is filled in even when the api
      // (or, here, the scripted response) omits it entirely: an asset input,
      // no destination, no delivery is the only thing its absence can mean.
      input: { kind: 'asset' },
      destination: null,
      delivery: null,
    });
  });

  test('getJob() never throws for a non-succeeded terminal status — just returns it (the throw-on-failure translation is run()-only)', async () => {
    const { fetch } = scriptedFetch([
      () => jsonResponse(200, { state: 'failed', errorCode: 'invalid_input', message: 'bad input' }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const status = await client.getJob('job-z');

    expect(status).toEqual({
      state: 'failed',
      errorCode: 'invalid_input',
      message: 'bad input',
      input: { kind: 'asset' },
      destination: null,
      delivery: null,
    });
  });
});

/**
 * BRING YOUR OWN STORAGE — an `inputUrl` the server fetches, a `destination`
 * presigned PUT it delivers the result to, and the `input`/`destination`/
 * `delivery` envelope every job response now carries.
 */
describe('bring your own storage', () => {
  const destination: JobDestination = {
    type: 'presigned-put',
    url: 'https://bucket.example.com/out.png?X-Amz-Signature=sig',
    headers: { 'content-type': 'image/png' },
  };

  test('createJob with a { url } input sends inputUrl (never inputAssetId)', async () => {
    const { fetch, calls } = scriptedFetch([
      () => jsonResponse(202, { jobId: 'job-u', status: { state: 'queued' }, input: { kind: 'url' }, destination: null, delivery: null }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const result = await client.createJob('remove-background', { url: 'https://bucket.example.com/in.png' });

    expect(jsonBodyOf(calls[0]?.init)).toEqual({
      operation: 'remove-background',
      inputUrl: 'https://bucket.example.com/in.png',
      params: {},
    });
    expect(result.input).toEqual({ kind: 'url' });
  });

  test('createJob forwards opts.destination verbatim as the wire shape, and reports the echo-safe envelope back', async () => {
    const { fetch, calls } = scriptedFetch([
      () =>
        jsonResponse(202, {
          jobId: 'job-d',
          status: { state: 'queued' },
          input: { kind: 'asset' },
          destination: { type: 'presigned-put' },
          delivery: null,
        }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const result = await client.createJob('upscale', 'asset-y', { factor: '2' }, { destination });

    expect(jsonBodyOf(calls[0]?.init)).toEqual({
      operation: 'upscale',
      inputAssetId: 'asset-y',
      params: { factor: '2' },
      destination,
    });
    // The api reports THAT there is a destination, never the url/headers.
    expect(result.destination).toEqual({ type: 'presigned-put' });
    expect(result.delivery).toBeNull();
  });

  test('an anonymous caller supplying inputUrl/destination gets a 403 -> SnapneditApiError { code: "forbidden", status: 403 }', async () => {
    const { fetch } = scriptedFetch([
      () =>
        jsonResponse(403, {
          error: { code: 'forbidden', message: 'inputUrl and destination require an API key or embed token' },
        }),
    ]);

    const client = createClient({ baseUrl, apiKey: '', fetch });

    let caught: unknown;
    try {
      await client.createJob('remove-background', { url: 'https://bucket.example.com/in.png' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SnapneditApiError);
    const err = caught as SnapneditApiError;
    expect(err.code).toBe('forbidden');
    expect(err.status).toBe(403);
  });

  test('getJob surfaces the delivery record on a succeeded job', async () => {
    const { fetch } = scriptedFetch([
      () =>
        jsonResponse(200, {
          state: 'succeeded',
          outputAssetId: 'asset-out',
          download: { url: '/_local/get-out', expiresAt: 'x' },
          input: { kind: 'url' },
          destination: { type: 'presigned-put' },
          delivery: { status: 'delivered', attempts: 1, statusCode: 200, deliveredAt: '2099-01-01T00:00:00.000Z' },
        }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const view = await client.getJob('job-d');

    expect(view.state).toBe('succeeded');
    expect(view.input).toEqual({ kind: 'url' });
    expect(view.destination).toEqual({ type: 'presigned-put' });
    expect(view.delivery).toEqual({
      status: 'delivered',
      attempts: 1,
      statusCode: 200,
      deliveredAt: '2099-01-01T00:00:00.000Z',
    });
  });

  test('run with a url input + destination: no upload, no download — just POST /jobs and one poll', async () => {
    const { fetch, calls } = scriptedFetch([
      // 0: POST /jobs — the ONLY write. No /uploads round-trip at all.
      (url, init) => {
        expect(url).toBe(`${baseUrl}/jobs`);
        expect(jsonBodyOf(init)).toEqual({
          operation: 'remove-background',
          inputUrl: 'https://bucket.example.com/in.png',
          params: {},
          destination,
        });
        return jsonResponse(202, { jobId: 'job-b', status: { state: 'queued' }, input: { kind: 'url' }, destination: { type: 'presigned-put' }, delivery: null });
      },
      // 1: GET /jobs/job-b -> succeeded AND delivered
      () =>
        jsonResponse(200, {
          state: 'succeeded',
          outputAssetId: 'asset-out',
          download: { url: '/_local/get-out', expiresAt: 'x' },
          input: { kind: 'url' },
          destination: { type: 'presigned-put' },
          delivery: { status: 'delivered', attempts: 1, statusCode: 200 },
        }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const result = await client.run('remove-background', { url: 'https://bucket.example.com/in.png' }, {
      destination,
      pollIntervalMs: 1,
    });

    // Two calls total: create + one poll. Nothing uploaded, nothing downloaded.
    expect(calls.map((c) => c.url)).toEqual([`${baseUrl}/jobs`, `${baseUrl}/jobs/job-b`]);
    expect(result.downloaded).toBe(false);
    expect(result.output).toBeUndefined();
    expect(result.jobId).toBe('job-b');
    expect(result.delivery).toEqual({ status: 'delivered', attempts: 1, statusCode: 200 });
    // ...but the caller can still fetch the result themselves if they want to.
    expect(result.download).toEqual({ url: '/_local/get-out', expiresAt: 'x' });
  });

  test('run downloads anyway when the delivery FAILED — the job still succeeded, so the caller is never left empty-handed', async () => {
    const { fetch, calls } = scriptedFetch([
      () =>
        jsonResponse(200, {
          jobId: 'job-f',
          status: {
            state: 'succeeded',
            outputAssetId: 'asset-out',
            download: { url: '/_local/get-out', expiresAt: 'x' },
          },
          input: { kind: 'url' },
          destination: { type: 'presigned-put' },
          delivery: { status: 'failed', attempts: 3, statusCode: 403, error: 'destination returned 403' },
        }),
      () => new Response(outputBytes, { status: 200, headers: { 'content-type': 'image/png' } }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const result = await client.run('remove-background', { url: 'https://bucket.example.com/in.png' }, { destination });

    expect(calls).toHaveLength(2);
    expect(downloadedBytes(result)).toEqual(Array.from(outputBytes));
    expect(result.delivery).toMatchObject({ status: 'failed', attempts: 3, statusCode: 403 });
  });

  test('opts.download overrides the default in both directions', async () => {
    const succeededAndDelivered = {
      jobId: 'job-o',
      status: { state: 'succeeded', outputAssetId: 'asset-out', download: { url: '/_local/get-out', expiresAt: 'x' } },
      input: { kind: 'asset' },
      destination: { type: 'presigned-put' },
      delivery: { status: 'delivered', attempts: 1 },
    };

    // download: true — delivered to the bucket AND pulled back here.
    const forced = scriptedFetch([
      () => jsonResponse(200, { assetId: 'asset-in', upload: { url: '/_local/put-in', expiresAt: 'x' } }),
      () => noBody(204),
      () => jsonResponse(200, { assetId: 'asset-in', contentHash: 'h', bytes: inputBytes.byteLength }),
      () => jsonResponse(200, succeededAndDelivered),
      () => new Response(outputBytes, { status: 200, headers: { 'content-type': 'image/png' } }),
    ]);
    const withDownload = await createClient({ baseUrl, apiKey, fetch: forced.fetch }).run(
      'remove-background',
      inputBytes,
      { destination, download: true },
    );
    expect(downloadedBytes(withDownload)).toEqual(Array.from(outputBytes));

    // download: false with NO destination — poll to completion, fetch nothing.
    const skipped = scriptedFetch([
      () => jsonResponse(200, { assetId: 'asset-in', upload: { url: '/_local/put-in', expiresAt: 'x' } }),
      () => noBody(204),
      () => jsonResponse(200, { assetId: 'asset-in', contentHash: 'h', bytes: inputBytes.byteLength }),
      () =>
        jsonResponse(200, {
          jobId: 'job-s',
          status: { state: 'succeeded', outputAssetId: 'asset-out', download: { url: '/_local/get-out', expiresAt: 'x' } },
        }),
    ]);
    const withoutDownload = await createClient({ baseUrl, apiKey, fetch: skipped.fetch }).run(
      'remove-background',
      inputBytes,
      { download: false },
    );
    expect(withoutDownload.downloaded).toBe(false);
    expect(skipped.calls).toHaveLength(4);
  });

  test('a job that failed to fetch its inputUrl throws SnapneditApiError { code: "input_fetch_failed" }', async () => {
    const { fetch } = scriptedFetch([
      () => jsonResponse(202, { jobId: 'job-x', status: { state: 'queued' }, input: { kind: 'url' }, destination: null, delivery: null }),
      () => jsonResponse(200, { state: 'failed', errorCode: 'input_fetch_failed', message: 'job failed: input_fetch_failed' }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });

    let caught: unknown;
    try {
      await client.run('remove-background', { url: 'https://bucket.example.com/gone.png' }, { pollIntervalMs: 1 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SnapneditApiError);
    expect((caught as SnapneditApiError).code).toBe('input_fetch_failed');
  });
});
