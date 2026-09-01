export async function withCredentialGenerationLock<T>(
  accountId: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = locks.get(accountId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(accountId, queued);
  try {
    await waitForPrevious(previous, signal);
  } catch (error: unknown) {
    release();
    void queued.finally(() => {
      if (locks.get(accountId) === queued) {
        locks.delete(accountId);
      }
    });
    throw error;
  }
  try {
    return await work();
  } finally {
    release();
    if (locks.get(accountId) === queued) {
      locks.delete(accountId);
    }
  }
}

const locks = new Map<string, Promise<void>>();

async function waitForPrevious(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) {
    await previous;
    return;
  }
  let removeAbortListener = (): void => undefined;
  await Promise.race([
    previous,
    new Promise<void>((_resolve, reject) => {
      const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }),
  ]).finally(removeAbortListener);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("aborted", "AbortError");
  }
}
