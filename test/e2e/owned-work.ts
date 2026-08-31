// Test-owned requests, background work and gate releases. Rejections remain on
// the caller's promise and are also reported by teardown if the caller left.
export class OwnedWork {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly releases = new Set<() => void | Promise<unknown>>();
  private errors: unknown[] = [];
  private closing = false;

  start(): void {
    if (this.pending.size || this.releases.size || this.errors.length) {
      throw new Error("Previous test still owns unfinished work");
    }
    this.closing = false;
  }

  track<P extends Promise<unknown>>(promise: P): P {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      (error: unknown) => {
        this.pending.delete(promise);
        this.errors.push(error);
      },
    );
    return promise;
  }

  registerRelease(release: () => void | Promise<unknown>): () => void {
    if (this.closing) {
      this.track(Promise.resolve().then(release));
    } else {
      this.releases.add(release);
    }
    return () => this.releases.delete(release);
  }

  gate(): { promise: Promise<void>; release(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const unregister = this.registerRelease(resolve);
    return {
      promise,
      release() {
        unregister();
        resolve();
      },
    };
  }

  releaseGates(): void {
    this.closing = true;
    for (const release of this.releases) {
      this.releases.delete(release);
      this.track(Promise.resolve().then(release));
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size) {
      await Promise.allSettled(this.pending);
    }
    const errors = this.errors.splice(0);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Test-owned work failed");
  }

  async finish(): Promise<void> {
    this.releaseGates();
    await this.drain();
  }
}

// One instance per isolated Worker test file, shared by setup and the harness.
export const ownedWork = new OwnedWork();
