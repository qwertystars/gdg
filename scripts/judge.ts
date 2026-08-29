#!/usr/bin/env node

// Judge CLI help surface for the Remote Runtime MVP.
//
// Entry point:  bun run judge [--help] [--version]
// Package hook: package.json -> "judge": "bun run scripts/judge.ts"
// Direct run:   bun scripts/judge.ts --help   (works before package.json exists)
//
// This script only reports usage. It does not import the judge engine, so it
// never starts a long-lived process and needs no compiled artifacts. The
// actual local judging pipeline lives in src/judge/ (the judge lane) and the
// real commands for it are documented in README.md, "Running the judge".

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const USAGE = `gdg-remote-runtime judge CLI

Usage:
  bun run judge --help
  bun run judge --version

Options:
  -h, --help     Show this help text and exit.
  -v, --version  Print the project version from package.json and exit.

About:
  The Remote Runtime judges C++17, C17, Python 3, and JavaScript submissions
  in isolated Cloudflare Sandboxes. The Cloudflare path is: API worker enqueues a submissionId,
  the judge consumer claims an execution lease in D1, compiles once,
  runs correctness tests, then benchmarks accepted submissions with five
  repeated runs and a median CPU-time score.

  The local MVP path swaps Cloudflare bindings for local adapters behind
  the same domain interfaces. See README.md, "Local vs Cloudflare".

  This help command exits immediately. It does not start the judge
  consumer, a sandbox, or any long-lived process.

Run the local judge engine (the judge lane's driver):
  bun run judge:local -- \
    --language cpp17 \
    --source scripts/fixtures/demo/sources/accepted.cpp \
    --input scripts/fixtures/demo/tests/001.in \
    --expected scripts/fixtures/demo/tests/001.out
`;

function projectVersion() {
  try {
    const raw = readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(projectVersion());
    process.exit(0);
  }
  console.error(`Unknown argument(s): ${args.join(" ")}`);
  console.error("Run 'bun run judge --help' for usage.");
  process.exit(2);
}

main();
