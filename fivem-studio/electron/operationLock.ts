/** A tiny main-process mutex for server/artifact operations. Acquiring happens
 * synchronously before the callback can reach its first await, so two IPC
 * requests cannot both pass a stale "idle" check. */
export class OperationLock {
  private activeLabel: string | null = null;

  get active(): string | null {
    return this.activeLabel;
  }

  assertIdle(action: string): void {
    if (this.activeLabel) throw new Error(`Wait for ${this.activeLabel} to finish before ${action}.`);
  }

  async run<T>(label: string, operation: () => Promise<T> | T): Promise<T> {
    this.assertIdle(`starting ${label}`);
    this.activeLabel = label;
    try {
      return await operation();
    } finally {
      this.activeLabel = null;
    }
  }
}
