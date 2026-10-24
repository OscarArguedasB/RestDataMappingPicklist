// Reading a response without trusting its size. A service that keeps sending would otherwise be
// read to the end (only the timeout stops it) before any size check could run.

/**
 * The response's text, or null when it's larger than `maxBytes`. A body that says it's larger
 * (Content-Length) isn't read at all, and one that turns out to be larger is cancelled as soon as
 * it goes over, so it never has to fit in memory.
 */
export async function readLimitedText(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  const declared = Number(response.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    // No body at all.
    const text = await response.text();
    return text.length > maxBytes ? null : text;
  }
  // Decoded like Response.text(): UTF-8, without a byte order mark.
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
