import type { GitHubRelayResponse } from "./types";

export type WebRequest = {
  url: string;
  headers: Record<string, string>;
  capBytes: number;
  usesApiQuota: boolean;
  timeoutMs?: number;
  payload: (
    body: Uint8Array,
    headers: Headers,
    status: number,
    responseURL: string,
    signal?: AbortSignal,
  ) => GitHubRelayResponse | undefined | Promise<GitHubRelayResponse | undefined>;
};
