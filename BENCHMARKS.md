# Benchmarking

The repository includes two reproducible benchmark surfaces. Reports use
integer nanoseconds for trusted CPU scores and never derive efficiency from API
latency, compilation time, Queue delay, or container cold start.

## Local engine and disruption suite

```bash
bun run benchmark:local -- --repeats 5 --concurrency 2 \
  --output benchmark-results/local.json
```

This runs accepted C++17, C17, Python 3, and JavaScript submissions plus compile
failure, wrong answer, infinite loop, memory overflow, and output flood cases.
It asserts every verdict, checks cleanup evidence, and summarizes CPU-score,
peak-RSS, and end-to-end variability. End-to-end time is operational telemetry,
not a leaderboard input.

## Cloudflare end-to-end suite

```bash
BENCHMARK_TOKEN='participant token' bun run benchmark:cloudflare -- \
  --base-url https://gdg.qwertystars.org \
  --adversarial \
  --output benchmark-results/cloudflare.json
```

The remote harness checks health, submits all supported languages, optionally
adds the five disruption cases, respects the configured submission rate limit,
polls each durable submission to a terminal state, and records submission API
latency, Queue-plus-judge duration, score, and peak memory. The token is read
from the environment or `--token` and is never serialized.

Useful controls:

- `--batch-size 5` and `--batch-pause-ms 11000` respect the default rate limit.
- `--timeout-ms 900000` accommodates a first container image cold start.
- `--poll-ms 2000` changes read-side polling without affecting judge metrics.
- `--problem-id` selects a different active, versioned problem.

## Interpretation

Compare scores only within the same problem version, language, compiler image,
runner image, and Cloudflare placement policy. The leaderboard already assigns
independent ranks per language. Shared-cloud CPU timing is not bit-for-bit
deterministic; five recorded runs after one warm-up and the median reduce noise.
For event calibration, run the suite repeatedly immediately before the contest
and retain the JSON reports with the deployed git SHA and image digest.

## Recorded local baseline

On 2026-08-29, commit `4532636` was exercised on an AMD Ryzen 9 5900HX
(16 logical CPUs), Linux 7.1.9, Bun 1.3.14, with five accepted trials per
language and concurrency two. All 25 verdict and cleanup assertions passed in
20.87 seconds; no coredump or lingering process was observed.

| Language | Median score | Score CV | Median peak RSS |
|---|---:|---:|---:|
| C++17 | 1,153,000 ns | 7.76% | 4,420 KiB |
| C17 | 600,000 ns | 6.63% | 4,420 KiB |
| Python 3 | 10,708,000 ns | 1.36% | 17,140 KiB |
| JavaScript | 21,306,000 ns | 0.93% | 49,772 KiB |

These numbers are a development-host baseline, not a cross-language ranking.
The native micro-benchmark is so short that scheduler noise is a large fraction
of its score; contest benchmark inputs should target longer steady-state CPU
work while staying comfortably below the time limit.

## Recorded Cloudflare baseline

On 2026-08-29, active problem version 2 was tested through the deployed Worker,
D1, R2, Queue, recovery Cron, and `standard-2` APAC container. Deployment
`33ab93d6-82d1-4f92-af2a-2035b5347439` used container digest
`sha256:2bad33ba9803e26257984e72602a195232bd381ff92bda8589decf3a03ab24ad`.
All 9/9 assertions passed.

| Scenario | Verdict | Score / peak RSS | Client-observed completion |
|---|---|---:|---:|
| C++17 accepted | `ACCEPTED` | 1,683,000 ns / 3,520 KiB | 83.36 s |
| C17 accepted | `ACCEPTED` | 1,173,000 ns / 2,012 KiB | 73.93 s |
| Python 3 accepted | `ACCEPTED` | 13,353,000 ns / 8,684 KiB | 25.87 s |
| JavaScript accepted | `ACCEPTED` | 28,366,000 ns / 44,388 KiB | 83.05 s |
| compile error | `COMPILE_ERROR` | — | 59.88 s |
| wrong answer | `WRONG_ANSWER` | — | 33.01 s |
| infinite loop | `TIME_LIMIT_EXCEEDED` | 1,916 KiB | 37.72 s |
| memory overflow | `MEMORY_LIMIT_EXCEEDED` | 263,788 KiB | 23.88 s |
| output flood | `OUTPUT_LIMIT_EXCEEDED` | 3,220 KiB | 46.97 s |

Queue-plus-judge durations include cold starts and concurrent queueing, so they
are capacity telemetry only. They never enter the participant score.
