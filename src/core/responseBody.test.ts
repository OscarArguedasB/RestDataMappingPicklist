import { describe, expect, it } from 'vitest';
import { readLimitedText } from './responseBody';

const CHUNK = new Uint8Array(64 * 1024).fill(0x61);

/** A body that never ends, like a service that keeps sending; counts the chunks read. */
function endless(): { response: Response; pulls: () => number; cancelled: () => boolean } {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(CHUNK);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body), pulls: () => pulls, cancelled: () => cancelled };
}

describe('readLimitedText', () => {
  it('reads a body up to the limit, as Response.text() would', async () => {
    expect(await readLimitedText(new Response('{"ok":true}'), 100)).toBe('{"ok":true}');
    // UTF-8, without a byte order mark, even when split between chunks.
    const bytes = new TextEncoder().encode('﻿José ✓');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 5));
        controller.enqueue(bytes.slice(5));
        controller.close();
      },
    });
    expect(await readLimitedText(new Response(body), 100)).toBe('José ✓');
    expect(await readLimitedText(new Response(null, { status: 204 }), 100)).toBe('');
  });

  it('stops reading as soon as a body goes over the limit', async () => {
    const stream = endless();
    expect(await readLimitedText(stream.response, 1_000_000)).toBeNull();
    // About 1 MB was read, not the endless rest.
    expect(stream.pulls()).toBeLessThanOrEqual(17);
    expect(stream.cancelled()).toBe(true);
  });

  it('doesn’t read a body that says it’s too large', async () => {
    const stream = endless();
    const response = new Response(stream.response.body, {
      headers: { 'Content-Length': '5000000' },
    });
    expect(await readLimitedText(response, 1_000_000)).toBeNull();
    expect(stream.pulls()).toBeLessThanOrEqual(1);
    expect(
      await readLimitedText(new Response('abc', { headers: { 'Content-Length': '3' } }), 3)
    ).toBe('abc');
  });
});
