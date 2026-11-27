import { HttpError } from "./http";

const credentialFailureMessages = {
  identity_secret_missing: "Identity credential is not configured",
  github_app_installation_missing: "GitHub App installation id is missing or invalid",
  github_app_id_missing: "GitHub App ID is not configured",
  github_app_key_format: "GitHub App private key must be valid PKCS#8",
} as const;

export type CredentialFailureReason = keyof typeof credentialFailureMessages;

export function isCredentialFailureReason(value: unknown): value is CredentialFailureReason {
  return typeof value === "string" && Object.hasOwn(credentialFailureMessages, value);
}

export class IdentityCredentialError extends HttpError {
  constructor(readonly reason: CredentialFailureReason) {
    super(503, reason, credentialFailureMessages[reason]);
  }
}
