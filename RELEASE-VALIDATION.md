# Release validation

Validated on 2026-08-29 for the stacked change set ending at PR #6.

| Requirement | Evidence |
|---|---|
| Compile/run participant code | Local and Cloudflare accepted scenarios for all four runtimes |
| Deterministic correctness | Immutable problem v2, SHA-256 verified source/tests, pinned toolchain and normalized comparator |
| Trusted efficiency metrics | Native supervisor CPU/RSS metrics; API/Queue/compile/cold-start time excluded from scores |
| Preemption and retries | D1 conditional lease/token commits, Queue retries, stale-result tests, recovery Cron |
| Infinite loops | Local and Cloudflare `TIME_LIMIT_EXCEEDED` |
| Memory overflow/leaks | Aggregate RSS/cgroup or RLIMIT fallback; local and Cloudflare `MEMORY_LIMIT_EXCEEDED` |
| Output flooding | Supervisor-controlled cap; local and Cloudflare `OUTPUT_LIMIT_EXCEEDED`, no crash report |
| Process escape/fork accounting | Process group, subreaper, cgroup kill, descendant CPU test, process cap |
| Compiler abuse | Compile/check stage uses the same privilege-dropping supervisor and bounded diagnostics |
| Multi-language | C++17, C17, Python 3, JavaScript; independent leaderboard ranks per language |
| Scalability/cost | Queue concurrency and container instance caps aligned at 10; D1 indexed; containers sleep after one minute |
| Reproducibility | Exact SDK/base digest, migrations, Dockerfile, local and cloud benchmark commands |
| Security | Minimal environment, no participant command interpolation, no-new-privileges, core/fd/process/resource limits |

Final gates:

```bash
bun test
bun run typecheck
bun run lint
bunx wrangler d1 migrations apply DB --local --persist-to <fresh-directory>
bunx wrangler deploy --dry-run --outdir <temporary-directory>
bun run benchmark:local -- --repeats 5 --concurrency 2
bun run benchmark:cloudflare -- --adversarial
```

The remote baseline and exact deployment identifiers are recorded in
`BENCHMARKS.md`. Credentials are intentionally excluded from reports and git.
