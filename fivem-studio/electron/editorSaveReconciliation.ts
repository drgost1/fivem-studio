export interface EditorBufferState {
  content: string;
  revision: string;
  dirty: boolean;
}

/** Reconcile a completed asynchronous write without replacing edits that were
 * typed after that write began. The returned disk revision is still important:
 * it becomes the expected revision for the next serialized save. */
export function reconcileSuccessfulSave<T extends EditorBufferState>(
  current: T,
  savedContent: string,
  savedRevision: string,
): T {
  if (current.content === savedContent) {
    return { ...current, revision: savedRevision, dirty: false };
  }
  return { ...current, revision: savedRevision, dirty: true };
}

/** Serialize writes to the same absolute path while allowing unrelated files
 * to save independently. A rejected save does not poison the next request. */
export class PerPathSaveQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  async run<T>(path: string, save: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(save);
    this.queues.set(path, operation);
    try {
      return await operation;
    } finally {
      if (this.queues.get(path) === operation) this.queues.delete(path);
    }
  }
}
