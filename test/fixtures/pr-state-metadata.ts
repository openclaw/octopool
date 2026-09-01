export const PR_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const PR_METADATA_CAP = 256;

export function matchingPRMetadata(size = PR_METADATA_CAP): Uint8Array {
  const json = JSON.stringify({
    head: { sha: PR_HEAD },
    state: "closed",
    merged_at: "2026-05-29T00:00:00Z",
    title: "é",
  });
  const bytes = new TextEncoder().encode(json);
  return new TextEncoder().encode(json + " ".repeat(size - bytes.byteLength));
}

// Demand-driven, with a separate EOF pull so cancellation remains observable.
export function prMetadataStream(
  chunks: Uint8Array[],
  options: { contentLength?: string; cancelThrows?: boolean; failAtPull?: number } = {},
) {
  const observations = { pulls: 0, chunkBytes: [] as number[], cancellations: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        observations.pulls++;
        if (observations.pulls === options.failAtPull) {
          controller.error(new Error("metadata read failed"));
          return;
        }
        const chunk = chunks[observations.pulls - 1];
        if (chunk === undefined) controller.close();
        else {
          observations.chunkBytes.push(chunk.byteLength);
          controller.enqueue(chunk);
        }
      },
      cancel() {
        observations.cancellations++;
        if (options.cancelThrows) throw new Error("metadata cancel failed");
      },
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers({ "content-type": "application/json" });
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  return { response: new Response(stream, { headers }), stream, observations };
}

export const oversizedPRMetadata = [
  { name: "one byte over cap", sizes: [257], pulled: [257] },
  { name: "crossing chunk with unread tail", sizes: [128, 128, 1, 64], pulled: [128, 128, 1] },
  { name: "matching head before long tail", sizes: [256, 64, 64], pulled: [256, 64] },
  { name: "false Content-Length", sizes: [256, 1, 64], pulled: [256, 1], contentLength: "1" },
  { name: "throwing cancellation", sizes: [256, 1, 64], pulled: [256, 1], cancelThrows: true },
];

export function oversizedPRStream(fixture: (typeof oversizedPRMetadata)[number]) {
  const bytes = matchingPRMetadata(fixture.sizes.reduce((sum, size) => sum + size, 0));
  let offset = 0;
  return prMetadataStream(
    fixture.sizes.map((size) => {
      const chunk = bytes.slice(offset, offset + size);
      offset += size;
      return chunk;
    }),
    fixture,
  );
}
