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
  --base-url https://gdg-remote-runtime.example.workers.dev \
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
