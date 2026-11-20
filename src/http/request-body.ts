export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (bytes > maxBytes) return payloadTooLarge();
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) return payloadTooLarge();
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function payloadTooLarge(): Response {
  // Canceling the Node request stream closes its socket before the client can read the 413.
  return new Response("Payload Too Large", { status: 413, headers: { Connection: "close" } });
}
