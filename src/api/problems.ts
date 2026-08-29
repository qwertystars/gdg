/**
 * Problem listing/detail routes (business-logic sections 5, 59).
 * Participant-visible problem objects never include hidden test data.
 */

import { Hono } from "hono";
import type { ProblemRecord } from "../domain/entities";
import { asProblemId } from "../domain/ids";
import { SUPPORTED_LANGUAGES } from "../judge/languages";
import type { Repository } from "../storage/repository";
import { requireAuth } from "./auth";
import { ApiError } from "./errors";

export function problemView(problem: ProblemRecord): Record<string, unknown> {
  return {
    id: problem.id,
    slug: problem.slug,
    title: problem.title,
    lifecycleState: problem.lifecycleState,
    activeVersion: problem.activeVersion,
    limits: problem.limits,
    supportedLanguages: SUPPORTED_LANGUAGES,
  };
}

export function problemsRoutes(repo: Repository): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    await requireAuth(c, repo);
    const problems = await repo.listProblems();
    return c.json({ problems: problems.map(problemView) });
  });

  app.get("/:problemId", async (c) => {
    await requireAuth(c, repo);
    const problem = await repo.findProblemById(asProblemId(c.req.param("problemId")));
    if (problem === null) throw new ApiError(404, "problem not found");
    return c.json(problemView(problem));
  });

  return app;
}
