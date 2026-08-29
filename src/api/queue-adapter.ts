/**
 * Local submission queue adapter for the Remote Runtime MVP.
 *
 * The API layer enqueues submission ids; the local adapter processes them
 * synchronously via flush() (used by tests and the dev server), while the
 * Cloudflare deployment binds Cloudflare Queues behind the same interface.
 */

import type { SubmissionId } from "../domain/ids";

export interface SubmissionQueue {
  enqueue(submissionId: SubmissionId): Promise<void>;
}

export interface QueueConsumer {
  consume(submissionId: SubmissionId): Promise<void>;
}

export class LocalQueueAdapter implements SubmissionQueue {
  private consumer: QueueConsumer | null;
  private readonly pendingIds: SubmissionId[] = [];
  private flushing: Promise<void> | null = null;

  constructor(consumer: QueueConsumer | null = null) {
    this.consumer = consumer;
  }

  /** Attach (or replace) the consumer; used by createApp to wire judging. */
  setConsumer(consumer: QueueConsumer): void {
    this.consumer = consumer;
  }

  enqueue(submissionId: SubmissionId): Promise<void> {
    this.pendingIds.push(submissionId);
    return Promise.resolve();
  }

  pending(): number {
    return this.pendingIds.length;
  }

  /** Processes every pending submission id once; concurrent calls share one pass. */
  flush(): Promise<void> {
    if (this.flushing === null) {
      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.pendingIds.length > 0) {
      const submissionId = this.pendingIds.shift()!;
      await this.consumer?.consume(submissionId);
    }
  }
}
