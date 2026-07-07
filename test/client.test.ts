import { describe, expect, test } from 'vitest';
import { createClient, SnapneditApiError, SnapneditTimeoutError } from '../src/index.js';

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

    expect(Array.from(result.output)).toEqual(Array.from(outputBytes));
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

    expect(Array.from(result.output)).toEqual(Array.from(outputBytes));
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

    expect(result).toEqual({ jobId: 'job-y', status: { state: 'queued' } });
  });

  test('getJob() never throws for a non-succeeded terminal status — just returns it (the throw-on-failure translation is run()-only)', async () => {
    const { fetch } = scriptedFetch([
      () => jsonResponse(200, { state: 'failed', errorCode: 'invalid_input', message: 'bad input' }),
    ]);

    const client = createClient({ baseUrl, apiKey, fetch });
    const status = await client.getJob('job-z');

    expect(status).toEqual({ state: 'failed', errorCode: 'invalid_input', message: 'bad input' });
  });
});
