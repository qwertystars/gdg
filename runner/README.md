# Local judge driver

From the repository root, run a fixture through the local judge with:

```sh
bun runner/judge-driver.ts \
  --language cpp17 \
  --source tests/judge/fixtures/accepted.cpp \
  --input tests/judge/fixtures/input.txt \
  --expected tests/judge/fixtures/expected.txt
```

Supported language identifiers are `cpp17`, `c17`, `python3`, and
`javascript`. C and C++ are compiled with fixed optimization flags; Python and
JavaScript receive a fixed syntax-check stage before execution.

The driver compiles/checks the participant once, invokes the native
`judge-runner` supervisor for each test, and prints only the public result JSON.
The expected output and participant stdout stay out of that serialization.
`judge-runner` creates a process group, enforces wall/CPU/memory/process/output
limits, records trusted metrics, and kills the complete group before returning.
Native programs also receive an address-space limit. Managed runtimes use
cgroup/aggregate-RSS memory accounting because their virtual address-space
reservation is not equivalent to resident memory.
