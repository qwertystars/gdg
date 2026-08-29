import { rm } from "node:fs/promises";
import type { CleanupEvidence, ProcessExecutionAdapter, SandboxSession } from "./types";

export async function cleanupAttempt(
  sandbox: SandboxSession | undefined,
  processAdapter: ProcessExecutionAdapter,
  workspace: string,
): Promise<CleanupEvidence> {
  let sandboxDestroyed = false;
  try {
    if (sandbox) {
      await sandbox.destroy();
      sandboxDestroyed = true;
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  return {
    sandboxDestroyed,
    workspaceRemoved: true,
    remainingProcessIds: processAdapter.remainingProcessIds(),
  };
}
