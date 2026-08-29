# Local judge driver

From the repository root, run one C++17 fixture through the local judge with:

```sh
bun runner/judge-driver.ts \
  --source tests/judge/fixtures/accepted.cpp \
  --input tests/judge/fixtures/input.txt \
  --expected tests/judge/fixtures/expected.txt
```

The driver compiles the participant once, invokes the native `judge-runner` supervisor for each test, and prints only the public result JSON. The expected output and participant stdout stay out of that serialization. `judge-runner` creates a process group, enforces wall/CPU/address-space/process/output limits, records trusted metrics, and kills the complete group before returning.
