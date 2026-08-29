# GDG Remote Runtime: demo problem fixture

This directory contains a small demo problem, "double the input", plus
participant source files that produce the participant-controlled outcomes
from the judging state machine. They cover every supported runtime, with C++
also carrying the adversarial failure fixtures; no participant fixture is
TypeScript. The foundation lane seeds the same problem into the local
repository; the judge lane's `runner/judge-driver.ts` and
`tests/judge/fixtures/` cover the same scenarios at the engine level.

## Problem: `double`

Read an integer from stdin, print twice its value to stdout.

- ID: `double`
- Languages: `cpp17`, `c17`, `python3`, `javascript`
- Time limit: 2000 ms (wall), 1500 ms (CPU)
- Memory limit: 262144 KB (256 MiB)
- Output limit: 1048576 bytes (1 MiB)
- Comparator: `NORMALIZED` (CRLF/LF, trailing whitespace per line, trailing
  blank lines ignored; see `src/judge/comparator.ts`)

### Test layout in R2

The hidden test data lives under `problems/{problemId}/{problemVersion}/`
in R2 (architecture section 15). The files here are the plain sources for
that layout; an admin uploads them with the problem fixtures script.

```
problems/double/v1/tests/001.in
problems/double/v1/tests/001.out
problems/double/v1/benchmarks/001.in
problems/double/v1/benchmarks/001.out
```

## Fixtures

| File | Expected status | Why |
|---|---|---|
| `accepted.cpp` | `ACCEPTED` | correct solution |
| `accepted.c` | `ACCEPTED` | correct C17 solution |
| `accepted.py` | `ACCEPTED` | correct Python 3 solution |
| `accepted.cjs` | `ACCEPTED` | correct JavaScript solution |
| `compile-error.cpp` | `COMPILE_ERROR` | missing semicolon |
| `wrong-answer.cpp` | `WRONG_ANSWER` | hard-coded output |
| `infinite-loop.cpp` | `TIME_LIMIT_EXCEEDED` | busy loop |
| `output-flood.cpp` | `OUTPUT_LIMIT_EXCEEDED` | infinite print |
| `memory-overflow.cpp` | `RUNTIME_ERROR` | allocates far past the memory limit |

The memory-overflow fixture demonstrates a program that overflows the
configured memory limit, but with the current local runner it is reported
as `RUNTIME_ERROR`. See the comment at the top of
`sources/memory-overflow.cpp` for why. A `MEMORY_LIMIT_EXCEEDED` demo
requires the runner's aggregate process-group sampling to catch the
overflow, which the judge lane owns.

## Running a fixture

With the local judge driver (the judge lane's script):

```bash
bun run judge:local -- \
  --language cpp17 \
  --source scripts/fixtures/demo/sources/accepted.cpp \
  --input scripts/fixtures/demo/tests/001.in \
  --expected scripts/fixtures/demo/tests/001.out
```

Or directly, before package.json exists:

```bash
bun runner/judge-driver.ts -- \
  --language cpp17 \
  --source scripts/fixtures/demo/sources/accepted.cpp \
  --input scripts/fixtures/demo/tests/001.in \
  --expected scripts/fixtures/demo/tests/001.out
```

Resource limits come from the environment variables `JUDGE_WALL_MS`,
`JUDGE_CPU_MS`, `JUDGE_MEMORY_KB`, `JUDGE_OUTPUT_BYTES`, and
`JUDGE_MAX_PROCESSES` (see `runner/judge-driver.ts`). Defaults match the
problem limits above.

For `TIME_LIMIT_EXCEEDED` and `OUTPUT_LIMIT_EXCEEDED` you may want a
smaller CPU or output cap so the demo finishes quickly:

```bash
JUDGE_CPU_MS=500 bun runner/judge-driver.ts -- \
  --source scripts/fixtures/demo/sources/infinite-loop.cpp \
  --input scripts/fixtures/demo/tests/001.in \
  --expected scripts/fixtures/demo/tests/001.out
```

## Admin upload sequence (Cloudflare)

1. Apply migrations: `bun run db:migrate` (or `wrangler d1 migrations apply DB`).
2. Create the problem and version via the admin API or seed script.
3. Upload each test/benchmark file to R2 under the versioned key prefix.
4. Create testcase metadata rows in D1.
5. Activate version 1.
6. Run each fixture above against the deployed judge and confirm the
   expected outcome column before opening the contest.

Never overwrite files under an existing version. Fix a bug by creating
version 2, not by editing version 1 (business logic section 6).
