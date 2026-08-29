/**
 * Branded identifier types for the Remote Runtime domain.
 *
 * Every entity key is a distinct nominal type so the API and judge lanes
 * cannot accidentally cross-wire ids (for example, passing a problem id
 * where a submission id is expected). Values are strings; the brand is a
 * compile-time-only marker.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ParticipantId = Brand<string, "ParticipantId">;
export type ApiTokenId = Brand<string, "ApiTokenId">;
export type ProblemId = Brand<string, "ProblemId">;
export type TestCaseId = Brand<string, "TestCaseId">;
export type SubmissionId = Brand<string, "SubmissionId">;
export type JudgeAttemptId = Brand<string, "JudgeAttemptId">;
export type AuditLogId = Brand<string, "AuditLogId">;

const PREFIXES: Record<string, string> = {
  ParticipantId: "participant",
  ApiTokenId: "token",
  ProblemId: "problem",
  TestCaseId: "test",
  SubmissionId: "sub",
  JudgeAttemptId: "attempt",
  AuditLogId: "audit",
};

const DEFAULT_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomSuffix(length: number, alphabet: string = DEFAULT_ALPHABET): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length]!;
  return out;
}

function makeId<T extends Brand<string, string>>(prefix: string, length: number): T {
  return `${prefix}_${randomSuffix(length)}` as T;
}

export function newParticipantId(): ParticipantId {
  return makeId(PREFIXES.ParticipantId ?? "participant", 16);
}

export function newApiTokenId(): ApiTokenId {
  return makeId(PREFIXES.ApiTokenId ?? "token", 16);
}

export function newProblemId(): ProblemId {
  return makeId(PREFIXES.ProblemId ?? "problem", 16);
}

export function newTestCaseId(): TestCaseId {
  return makeId(PREFIXES.TestCaseId ?? "test", 16);
}

export function newSubmissionId(): SubmissionId {
  return makeId(PREFIXES.SubmissionId ?? "sub", 16);
}

export function newJudgeAttemptId(): JudgeAttemptId {
  return makeId(PREFIXES.JudgeAttemptId ?? "attempt", 16);
}

export function newAuditLogId(): AuditLogId {
  return makeId(PREFIXES.AuditLogId ?? "audit", 16);
}

/**
 * Structural branding guard: accepts a plain string and narrows it to a
 * branded id at the boundary. Values are opaque to callers, so the string
 * is returned as-is without parsing.
 */
export function asParticipantId(value: string): ParticipantId {
  return value as ParticipantId;
}

export function asApiTokenId(value: string): ApiTokenId {
  return value as ApiTokenId;
}

export function asProblemId(value: string): ProblemId {
  return value as ProblemId;
}

export function asTestCaseId(value: string): TestCaseId {
  return value as TestCaseId;
}

export function asSubmissionId(value: string): SubmissionId {
  return value as SubmissionId;
}

export function asJudgeAttemptId(value: string): JudgeAttemptId {
  return value as JudgeAttemptId;
}

export function asAuditLogId(value: string): AuditLogId {
  return value as AuditLogId;
}

export function isSubmissionId(value: string): value is SubmissionId {
  return /^sub_[A-Za-z0-9]{16}$/.test(value);
}

export function isJudgeAttemptId(value: string): value is JudgeAttemptId {
  return /^attempt_[A-Za-z0-9]{16}$/.test(value);
}

/** Opaque id guard used by the generic get-or-create key used in seeds. */
export function asEntityId<B extends string>(value: string, _brand: B): Brand<string, B> {
  return value as Brand<string, B>;
}
