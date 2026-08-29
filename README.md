# GDG Remote Runtime Environment

Backend for the GDG VIT Chennai speed-coding event. Participants submit
source code in C++17, C17, Python 3, or JavaScript over HTTP; the platform compiles or validates it once, runs it in an
isolated sandbox, checks correctness against hidden tests, benchmarks
correct submissions, and returns a deterministic judgment with trusted
CPU/memory metrics.

There is no frontend. Any HTTP client that can authenticate can use the
platform. The two design documents in the repository root,
`remote-runtime-backend-architecture.md` and
`remote-runtime-business-logic.md`, are the authoritative requirements.
This README describes the working repository and how to run it.

## What this repository contains

| Path | Purpose |
|---|---|
| `src/domain/`, `src/storage/` | Typed domain model, submission state machine, lease/claim logic, in-memory repository, seed data (foundation lane) |
| `src/judge/`, `runner/` | Multi-language adapters, native supervisor, comparator, resource classification, median scoring, cleanup |
| `src/api/`, `src/index.ts` | Hono HTTP API, auth, submission orchestration, queue adapter (api lane) |
| `migrations/` | D1 schema and indexes |
| `wrangler.jsonc` | Cloudflare deployment configuration |
| `scripts/` | Judge CLI, token creation, migration scaffolding, demo fixtures, config checks |
| `README.md` | This file |

### Supported languages

| ID | Compile/check stage | Execution |
|---|---|---|
| `cpp17` | GCC, `-std=c++17 -O2 -pipe` | native binary |
| `c17` | GCC, `-std=c17 -O2 -pipe` | native binary |
| `python3` | fixed `py_compile` syntax check | isolated Python (`-I -B`) |
| `javascript` | fixed Node.js syntax check | Node.js with addons disabled |

Problem versions select a subset through their immutable `languagePolicy`.
Commands, flags, filenames, execution arguments, and memory-accounting mode
come from the trusted registry in `src/judge/languages.ts`; source text is
never interpolated into a command. Native programs receive address-space plus
RSS/cgroup limits. Managed runtimes use RSS/cgroup memory enforcement so large
virtual reservations by V8 or Python are not mistaken for resident memory.

Problem versions also snapshot all runtime and compilation limits. Changing a
problem's defaults affects only later versions; an already queued submission
always uses the limits attached to its recorded version.

Both compile/check and execution stages run beneath the trusted native
supervisor. Compiler processes receive a minimal environment, dropped
privileges, a disposable writable build directory, and independent CPU,
wall-time, memory, process, descriptor, and output caps.

## Local vs Cloudflare: the adapter boundary

The MVP runs fully locally with no Cloudflare account. Cloudflare bindings
(D1, R2, Queues, Sandbox/Containers) do not exist in this workspace, so
the TypeScript code depends on narrow adapter interfaces and the local
implementations behind them. Deploying to Cloudflare swaps the adapters
without changing domain behavior.

| Concern | Local MVP | Cloudflare |
|---|---|---|
| Submission state | In-memory repository (`src/storage/`) | D1 (`DB` binding) |
| Source and test files | Local temp workspace | R2 (`ARTIFACTS` binding) |
| Submission queue | Queue adapter interface, immediate local dispatch | Cloudflare Queues (`judge-queue`) |
| Execution | `LocalProcessExecutionAdapter` spawns `g++` and the participant binary in a temp directory | Sandbox SDK creates a Cloudflare Container per attempt |
| Sandbox | Temp workspace under the OS tmp dir, destroyed after the attempt | Fresh sandbox per attempt, `sandbox.destroy()` in a `finally` |

The adapter seams live in `src/judge/types.ts`
(`ProcessExecutionAdapter`, `SandboxAdapter`, `CompilerAdapter`) and the
storage/queue interfaces in `src/storage/` and `src/api/`. The judge lane
owns the local implementations; the api lane owns the queue adapter. If a
Cloudflare implementation is added later, it must satisfy the same
interfaces, so the domain and judge logic stay untouched.

The trust boundary is identical in both modes. Participant code never
receives a D1 binding, an R2 binding, credentials, secrets, expected
outputs, or any other participant's files. It runs as an unprivileged
process with no public Internet.

## API routes and auth model

Bearer tokens over HTTPS. Only the SHA-256 hash of a token is stored in
D1; the plaintext token is issued once at creation. Roles are
`PARTICIPANT` and `ADMIN` (architecture section 41, business logic
section 59).

| Method | Route | Role | Purpose |
|---|---|---|---|
| GET | `/api/v1/health` | none | Liveness; never runs participant code |
| GET | `/api/v1/problems` | any | List active problems |
| GET | `/api/v1/problems/:problemId` | any | Problem details (no hidden tests) |
| POST | `/api/v1/submissions` | PARTICIPANT, ADMIN | Submit supported source code, returns `202` + `submissionId` |
| GET | `/api/v1/submissions` | PARTICIPANT | Own submissions only (filtered by token identity) |
| GET | `/api/v1/submissions/:submissionId` | PARTICIPANT | Own submission result |
| GET | `/api/v1/leaderboard` | any | Per-problem leaderboard |
| GET | `/api/v1/leaderboard/:problemId` | any | Single-problem leaderboard |
| POST | `/api/v1/admin/problems` | ADMIN | Create problem (DRAFT) |
| PATCH | `/api/v1/admin/problems/:problemId` | ADMIN | Edit limits/metadata |
| POST | `/api/v1/admin/problems/:problemId/versions` | ADMIN | New problem version |
| POST | `/api/v1/admin/problems/:problemId/versions/:version/tests` | ADMIN | Upload hidden tests |
| POST | `/api/v1/admin/problems/:problemId/activate/:version` | ADMIN | Activate a frozen version |
| POST | `/api/v1/admin/submissions/:submissionId/rejudge` | ADMIN | Rejudge with audit trail |
| GET | `/api/v1/admin/judge-errors` | ADMIN | Infrastructure failure inspection |

Submission body:

```json
{
  "problemId": "double",
  "language": "cpp17",
  "source": "#include <iostream>..."
}
```

The client never sends limits, expected output, or a score. Those are
server-owned. Validation order is auth, authorization, problem active,
language supported, source non-empty and under `SOURCE_LIMIT_BYTES`
(128 KiB), then rate limit. A rejected rate-limited request is not stored.

## Submission lifecycle and statuses

```
CREATED -> QUEUED -> RUNNING -> one of:
  COMPILE_ERROR | WRONG_ANSWER | RUNTIME_ERROR
  TIME_LIMIT_EXCEEDED | MEMORY_LIMIT_EXCEEDED
  OUTPUT_LIMIT_EXCEEDED | ACCEPTED | JUDGE_ERROR
```

Every status except `CREATED`, `QUEUED`, and `RUNNING` is terminal. A
duplicate queue delivery for a terminal submission is acknowledged and
never rerun.

## Queue, lease, and idempotency invariants

These are the load-bearing rules. Do not weaken them.

1. **At-least-once delivery.** Cloudflare Queues can deliver a message
   more than once. Treat every delivery as potentially duplicated.
2. **One queue message is one judging attempt**, and the payload is only
   `{ "submissionId": "sub_..." }`. No source, tests, or secrets ride in
   the message.
3. **D1 is the authority.** A consumer claims a submission with a
   conditional update:

   ```sql
   UPDATE submissions
   SET status = 'RUNNING',
       execution_token = ?,
       lease_until = ?,
       attempt_count = attempt_count + 1,
       started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
       updated_at = CURRENT_TIMESTAMP
   WHERE id = ?
     AND (status = 'QUEUED'
          OR (status = 'RUNNING' AND lease_until < CURRENT_TIMESTAMP));
   ```

   The worker proceeds only if its update affected a row.
4. **A lease is required.** A worker can vanish after setting `RUNNING`.
   `RUNNING` plus an expired `lease_until` is reclaimable by a redelivery.
   The lease duration (`LEASE_DURATION_MS`, 10 minutes) must exceed a
   normal attempt, and Queue consumer invocations cap at 15 minutes.
5. **Only the current execution token commits.** Terminal writes are
   conditional on `execution_token = <the token this attempt holds>`.
   A stale worker whose lease expired must not overwrite a newer attempt's
   result (business logic section 49).
6. **Persist, then ACK.** The queue message is acknowledged only after the
   logical result is safely in D1. ACK-then-crash loses submissions.
7. **Participant failures are terminal, not retries.** Compile errors,
   wrong answers, runtime errors, and limit violations are valid judgments
   and are acknowledged. Only infrastructure failures (sandbox creation,
   R2/D1 transient errors, platform errors, runner startup failure) are
   retried.
8. **Retries are bounded.** `max_retries = 3` on the queue; repeated
   infrastructure failure becomes `JUDGE_ERROR` and lands on the
   `judge-dlq` dead-letter queue for operator inspection.
9. **Fresh sandbox per attempt.** `try { judge } finally { destroy
   sandbox }`. If the worker dies first, the container/sandbox lifecycle
   timeout is the fallback. No sandbox is reused across submissions.

## Security limits

| Limit | Value | Source |
|---|---|---|
| Source size | 128 KiB | architecture section 44 |
| Submission rate | 5 per 10 seconds per participant | business logic section 64 |
| CPU limit | 1500 ms per test run | problem config |
| Wall timeout | 2000 ms per test run | problem config |
| Memory limit | 256 MiB per test run | problem config |
| Output limit | 1 MiB stdout/stderr | architecture section 22 |
| Process limit | 16 processes (fork-bomb guard) | architecture section 22 |
| Compile wall limit | 10 s, separate from runtime | business logic section 67 |
| Compile output cap | 256 KiB | business logic section 67 |
| Compiler feedback to participant | first 64 KiB | business logic section 44 |
| Concurrent judges | 10 | architecture section 8 |
| Infrastructure retries | 3 | business logic section 48 |
| Lease duration | 10 minutes | wrangler vars |
| Queue message retention | 4 days (platform default) | queue config |

The sandbox gets no D1/R2 binding, no secrets, no expected outputs, and no
public Internet. Expected outputs are compared on the trusted Worker
side; they never enter the sandbox. Participant code is always treated as
hostile, even after it compiles.

## Setup

Prerequisites: [Bun](https://bun.sh) 1.x, GCC/G++, Python 3, Node.js, and
GNU coreutils. No Cloudflare account is needed for local work.

```bash
bun install                 # installs dev dependencies once package.json exists
bun run db:migrate          # applies migrations/ to local D1 (requires wrangler)
bun run db:seed             # seeds the demo problem, participants, tokens (api lane)
bun run dev                 # wrangler dev for the API worker (api lane)
```

## Running the judge locally

The judge engine and its driver are owned by the judge lane. Once
`package.json` exists with the scripts, the commands are:

```bash
bun run judge --help                     # CLI usage, exits immediately
bun run judge:local -- \
  --source scripts/fixtures/demo/sources/accepted.cpp \
  --input scripts/fixtures/demo/tests/001.in \
  --expected scripts/fixtures/demo/tests/001.out
```

`bun run judge:local` runs `runner/judge-driver.ts`, which compiles the
source with `g++ -std=c++17 -O2 -pipe`, runs it against the given input,
compares stdout to the expected output, and prints the public result.
Limits can be tuned with `JUDGE_WALL_MS`, `JUDGE_CPU_MS`,
`JUDGE_MEMORY_KB`, `JUDGE_OUTPUT_BYTES`, and `JUDGE_MAX_PROCESSES`
environment variables.

Before `package.json` exists (the foundation lane creates it), run the
same surface directly:

```bash
bun scripts/judge.ts --help
bun runner/judge-driver.ts -- \
  --source scripts/fixtures/demo/sources/accepted.cpp \
  --input scripts/fixtures/demo/tests/001.in \
  --expected scripts/fixtures/demo/tests/001.out
```

## Running the test suites

```bash
bun test                    # all suites: domain, judge, api
bun test tests/domain       # foundation lane
bun test tests/judge        # judge lane
bun run test:api            # api lane (bun test tests/api)
bun run typecheck           # tsc --noEmit across the tree
bun run lint                # biome check
bun run build               # emit the worker bundle
```

The judge suite covers accepted, compile error, wrong answer, infinite
loop timeout, output flood, and median scoring. The domain suite covers
state transitions, claim leases, and stale-result protection. None of
these suites require a Cloudflare account.

## Demo fixtures

`scripts/fixtures/demo/` is a self-contained demo problem, "double the
input", with source files for every participant-controlled outcome:

| Source | Expected status |
|---|---|
| `sources/accepted.cpp` | `ACCEPTED` |
| `sources/compile-error.cpp` | `COMPILE_ERROR` |
| `sources/wrong-answer.cpp` | `WRONG_ANSWER` |
| `sources/infinite-loop.cpp` | `TIME_LIMIT_EXCEEDED` |
| `sources/output-flood.cpp` | `OUTPUT_LIMIT_EXCEEDED` |
| `sources/memory-overflow.cpp` | `RUNTIME_ERROR` (see note below) |

## Operational scripts

| Command | What it does |
|---|---|
| `bun run judge --help` | CLI usage, exits immediately, starts nothing |
| `bun run scripts/token:create -- <participant-id> [--role ADMIN]` | Create an API token; prints plaintext once, stores only the SHA-256 hash (`scripts/token-create.sh`) |
| `bun run scripts/token:create -- <participant-id> --offline` | Same, but prints a SQL snippet instead of touching D1 |
| `bun run scripts/migration:new -- <name>` | Scaffold the next numbered D1 migration (`scripts/migration-new.sh`) |
| `bun run scripts/check:wrangler --` | Validate `wrangler.jsonc` syntax without wrangler (`scripts/check-wrangler-jsonc.ts`) |

## Deployment bindings

`wrangler.jsonc` is the single source of truth for the Cloudflare
topology. It declares:

| Binding / resource | Name | Notes |
|---|---|---|
| D1 | `DB` | `database_id` must be replaced with the real one |
| R2 | `ARTIFACTS` | bucket `gdg-remote-runtime-artifacts` |
| Queue producer | `JUDGE_QUEUE` | writes `judge-queue` |
| Queue consumer | (none, `judge-queue`) | `max_batch_size 1`, `max_concurrency 10`, `max_retries 3`, DLQ `judge-dlq` |
| Container | `Sandbox` | `standard-2`, `max_instances 10`, APAC placement, image `./Dockerfile` |
| Durable Object | `Sandbox` | matches the container class name; DO migration `v1` in the wrangler `migrations` block |

The `max_concurrency` of the queue consumer and the `max_instances` of the
container are deliberately kept equal: a burst can never start more
judges than the container cap allows. Both default to 10 and scale
together (architecture sections 8 and 51).

Deploy steps:

```bash
bunx wrangler d1 migrations apply DB --remote   # apply D1 schema
bunx wrangler r2 bucket create gdg-remote-runtime-artifacts
bunx wrangler deploy                             # builds the container image
bunx wrangler secret put JUDGE_SIGNING_SECRET    # if the auth design requires it
```

Secrets are never stored in `wrangler.jsonc`; use `wrangler secret put`.

## R2 object layout

```
submissions/{submissionId}/source.{cpp|c|py|cjs}
problems/{problemId}/{problemVersion}/tests/001.in
problems/{problemId}/{problemVersion}/tests/001.out
problems/{problemId}/{problemVersion}/benchmarks/001.in
problems/{problemId}/{problemVersion}/benchmarks/001.out
judge-artifacts/{submissionId}/{attempt}/compile.log   (optional)
```

The API stores a SHA-256 digest with every submission source and every hidden
test artifact. The consumer verifies those digests before invoking a compiler
or interpreter. Missing or mismatched integrity metadata is an infrastructure
failure, never participant-controlled execution.

Problem data is versioned and immutable. Never overwrite files under an
existing version; create a new version and rejudge explicitly. A
submission records the problem version it was judged against, so
historical judgments stay reproducible.

## Durable Queue handoff

D1 is the authoritative submission ledger. Because D1 and Cloudflare Queues do
not share a transaction, a Queue send can fail after the `QUEUED` row commits.
The API still returns the durable submission id, while a once-per-minute Cron
Trigger scans `CREATED`, `QUEUED`, and `JUDGE_RETRY` rows whose last dispatch is
at least 30 seconds old and sends them again. Conditional execution leases make
duplicate messages harmless.

## Performance scoring

Correctness runs first, once per hidden test, in ordinal order, stopping
at the first failure. Only fully correct submissions are benchmarked:
one benchmark input, five runs, in the same sandbox instance, after the
single compilation. The score is the median CPU time (user + system,
integer nanoseconds), summed across benchmarks. Peak memory is the maximum
trusted RSS. Wall time is recorded but never scored. Queue delay, cold
start, compilation, R2, and D1 time never enter the score.

Leaderboard: accepted submissions only, best score per participant per
problem and language, lower CPU score wins, then lower peak memory, then
earlier completion. Each language receives its own rank sequence because raw
native and interpreter CPU times are not fairly comparable.
`performance_score_ns` is stored as an integer; no floating point enters
ranking math.

## Judging pipeline (per attempt)

1. Receive `submissionId` from the queue.
2. Load the submission row; skip and ACK if terminal or missing.
3. Claim the execution lease (conditional update above).
4. Read source from R2, problem/test config from D1.
5. Create a fresh sandbox (APAC, `standard-2`, no Internet).
6. Copy source in, compile once with fixed flags.
7. Run correctness tests; compare stdout to expected output Worker-side.
8. If all pass, run benchmarks x5 in the same sandbox.
9. Destroy the sandbox, commit the terminal result with the current
   execution token, then ACK.

## Verified live deployment (2026-08-28)

Deployed and proven end-to-end on the Cloudflare Workers **Paid** plan
(Containers entitlement) at `gdg-remote-runtime.srijan-guchhait.workers.dev`:

- `GET /api/v1/health` → `200 {"status":"ok"}`; seeded `problem_seed_two_sum` lists.
- `POST /api/v1/submissions` (bearer `rr_dev_participant_token_0001`, `accepted.cpp`)
  → `202 QUEUED` → poll → **`ACCEPTED`** with `performanceScoreNs=1550000`,
  `peakMemoryKb=5680`, `passedTests=3/3`.
- `compile-error.cpp` → **`COMPILE_ERROR`** (bounded g++ diagnostics, no leak).
- `infinite-loop.cpp` → **`TIME_LIMIT_EXCEEDED`** (judge-runner killed it; no hang).
- Cleanup: per-attempt sandboxes (`attempt-*`) all end `state: "inactive"`
  (`wrangler containers instances`), i.e. `sandbox.destroy()` runs; no orphan
  judge containers.

Deploy steps (run from repo root, account with Containers entitlement):

```bash
# one-time remote resources
bunx wrangler d1 migrations apply DB --remote
bunx wrangler r2 bucket create gdg-remote-runtime-artifacts
bunx wrangler queues create judge-queue
bunx wrangler queues create judge-dlq
bunx wrangler deploy   # builds + pushes the container image, deploys worker
```

> Local `wrangler dev` boots the worker (health/problems/queue wiring) but
> **cannot** run a real execution container: upstream bug
> [cloudflare/containers#231](https://github.com/cloudflare/containers/issues/231)
> (app container never created; only the `proxy-everything` sidecar). Real
> Sandbox judging requires the paid plane's Containers entitlement — see
> `.omo/notes/ulw-cloudflare-runtime.md`.

## Known limits

- Supported runtimes are C++17, C17, Python 3, and JavaScript. Compiler,
  syntax-check, interpreter, and execution flags are fixed by trusted adapters.
- The project currently uses stable Sandbox SDK 0.12.9. Keep the Worker package
  and `cloudflare/sandbox:0.12.9` image on the same release line.
- D1 processes queries serially on one database; keep writes compact and
  queries indexed (`migrations/0002_indexes.sql`).
- Perfect timing determinism is impossible on shared cloud hardware. The
  design reduces noise (one vCPU, APAC placement, five runs, median CPU
  time) but does not promise identical nanoseconds.
- Participant programs that depend on `std::random_device`, wall-clock
  time, undefined behavior, or uninitialized memory may behave
  nondeterministically; the judge does not promise determinism for them.

## Documentation

- `remote-runtime-backend-architecture.md`: components, trust boundaries,
  concurrency, storage, deployment model.
- `remote-runtime-business-logic.md`: status semantics, retry rules,
  scoring, leaderboard, admin workflows, invariants.
- `runner/` (judge lane): the trusted `judge-runner` and its driver.
