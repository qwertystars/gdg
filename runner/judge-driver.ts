import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JudgeLimits, LocalCpp17Judge, serializePublicResult } from "../src/judge";
import { isSubmissionLanguage } from "../src/judge/languages";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) throw new Error(`missing ${name}`);
  return value;
}

const source = await readFile(argument("--source"), "utf8");
const input = await readFile(argument("--input"), "utf8");
const expected = await readFile(argument("--expected"), "utf8");
const languageIndex = process.argv.indexOf("--language");
const languageValue = languageIndex < 0 ? "cpp17" : process.argv[languageIndex + 1];
if (languageValue === undefined || !isSubmissionLanguage(languageValue)) {
  throw new Error("--language must be one of cpp17, c17, python3, javascript");
}
const limits: JudgeLimits = {
  wallTimeMs: Number(process.env.JUDGE_WALL_MS ?? 2000),
  cpuTimeMs: Number(process.env.JUDGE_CPU_MS ?? 1500),
  memoryKb: Number(process.env.JUDGE_MEMORY_KB ?? 262144),
  outputBytes: Number(process.env.JUDGE_OUTPUT_BYTES ?? 1048576),
  maxProcesses: Number(process.env.JUDGE_MAX_PROCESSES ?? 16),
};
const root = await mkdtemp(join(tmpdir(), "judge-driver-"));
const result = await new LocalCpp17Judge({ workspaceRoot: root }).judge({
  language: languageValue,
  source,
  correctness: [{ id: "driver", input, expected }],
  limits,
});
console.log(serializePublicResult(result));
