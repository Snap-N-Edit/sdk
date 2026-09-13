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
const { output, mime } = await client.run('remove-background', input, {
  mime: 'image/png',
});

await writeFile('out.png', output); // `output` is a Uint8Array; `mime` the result's type
```

`run()` accepts a `Uint8Array` or a `Blob`/`File`. Options:

| Option | Meaning |
| --- | --- |
| `params` | Extra operation params, e.g. `{ factor: '4' }` for `upscale`. |
| `mask` | A second image for mask-guided operations; uploaded for you and passed as `params.maskAssetId`. |
| `mime` | MIME type of the input (inferred from `Blob.type` when omitted). |
| `pollIntervalMs` | Delay between status polls. Default `1000`. |
| `timeoutMs` | Total polling budget before `SnapneditTimeoutError`. Default `120000`. |

A mask-guided run:

```ts
const { output } = await client.run('magic-eraser', photoBytes, {
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
`{ state: 'failed', errorCode, message }`, or `{ state: 'canceled' }`.

## Operations

The first argument to `run()`/`createJob()` is an `OperationId`. The full set:

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
    //              'not_found' | 'provider_failed' | 'provider_exhausted' | 'rate_limited' |
    //              'bot_check_failed' | 'unauthorized' | 'forbidden' | 'payment_required' |
    //              'internal'
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
