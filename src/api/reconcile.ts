import type { Repository } from "../storage/repository";
import type { SubmissionQueue } from "./queue-adapter";

export const DISPATCH_RETRY_AFTER_MS = 30_000;
export const DISPATCH_BATCH_SIZE = 100;

/**
 * Re-enqueue non-terminal submissions whose API-to-Queue handoff may have
 * been interrupted. Duplicate messages are safe because execution claims
 * are conditional on the D1 lease.
 */
export async function reconcileSubmissionDispatches(
  repo: Repository,
  queue: SubmissionQueue,
  nowMs: number,
): Promise<number> {
  const rows = await repo.listDispatchableSubmissions(nowMs - DISPATCH_RETRY_AFTER_MS, DISPATCH_BATCH_SIZE);
  let dispatched = 0;
  for (const row of rows) {
    if (row.status === "CREATED") await repo.setSubmissionStatus(row.id, "QUEUED", nowMs);
    await repo.markDispatchAttempt(row.id, nowMs);
    await queue.enqueue(row.id);
    dispatched++;
  }
  return dispatched;
}
