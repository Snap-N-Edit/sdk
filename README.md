# @snapnedit/sdk

The official TypeScript client for the [snapnedit](https://snapnedit.com) API — a
self-hosted AI photo-editing platform. It wraps the raw HTTP flow (presigned upload →
create job → poll → download) into one `run()` call, and also exposes the individual
steps when you want them.

- **Zero runtime dependencies.** Nothing but `fetch`. `@snapnedit/shared` is imported
  with `import type` only, so no `node:crypto`/`zod` graph ends up in your bundle.
- **Isomorphic.** Node 18+ and modern browsers, same code path. Webhook signature
  verification uses Web Crypto, not `node:crypto`.
- **Typed end to end.** Operation ids, job states and error codes are real types; API
  responses are validated field-by-field rather than cast.

```sh
npm install @snapnedit/sdk
```

> Publishing to npm is imminent — the package is not on the registry yet. Until it is,
> build it from the monorepo (`npm ci && npm run build`, then reference
> `packages/sdk/dist`).

## Quick start

```ts
import { createClient, SnapneditApiError, SnapneditTimeoutError } from '@snapnedit/sdk';

const client = createClient({
  baseUrl: 'https://api.snapnedit.com', // or http://localhost:8787 in local dev
  apiKey: process.env.SNAPNEDIT_API_KEY!, // sk_live_...
});

const input = new Uint8Array(await file.arrayBuffer());

// Upload → POST /jobs → poll GET /jobs/:id → download, in one call.
const result = await client.run('remove-background', input, { mime: 'image/png' });

if (result.downloaded) {
  await writeFile('out.png', result.output); // a Uint8Array; `result.mime` is its type
}
```

(`downloaded` is `true` for every ordinary run — it is `false` only when you asked
the server to deliver the bytes elsewhere; see
[Bring your own storage](#bring-your-own-storage).)

`run()` accepts a `Uint8Array` or a `Blob`/`File`. Options:

| Option | Meaning |
| --- | --- |
| `params` | Extra operation params, e.g. `{ factor: '4' }` for `upscale`. |
| `mask` | A second image for mask-guided operations; uploaded for you and passed as `params.maskAssetId`. |
| `mime` | MIME type of the input (inferred from `Blob.type` when omitted). |
| `pollIntervalMs` | Delay between status polls. Default `1000`. |
| `timeoutMs` | Total polling budget before `SnapneditTimeoutError`. Default `120000`. |
| `destination` | A presigned PUT the server delivers the result to — see [Bring your own storage](#bring-your-own-storage). |
| `download` | Whether `run()` fetches the result bytes itself. Defaults to `true`, except when `destination` delivered them (see below). |

`run()` resolves to a result discriminated by `downloaded`: the usual
`{ downloaded: true, output, mime, jobId, download, input, destination, delivery }`,
or `{ downloaded: false, ... }` when the download was skipped. Under `strict`
TypeScript, narrow with `if (result.downloaded)` before touching `output`.

A mask-guided run:

```ts
const result = await client.run('magic-eraser', photoBytes, {
  mime: 'image/png',
  mask: maskBytes, // white = erase
});
```

### Step by step

`run()` is a composition of three public methods — use them directly when you want to
show upload progress separately from job progress, or to hand the job id to another
process:

```ts
const { assetId } = await client.upload(input, 'image/png');
const { jobId, status } = await client.createJob('upscale', assetId, { factor: '2' });

// `status` can already be `succeeded` — the API returns a cached result for an
// identical (operation, image, params) triple without re-running the model.
let current = status;
while (current.state === 'queued' || current.state === 'processing') {
  await new Promise((r) => setTimeout(r, 1000));
  current = await client.getJob(jobId);
}

if (current.state === 'succeeded') {
  const bytes = new Uint8Array(await (await fetch(current.download.url)).arrayBuffer());
}
```

`getJob()` returns the job state rather than throwing on `failed`/`canceled`:
`{ state: 'queued' }`, `{ state: 'processing', startedAt }`,
`{ state: 'succeeded', outputAssetId, download }`,
`{ state: 'failed', errorCode, message }`, or `{ state: 'canceled' }` — each
alongside the `input` / `destination` / `delivery` fields described below.

## Bring your own storage

Two optional pieces let the bytes skip your process entirely: the server can
**fetch the input** from a URL you name, and **PUT the result** into a bucket you
name. Either can be used on its own; together, nothing but JSON crosses the wire
between you and the API.

```ts
const result = await client.run('remove-background', { url: presignedGetUrl }, {
  destination: {
    type: 'presigned-put',
    url: presignedPutUrl,                        // your bucket, your signature
    headers: { 'content-type': 'image/png' },    // whatever the signature covers
  },
});

result.downloaded;  // false — the bytes went straight to your bucket
result.delivery;    // { status: 'delivered', attempts: 1, statusCode: 200, deliveredAt }
result.download;    // still a presigned URL on our side, if you want a copy
```

- **Input**: pass `{ url }` in place of the bytes to `run()`, or to `createJob()`
  (which sends `inputUrl` instead of `inputAssetId`). There is no upload at all.
  Masks stay inline — there is no URL form for `opts.mask`.
- **Output**: `opts.destination` is the wire type verbatim,
  `{ type: 'presigned-put', url, headers? }`. Allowed headers are `content-type`,
  `cache-control`, `content-disposition` and `x-amz-*` / `x-goog-*` / `x-ms-*`
  (16 max); anything else is a `400` rather than a silent drop.
- **No CORS, ever.** Both transfers are server-to-bucket. No browser is involved,
  so no bucket CORS configuration is needed — and neither URL is ever echoed back
  by the API, logged, or included in a webhook, because a presigned URL is a
  bearer credential for your bucket. Mint them short-lived.
- **Downloading.** With a destination, `run()` skips the download by default —
  re-fetching bytes that are already in your bucket would defeat the point. Pass
  `download: true` to get both, or `download: false` on an ordinary run to just
  wait for completion. `result.download` is always there either way.

Both features require an API key (or an embed token): an anonymous caller gets
`403 forbidden`.

### Failure semantics

| What failed | Job | What you get |
| --- | --- | --- |
| The input URL (blocked host, redirect, timeout, non-2xx, too large, not an image) | `failed`, credits refunded | `SnapneditApiError` with `code: 'input_fetch_failed'` |
| The delivery PUT (after 3 attempts) | **still `succeeded`** | `delivery.status === 'failed'` with `statusCode`/`error`; `run()` downloads the bytes for you instead |

The input fetch is deliberately strict: https only, no redirects, no private /
loopback / link-local / metadata addresses, a 30-second timeout, and the same
size ceiling as a direct upload.

Job and webhook payloads both carry the same three fields — `input: { kind }`,
`destination: { type } | null` and `delivery | null` — so a webhook receiver sees
the delivery outcome without polling.

## Saved destinations

A presigned URL per job is one way. The other is to save the bucket **once** — on
your snapnedit account — and name it by id. The server then signs every upload
itself, which is what makes an account **default** possible: configure it once and
every job's result lands in your bucket with nothing extra in the request.

```ts
const destinations = await client.listDestinations();
const production = destinations.find((d) => d.isDefault) ?? destinations[0];

const result = await client.run('remove-background', bytes, {
  destination: { type: 'saved', id: production.id },
});

result.delivery;
// { status: 'delivered', attempts: 1, statusCode: 200,
//   bucket: 'my-app-images', key: 'snapnedit/2026/09/13/<job-id>.png' }
```

- **The default applies automatically.** With a default destination saved, plain
  `run(op, bytes)` is delivered to it — no `destination` field at all.
- **`destination: null` opts out** of that default for one job. `null` and omitted
  are different: omitted means "use my default if I have one".
- **A foreign id is a `404`**, not a `403` — a destination id must not be an
  existence oracle.

### Managing them

```ts
await client.listDestinations();                                 // GET    /destinations
await client.createDestination({                                 // POST   /destinations
  name: 'Production',
  provider: 'aws-s3',            // | 'cloudflare-r2' | 'backblaze-b2' | 's3-compatible'
  bucket: 'my-app-images',
  region: 'us-east-1',           // R2 derives its endpoint from `accountId` instead
  keyPrefix: 'snapnedit/',       // results land at <prefix>YYYY/MM/DD/<job-id>.<ext>
  accessKeyId: 'AKIA...',
  secretAccessKey: '...',
  isDefault: true,
});
await client.updateDestination(id, { name: 'Renamed' });         // PATCH  /destinations/:id
await client.deleteDestination(id);                              // DELETE /destinations/:id
await client.testDestination(id);                                // POST   /destinations/:id/test
await client.presignDestinationUpload(id, { ext: 'png', contentType: 'image/png' });
```

The secret access key is encrypted at rest and never returned by any endpoint —
a destination view carries `accessKeyIdLast4` and nothing else of the credential.
`testDestination()` is a REAL write probe (a tiny object written under your prefix
and deleted again) and resolves either way rather than throwing:
`{ ok: true, latencyMs }` or `{ ok: false, latencyMs, error }`. Max 10 destinations
per account.

`presignDestinationUpload()` mints a 15-minute signed PUT for one object in your
own bucket — for uploading something you produced yourself, without putting your S3
credentials in a browser.

### Delete after delivery

A destination can be set to drop the snapnedit copy the moment your bucket confirms
the write. Its jobs stay `succeeded` and keep their `outputAssetId`, but there is no
URL left to sign:

```ts
const result = await client.run('remove-background', bytes, { destination: { type: 'saved', id } });

result.downloaded;                 // false
result.download;                   // null — the only copy is in your bucket
result.delivery?.localCopyDeleted; // true
result.delivery?.key;              // ...where it is
```

`run()` returns `{ downloaded: false }` here rather than throwing, even with
`download: true` — there are genuinely no bytes to fetch. `JobView`'s succeeded
branch is typed accordingly (`download: SignedUrl | null`), so narrow before
dereferencing.

### Cache hits are delivered too

Identical jobs are served from the result cache without re-running the model. With a
destination, that cached result is **still** delivered: the server creates a new,
already-`succeeded` job for it whose `delivery` starts `pending`, and `run()` polls
until that delivery settles before resolving. It costs no credits, since nothing ran.

Full setup and per-provider bucket permissions:
<https://snapnedit.com/docs/storage-destinations>.

## Usage

`getUsage()` is the metering read: what the account ran, what it cost, and
where it came from.

```ts
const usage = await client.getUsage();                       // last 30 days, by day
console.log(usage.totals.credits, usage.totals.cacheHits);

// Embed credits per customer site, for one month.
const byOrigin = await client.getUsage({
  from: '2026-08-01',
  to: '2026-08-31',
  source: 'embed',
  groupBy: 'origin',
});
for (const row of byOrigin.series) console.log(row.label, row.credits, row.jobs);

// About to hit a cap? `keys` is today's spend, not the range's.
for (const key of usage.keys) {
  if (key.dailyCreditLimit !== null && key.usedToday / key.dailyCreditLimit > 0.8) {
    warn(`${key.name} is at ${key.usedToday}/${key.dailyCreditLimit} today`);
  }
}
```

- `groupBy`: `'day'` (default) | `'key'` | `'origin'` | `'operation'` | `'source'`.
- `keyId`, `origin`, `operation`, `source` narrow **what** is counted before it is bucketed.
- `from`/`to` are inclusive `YYYY-MM-DD`; the range may not exceed **366 days** (`invalid_input`).
- `totals` covers the same filters; `series` is one row per bucket; `keys` is the account's
  key roster with **today's** spend against each daily cap (`dailyCreditLimit: null` = uncapped).

Every counter (`jobs`, `credits`, `cacheHits`, `free`, `failed`, `delivered`,
`deliveryFailed`, `sessions`) appears on both `totals` and each series row.
Full reference: <https://snapnedit.com/docs/usage>.

## Operations

The first argument to `run()`/`createJob()` is an `OperationId`. The full set
(`resize-image` is free — it is plain geometry, with no model behind it):

| Operation | Credits | Mask | Params |
| --- | --- | --- | --- |
| `remove-background` | 1 | — | — |
| `upscale` | 2 | — | `factor`: `'2'` \| `'4'` |
| `unblur` | 1 | — | — |
| `colorize` | 1 | — | — |
| `style-transfer` | 2 | — | `style`: `vivid` \| `pastel` \| `mosaic` \| `storm` |
| `retouch` | 1 | — | — |
| `beautify` | 1 | — | `amount`: `0.3` \| `0.6` \| `0.9` \| `1` |
| `magic-eraser` | 2 | required | — |
| `generative-fill` | 3 | required | `prompt` (required), `mode`: `fast` \| `quality` |
| `remove-watermark` | 2 | required | — |
| `ai-denoise` | 1 | — | `strength`: `0.25` \| `0.5` \| `0.75` \| `1` |
| `replace-sky` | 2 | — | `sky`: `blue-sky` \| `sunset` \| `dramatic-clouds` \| `golden-hour` \| `night` \| `overcast` |
| `relight` | 2 | — | `direction`: `left` \| `right` \| `front` \| `top` \| `backlit` |
| `replace-background` | 2 | — | `background`: `white` \| `black` \| `studio-grey` \| `studio-blue` \| `sunset` \| `ocean` \| `lavender` |
| `strip-metadata` | 1 | — | — |
| `auto-remove-watermark` | 2 | — | `strength`: `low` \| `medium` \| `high` |
| `resize-image` | 0 | — | `width`, `height` (integers 1..8192; at least one required), `fit`: `inside` \| `cover` \| `fill` (default `inside`; `cover`/`fill` need both dimensions), `format`: `png` \| `jpeg` \| `webp` (default `png`), `quality`: 1..100 (default `90`, jpeg/webp only) |

Credits are the cost of a real (non-cached) run. `GET /operations` on your deployment
returns the live catalog with each operation's JSON Schema for `params` — a
deployment may have some operations disabled, so treat that endpoint as the
authority for what is actually available.

## Designs

Beyond running an operation on an existing image, the client can compose a design —
a canvas plus text/image/shape/frame layers — and render it server-side:

```ts
const { document } = await client.createDesign({
  width: 1080,
  height: 1080,
  background: '#101014',
  layers: [{ type: 'text', x: 540, y: 540, text: 'Hello', fontSize: 96, color: '#ffffff' }],
});

const png = await client.renderDesign({ document });          // Uint8Array (PNG)
const pdf = await client.renderDesign({ pages: [specA, specB], format: 'pdf' });
```

`createDesignPages()` compiles a multi-page spec; `renderDesign()` takes a `spec`, a
compiled `document`, or `pages`/`documents` (which render to a PDF). The `Design*`
types exported from the package mirror the API's design schema — the API validates
and is the source of truth.

## Error handling

Two error classes, both exported:

```ts
try {
  await client.run('upscale', input, { params: { factor: '4' } });
} catch (err) {
  if (err instanceof SnapneditApiError) {
    // err.code   — typed ErrorCode: 'invalid_input' | 'unsupported_mime' | 'too_large' |
    //              'not_found' | 'input_fetch_failed' | 'provider_failed' |
    //              'provider_exhausted' | 'rate_limited' | 'bot_check_failed' |
    //              'unauthorized' | 'forbidden' | 'payment_required' | 'internal'
    // err.status — the HTTP status that produced it (0 for a network failure)
    if (err.code === 'payment_required') await topUpCredits();
  } else if (err instanceof SnapneditTimeoutError) {
    // polling exceeded `timeoutMs` without the job reaching a terminal state
  }
}
```

`SnapneditApiError` covers both a non-2xx API response and a job that finished in
`state: 'failed'` (the job's `errorCode`/`message` become the error's `code`/`message`).
An unrecognized code from a newer API degrades to `'internal'` rather than throwing
during error parsing.

## Webhooks

Instead of polling, an account can register endpoints that receive a signed POST when a
job finishes. The SDK ships the delivery types and a verifier:

```ts
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from '@snapnedit/sdk';
import type { WebhookDeliveryBody } from '@snapnedit/sdk';

const raw = await request.text(); // the RAW body — verify before JSON.parse
const ok = await verifyWebhookSignature(
  raw,
  request.headers.get(WEBHOOK_SIGNATURE_HEADER.toLowerCase()) ?? '',
  endpointSecret,
  { toleranceSeconds: 300 },
);
if (!ok) return new Response('bad signature', { status: 400 });

const event = JSON.parse(raw) as WebhookDeliveryBody;
// event.type: 'job.succeeded' | 'job.failed'
// event.data: { jobId, operation, status: 'succeeded', outputAssetId, download? }
//           | { jobId, operation, status: 'failed', errorCode, message }
// ...each also carrying { input: { kind }, destination, delivery } — see
// "Bring your own storage" above.
```

`verifyWebhookSignature` recomputes the HMAC-SHA256 of `` `${t}.${rawBody}` `` and
compares it in constant time against every `v1` in the
`X-Snapnedit-Signature: t=...,v1=...` header. It returns `false` (never throws) for a
malformed header, a bad signature, or — with `toleranceSeconds` — a stale timestamp.
`WEBHOOK_EVENT_HEADER` and `WEBHOOK_DELIVERY_HEADER` are exported too.

## Docs

- Guides and API reference: <https://snapnedit.com/docs>
- Authentication and raw endpoints: <https://snapnedit.com/docs/api-authentication>
- Using the SDK: <https://snapnedit.com/docs/using-the-sdk>
- Webhooks: <https://snapnedit.com/docs/webhooks>

## Development

This package is developed inside the private snapnedit monorepo and mirrored to
[github.com/Snap-N-Edit/sdk](https://github.com/Snap-N-Edit/sdk) with its history. The
mirror is read-only for code (it references sibling workspace packages, so it does not
build on its own) — file issues and feature requests there, and pull requests are
welcome as proposals; the change lands through the monorepo and the mirror is refreshed
on every release.

Licensed under the [MIT License](./LICENSE).
