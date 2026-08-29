/**
 * Bearer-token authentication for the Remote Runtime API.
 *
 * Tokens are stored as SHA-256 hashes only (business-logic section 42);
 * the API hashes the presented token and looks it up via
 * Repository.findTokenByHash. A missing, malformed, unknown, or revoked
 * token is 401; a suspended participant is 403.
 */

import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { ApiTokenRecord, ParticipantRecord } from "../domain/entities";
import type { ParticipantId } from "../domain/ids";
import type { Repository } from "../storage/repository";
import { ApiError } from "./errors";

export interface AuthenticatedContext {
  repo: Repository;
  token: ApiTokenRecord;
  participant: ParticipantRecord | null;
}

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/** Hashes a presented bearer token the same way seed tokens are hashed. */
export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function requireAuth(c: Context, repo: Repository): Promise<AuthenticatedContext> {
  const header = c.req.header("authorization");
  if (header === undefined) throw new ApiError(401, "missing bearer token");
  const match = BEARER_PATTERN.exec(header);
  if (match === null) throw new ApiError(401, "malformed bearer token");
  const token = match[1]!;
  const record = await repo.findTokenByHash(hashBearerToken(token));
  if (record === null) throw new ApiError(401, "unknown token");
  if (record.revokedAtMs !== null) throw new ApiError(401, "token revoked");
  const participant = record.participantId === null ? null : await repo.findParticipantById(record.participantId);
  if (participant !== null && participant.status === "SUSPENDED") {
    throw new ApiError(403, "participant suspended");
  }
  return { repo, token: record, participant };
}

export function requireAdmin(auth: AuthenticatedContext): void {
  if (auth.token.role !== "ADMIN") throw new ApiError(403, "admin required");
}

export function participantIdOf(auth: AuthenticatedContext): ParticipantId {
  if (auth.participant === null) throw new ApiError(403, "token has no participant");
  return auth.participant.id;
}
