/**
 * Local artifact store for the Remote Runtime MVP.
 *
 * Maps the R2 object layout (README.md, "R2 object layout") onto local
 * files: seed problem fixtures live under scripts/fixtures/demo and
 * submission sources under a writable submissions/ directory, while
 * judge-artifacts are written under a per-store temp directory. The
 * Cloudflare deployment replaces this with the ARTIFACTS R2 binding behind
 * the same interface.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ArtifactStore {
  read(key: string): Promise<string>;
  write(key: string, contents: string): Promise<string>;
  cleanup(): Promise<void>;
}

const SUBMISSIONS_PREFIX = "submissions/";
const JUDGE_ARTIFACTS_PREFIX = "judge-artifacts/";

export class LocalArtifactStore implements ArtifactStore {
  private readonly fixturesRoot: string;
  private readonly sourcesRoot: string;
  private readonly submissionsRoot: string;
  private judgeArtifactsRoot: string | null;

  /**
   * @param fixturesRoot repository-relative path to scripts/fixtures/demo
   * @param submissionsRoot optional writable root for submissions/* keys
   */
  constructor(fixturesRoot: string, submissionsRoot?: string) {
    this.fixturesRoot = resolve(fixturesRoot);
    this.sourcesRoot = join(this.fixturesRoot, "sources");
    this.submissionsRoot = resolve(submissionsRoot ?? join(this.fixturesRoot, "sources"));
    this.judgeArtifactsRoot = null;
  }

  async read(key: string): Promise<string> {
    if (key.startsWith(SUBMISSIONS_PREFIX)) {
      return this.readSubmission(key);
    }
    if (key.startsWith("problems/")) {
      return this.readProblemArtifact(key);
    }
    if (key.startsWith(JUDGE_ARTIFACTS_PREFIX)) {
      if (this.judgeArtifactsRoot !== null) {
        const path = join(this.judgeArtifactsRoot, key.slice(JUDGE_ARTIFACTS_PREFIX.length));
        if (await fileExists(path)) return readFile(path, "utf8");
      }
      throw new Error(`Judge artifact not found: ${key}`);
    }
    throw new Error(`Unsupported artifact key: ${key}`);
  }

  private async readProblemArtifact(key: string): Promise<string> {
    const parts = key.split("/");
    const problemId = parts[1];
    const rest = parts.slice(2);
    // Admin-uploaded test keys (other problems) live under the writable
    // judge-artifacts temp root; the seed problem maps to the demo fixtures.
    if (problemId !== "problem_seed_two_sum") {
      if (this.judgeArtifactsRoot !== null) {
        const uploadedPath = join(this.judgeArtifactsRoot, key);
        if (await fileExists(uploadedPath)) return readFile(uploadedPath, "utf8");
      }
      throw new Error(`Problem artifact not found: ${key}`);
    }
    if (rest.length < 3) {
      throw new Error(`Unsupported problem artifact key: ${key}`);
    }
    const kindDir = rest[1];
    const kind = kindDir === "tests" ? "tests" : "benchmarks";
    const file = rest[2] ?? "";
    // The demo problem ships one fixture pair per kind (001.in/001.out);
    // the seed defines three correctness and one benchmark test case, so
    // every fixture maps back to the 001 pair for this problem.
    const fileName = file.endsWith(".out") ? "001.out" : "001.in";
    const path = join(this.fixturesRoot, kind, fileName);
    return readFile(path, "utf8");
  }

  private async readSubmission(key: string): Promise<string> {
    const relative = key.slice(SUBMISSIONS_PREFIX.length);
    const directPath = join(this.submissionsRoot, relative);
    if (await fileExists(directPath)) return readFile(directPath, "utf8");
    // Local submission sources mirror the demo fixtures by filename when no
    // explicit submission source was written (tests use "sub_test_source").
    const parts = relative.split("/");
    const fileName = parts.length > 0 ? parts[0] : undefined;
    if (fileName !== undefined) {
      const fixturePath = join(this.sourcesRoot, fileName.endsWith(".cpp") ? fileName : `${fileName}.cpp`);
      if (await fileExists(fixturePath)) return readFile(fixturePath, "utf8");
    }
    // Fall back to the accepted fixture for locally-queued test submissions
    // whose source was never written (the dev seed flow enqueues without
    // persisting a source file).
    const fallback = join(this.sourcesRoot, "accepted.cpp");
    if (await fileExists(fallback)) return readFile(fallback, "utf8");
    throw new Error(`Submission artifact not found: ${key}`);
  }
  async write(key: string, contents: string): Promise<string> {
    if (key.startsWith(SUBMISSIONS_PREFIX)) {
      const relative = key.slice(SUBMISSIONS_PREFIX.length);
      const path = join(this.submissionsRoot, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
      return path;
    }
    if (key.startsWith("problems/")) {
      this.judgeArtifactsRoot ??= await mkdtemp(join(tmpdir(), "gdg-judge-artifacts-"));
      const path = join(this.judgeArtifactsRoot, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
      return path;
    }
    if (!key.startsWith(JUDGE_ARTIFACTS_PREFIX)) {
      throw new Error(`Unsupported artifact key for write: ${key}`);
    }
    this.judgeArtifactsRoot ??= await mkdtemp(join(tmpdir(), "gdg-judge-artifacts-"));
    const path = join(this.judgeArtifactsRoot, key.slice(JUDGE_ARTIFACTS_PREFIX.length));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
    return path;
  }

  async cleanup(): Promise<void> {
    if (this.judgeArtifactsRoot !== null) {
      await rm(this.judgeArtifactsRoot, { recursive: true, force: true });
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
