import { describe, expect, test } from 'vitest';
import { ERROR_CODES } from '@snapnedit/shared';
import { asErrorCode, KNOWN_ERROR_CODES } from '../src/errors.js';

/**
 * `packages/sdk/src/errors.ts` DUPLICATES `@snapnedit/shared`'s `ERROR_CODES`
 * rather than importing it: a runtime import from that package would drag
 * `node:crypto` and `zod` into this zero-runtime-dependency, browser-safe
 * bundle (see `client.ts`'s module doc). A test is the right place for the
 * runtime import — it never ships — so this file is what keeps the hand-kept
 * copy honest.
 */
describe('KNOWN_ERROR_CODES mirrors @snapnedit/shared', () => {
  test('the SDK list is exactly ERROR_CODES, in the same order', () => {
    expect([...KNOWN_ERROR_CODES]).toEqual([...ERROR_CODES]);
  });

  test('input_fetch_failed (bring-your-own-storage input fetch) is a recognized code, not degraded to internal', () => {
    expect(asErrorCode('input_fetch_failed')).toBe('input_fetch_failed');
  });

  test('an unrecognized code from a newer api still degrades to internal instead of throwing', () => {
    expect(asErrorCode('teapot')).toBe('internal');
    expect(asErrorCode(undefined)).toBe('internal');
  });
});
