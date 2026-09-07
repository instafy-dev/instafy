/** A deadline for an entire controller read, including credentials and bodies. */
export function createControllerReadBudget(callerSignal?: AbortSignal) {
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Controller read timed out.", "TimeoutError"));
  }, 10_000);

  async function wait<T>(start: () => Promise<T>): Promise<T> {
    controller.signal.throwIfAborted();
    let handleAbort!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      handleAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", handleAbort, { once: true });
    });
    try {
      // Credential resolution may not support cancellation. Stop waiting for
      // it, consume late rejection, and never start the subsequent HTTP step.
      const operation = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return start();
      });
      const result = await Promise.race([operation, canceled]);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      controller.signal.removeEventListener("abort", handleAbort);
    }
  }

  return {
    signal: controller.signal,
    wait,
    dispose() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}
