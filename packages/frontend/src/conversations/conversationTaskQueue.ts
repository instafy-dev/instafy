export interface ConversationTaskQueue {
  enqueue<T>(conversationId: string, task: () => Promise<T>): Promise<T>;
}

export function createConversationTaskQueue(): ConversationTaskQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    async enqueue<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
      const queueKey = conversationId.trim();
      const previous = tails.get(queueKey) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(task);
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(queueKey, tail);

      try {
        return await run;
      } finally {
        if (tails.get(queueKey) === tail) {
          tails.delete(queueKey);
        }
      }
    },
  };
}
