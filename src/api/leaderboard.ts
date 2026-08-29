/**
 * Leaderboard routes (business-logic sections 38, 62).
 *
 * Per problem: ACCEPTED submissions only, best accepted submission per
 * participant = the minimum tuple (performanceScoreNs, peakMemoryKb,
 * completedAtMs), entries sorted ascending by that tuple. Rank is the
 * 1-based position in the sorted list. Never exposes storage keys.
 */

import { Hono } from "hono";
import type { SubmissionRecord } from "../domain/entities";
import { asProblemId } from "../domain/ids";
import type { Repository } from "../storage/repository";
import { requireAuth } from "./auth";
import { ApiError } from "./errors";

export interface LeaderboardEntry {
  rank: number;
  participantId: string;
  problemId: string;
  submissionId: string;
  performanceScoreNs: number;
  peakMemoryKb: number;
  completedAtMs: number;
}

function entryTuple(entry: LeaderboardEntry): [number, number, number] {
  return [entry.performanceScoreNs, entry.peakMemoryKb, entry.completedAtMs];
}

export function computeLeaderboard(rows: readonly SubmissionRecord[], problemId: string): LeaderboardEntry[] {
  const accepted: Array<{
    submissionId: string;
    participantId: string;
    performanceScoreNs: number;
    peakMemoryKb: number;
    completedAtMs: number;
  }> = [];
  for (const row of rows) {
    if (row.performanceScoreNs === null || row.peakMemoryKb === null || row.completedAtMs === null) continue;
    accepted.push({
      submissionId: row.id,
      participantId: row.participantId,
      performanceScoreNs: row.performanceScoreNs,
      peakMemoryKb: row.peakMemoryKb,
      completedAtMs: row.completedAtMs,
    });
  }
  const byParticipant = new Map<string, (typeof accepted)[number]>();
  for (const row of accepted) {
    const current = byParticipant.get(row.participantId);
    if (current === undefined) {
      byParticipant.set(row.participantId, row);
      continue;
    }
    const currentTuple: [number, number, number] = [
      current.performanceScoreNs,
      current.peakMemoryKb,
      current.completedAtMs,
    ];
    const candidateTuple: [number, number, number] = [row.performanceScoreNs, row.peakMemoryKb, row.completedAtMs];
    for (let i = 0; i < 3; i++) {
      if (candidateTuple[i]! < currentTuple[i]!) {
        byParticipant.set(row.participantId, row);
        break;
      }
      if (candidateTuple[i]! > currentTuple[i]!) break;
    }
  }
  const entries = [...byParticipant.values()]
    .map((row) => ({
      rank: 0,
      participantId: row.participantId,
      problemId,
      submissionId: row.submissionId,
      performanceScoreNs: row.performanceScoreNs,
      peakMemoryKb: row.peakMemoryKb,
      completedAtMs: row.completedAtMs,
    }))
    .sort((a, b) => {
      const aTuple = entryTuple(a);
      const bTuple = entryTuple(b);
      for (let i = 0; i < 3; i++) {
        if (aTuple[i]! !== bTuple[i]!) return aTuple[i]! - bTuple[i]!;
      }
      return a.submissionId.localeCompare(b.submissionId);
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  return entries;
}

export function leaderboardRoutes(repo: Repository): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    await requireAuth(c, repo);
    const problems = await repo.listProblems();
    const problemsWithAccepted = new Set<string>();
    for (const problem of problems) {
      const rows = await repo.listSubmissions({ problemId: problem.id, status: "ACCEPTED" }, null, 1000);
      if (rows.items.length > 0) problemsWithAccepted.add(problem.id);
    }
    const entries: LeaderboardEntry[] = [];
    for (const problem of problems) {
      if (!problemsWithAccepted.has(problem.id)) continue;
      const rows = await repo.listSubmissions({ problemId: problem.id, status: "ACCEPTED" }, null, 1000);
      entries.push(...computeLeaderboard(rows.items, problem.id));
    }
    return c.json({ entries });
  });

  app.get("/:problemId", async (c) => {
    await requireAuth(c, repo);
    const problem = await repo.findProblemById(asProblemId(c.req.param("problemId")));
    if (problem === null) throw new ApiError(404, "problem not found");
    const rows = await repo.listSubmissions({ problemId: problem.id, status: "ACCEPTED" }, null, 1000);
    return c.json({ entries: computeLeaderboard(rows.items, problem.id) });
  });

  return app;
}
