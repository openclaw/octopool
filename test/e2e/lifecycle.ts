// Vitest's deadline rejects the hook without cancelling its underlying promise.
// Keep the operation owned until it settles, and never let another test race it.
export class IsolationLifecycle {
  private active = false;
  private failure: Error | undefined;

  constructor(private readonly hookTimeout: number) {}

  poison(reason: unknown): void {
    this.failure ??= new Error(
      "Worker test isolation is poisoned; refusing subsequent test bodies",
      {
        cause: reason,
      },
    );
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
  }

  async run(operation: () => Promise<void>, cleanup = false): Promise<void> {
    if (!cleanup) this.assertHealthy();
    if (this.active) {
      this.poison(new Error("Previous isolation hook has not settled"));
      this.assertHealthy();
    }
    this.active = true;
    const started = Date.now();
    const timeout = setTimeout(() => {
      this.poison(new Error("Isolation hook exceeded the Vitest hook deadline"));
    }, this.hookTimeout);
    try {
      await operation();
      // A busy event loop can finish work before dispatching the deadline timer.
      if (Date.now() - started >= this.hookTimeout) {
        this.poison(new Error("Isolation hook exceeded the Vitest hook deadline"));
      }
      this.assertHealthy();
    } catch (error) {
      this.poison(error);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.active = false;
    }
  }
}
