import type { GitHubRelayResponse } from "./types";

export type WebPayload = Omit<GitHubRelayResponse, "backend">;

export type WebRequest = {
  url: string;
  headers: Record<string, string>;
  capBytes: number;
  usesApiQuota: boolean;
  payload: (
    body: Uint8Array,
    headers: Headers,
    status: number,
    responseURL: string,
  ) => WebPayload | undefined | Promise<WebPayload | undefined>;
};
