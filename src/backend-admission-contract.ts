export const BACKEND_LEASE_MS = 30_000;
export const BACKEND_DEADLINE_MS = 60_000;

export type Admission = {
  acquire(id: string, client: string, limit: number): Promise<boolean>;
  renew(id: string): Promise<boolean>;
  release(id: string): Promise<void>;
};
