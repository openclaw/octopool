import { base64ToBytesSafe, bytesToBase64, bytesToBase64URL } from "./encoding";
import { encodedPathSegments } from "./github-path";

export type AdvertisedGitRefs = Map<string, string>;

export function parseGitUploadPackAdvertisement(body: Uint8Array): AdvertisedGitRefs | undefined {
  const refs = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let offset = 0;
  let phase: "service" | "header-flush" | "refs" = "service";
  let firstRef = true;
  while (offset < body.byteLength) {
    if (offset + 4 > body.byteLength) {
      return undefined;
    }
    const lengthText = decoder.decode(body.slice(offset, offset + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) {
      return undefined;
    }
    const length = Number.parseInt(lengthText, 16);
    offset += 4;
    if (length === 0) {
      if (phase === "header-flush") {
        phase = "refs";
        continue;
      }
      // Only the separate terminal flush at exact EOF commits the whole listing.
      return phase === "refs" && refs.size > 0 && offset === body.byteLength ? refs : undefined;
    }
    if (
      phase === "header-flush" ||
      length < 4 ||
      length > 65_520 ||
      offset + length - 4 > body.byteLength
    ) {
      return undefined;
    }
    const payload = decoder.decode(body.slice(offset, offset + length - 4));
    offset += length - 4;
    if (phase === "service") {
      if (payload !== "# service=git-upload-pack" && payload !== "# service=git-upload-pack\n") {
        return undefined;
      }
      phase = "header-flush";
      continue;
    }
    const record = payload.replace(/\n$/, "");
    const capabilities = record.indexOf("\0");
    if (capabilities !== -1 && !firstRef) {
      return undefined;
    }
    firstRef = false;
    const line = capabilities === -1 ? record : record.slice(0, capabilities);
    const match = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64}) (HEAD|refs\/[^\s]+)$/.exec(line);
    if (match === null) {
      return undefined;
    }
    if (match[2] === "HEAD") {
      continue;
    }
    if (refs.has(match[2]!)) {
      return undefined;
    }
    refs.set(match[2]!, match[1]!.toLowerCase());
  }
  return undefined;
}

export function gitRefResponse(
  refs: AdvertisedGitRefs,
  repositoryNodeID: string,
  owner: string,
  repo: string,
  requested: string,
  matching: boolean,
): Record<string, unknown> | Record<string, unknown>[] | undefined {
  const prefix = `refs/${requested}`;
  const namespace =
    requested === "heads" ||
    requested.startsWith("heads/") ||
    requested === "tags" ||
    requested.startsWith("tags/");
  if (!namespace || (!matching && (requested === "heads" || requested === "tags"))) {
    return undefined;
  }
  const selected = matching
    ? [...refs.entries()]
        .filter(([ref]) => !ref.endsWith("^{}") && ref.startsWith(prefix))
        .sort(([left], [right]) => compareStrings(left, right))
    : refs.has(prefix)
      ? ([[prefix, refs.get(prefix)!]] as [string, string][])
      : [];
  if (!matching && selected.length !== 1) {
    return undefined;
  }
  const response: Record<string, unknown>[] = [];
  for (const [ref, sha] of selected) {
    const type = ref.startsWith("refs/heads/")
      ? "commit"
      : refs.has(`${ref}^{}`)
        ? "tag"
        : undefined;
    if (type === undefined) {
      return undefined;
    }
    const nodeID = gitRefNodeID(repositoryNodeID, ref);
    if (nodeID === undefined) {
      return undefined;
    }
    response.push({
      ref,
      node_id: nodeID,
      url: `https://api.github.com/${encodedPathSegments([
        "repos",
        owner,
        repo,
        "git",
        "refs",
        ref.slice("refs/".length),
      ])}`,
      object: {
        sha,
        type,
        url: `https://api.github.com/${encodedPathSegments([
          "repos",
          owner,
          repo,
          "git",
          type === "tag" ? "tags" : "commits",
          sha,
        ])}`,
      },
    });
  }
  return matching ? response : response[0];
}

function gitRefNodeID(repositoryNodeID: string, ref: string): string | undefined {
  const oldBytes = base64ToBytesSafe(repositoryNodeID);
  const oldValue = oldBytes === undefined ? undefined : new TextDecoder().decode(oldBytes);
  const oldMatch = /^010:Repository([0-9]+)$/.exec(oldValue ?? "");
  if (oldMatch !== null) {
    return bytesToBase64(new TextEncoder().encode(`03:Ref${oldMatch[1]}:${ref}`));
  }
  if (!repositoryNodeID.startsWith("R_")) {
    return undefined;
  }
  const repositoryBytes = base64ToBytesSafe(repositoryNodeID.slice(2));
  if (repositoryBytes === undefined || repositoryBytes[0] !== 0x92) {
    return undefined;
  }
  const encodedRef = messagePackString(ref);
  if (encodedRef === undefined) {
    return undefined;
  }
  const bytes = new Uint8Array(repositoryBytes.byteLength + encodedRef.byteLength);
  bytes.set(repositoryBytes);
  bytes[0] = 0x93;
  bytes.set(encodedRef, repositoryBytes.byteLength);
  return `REF_${bytesToBase64URL(bytes)}`;
}

function messagePackString(value: string): Uint8Array | undefined {
  const bytes = new TextEncoder().encode(value);
  let prefix: number[];
  if (bytes.byteLength <= 31) {
    prefix = [0xa0 | bytes.byteLength];
  } else if (bytes.byteLength <= 0xffff) {
    prefix = [0xda, bytes.byteLength >> 8, bytes.byteLength & 0xff];
  } else {
    return undefined;
  }
  return new Uint8Array([...prefix, ...bytes]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
