import { describe, expect, test } from 'vitest';
import { verifyWebhookSignature } from '../src/index.js';

/**
 * Known-answer vector: `secret`, `rawBody`, and `t` below were signed with
 * `HMAC-SHA256(`${t}.${rawBody}`, secret)` (hex) — the exact scheme the
 * snapnedit server uses (`packages/db/src/webhooks.ts`'s `signWebhookPayload`)
 * — so `EXPECTED_V1` is a fixed vector this SDK's Web-Crypto implementation
 * must reproduce, guarding against any drift between the two.
 */
const secret = 'whsec_snap_testsecret_0123456789abcdef';
const rawBody = JSON.stringify({
  id: 'whd_1',
  type: 'job.succeeded',
  created: 1721433600,
  data: { jobId: 'job_1', operation: 'remove-background', status: 'succeeded', outputAssetId: 'asset_9' },
});
const timestamp = 1721433600;
const EXPECTED_V1 = 'c8003456fab5bb8703a7d8396e2e5618992f906052eae277d09146e466175e92';

function header(t: number, v1: string): string {
  return `t=${t},v1=${v1}`;
}

describe('verifyWebhookSignature', () => {
  test('accepts a correctly-signed payload (known vector)', async () => {
    await expect(verifyWebhookSignature(rawBody, header(timestamp, EXPECTED_V1), secret)).resolves.toBe(true);
  });

  test('is case-insensitive on the hex signature', async () => {
    await expect(verifyWebhookSignature(rawBody, header(timestamp, EXPECTED_V1.toUpperCase()), secret)).resolves.toBe(true);
  });

  test('rejects a tampered body', async () => {
    await expect(verifyWebhookSignature(`${rawBody} `, header(timestamp, EXPECTED_V1), secret)).resolves.toBe(false);
  });

  test('rejects a wrong secret', async () => {
    await expect(verifyWebhookSignature(rawBody, header(timestamp, EXPECTED_V1), 'whsec_snap_wrong')).resolves.toBe(false);
  });

  test('rejects a wrong timestamp (signature is over `${t}.${body}`)', async () => {
    await expect(verifyWebhookSignature(rawBody, header(timestamp + 1, EXPECTED_V1), secret)).resolves.toBe(false);
  });

  test('accepts when at least one of several v1 candidates matches', async () => {
    await expect(
      verifyWebhookSignature(rawBody, `t=${timestamp},v1=${'0'.repeat(64)},v1=${EXPECTED_V1}`, secret),
    ).resolves.toBe(true);
  });

  test.each(['', 'not-a-header', 'v1=abc', 't=abc,v1=def', `t=${timestamp}`])(
    'returns false (never throws) for malformed header %j',
    async (bad) => {
      await expect(verifyWebhookSignature(rawBody, bad, secret)).resolves.toBe(false);
    },
  );

  test('enforces toleranceSeconds when provided', async () => {
    // 400s of skew, 300s tolerance -> stale even though the signature is valid.
    await expect(
      verifyWebhookSignature(rawBody, header(timestamp, EXPECTED_V1), secret, {
        toleranceSeconds: 300,
        nowSeconds: timestamp + 400,
      }),
    ).resolves.toBe(false);
  });

  test('accepts within toleranceSeconds', async () => {
    await expect(
      verifyWebhookSignature(rawBody, header(timestamp, EXPECTED_V1), secret, {
        toleranceSeconds: 300,
        nowSeconds: timestamp + 120,
      }),
    ).resolves.toBe(true);
  });

  test('ignores the timestamp when no tolerance is requested', async () => {
    await expect(verifyWebhookSignature(rawBody, header(timestamp, EXPECTED_V1), secret)).resolves.toBe(true);
  });
});
