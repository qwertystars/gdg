#!/usr/bin/env node
// Minimal JSONC validator for wrangler.jsonc.
//
// Wrangler itself is the real validator, but it is not installed in this
// workspace (no package.json yet, and it would be a heavyweight dependency).
// This script strips // and /* */ comments plus trailing commas, then parses
// the result as JSON, so a syntax error here means wrangler would reject the
// file too. It intentionally does not interpret Cloudflare-specific fields.
//
// Usage:
//   bun scripts/check-wrangler-jsonc.ts            (checks wrangler.jsonc)
//   bun scripts/check-wrangler-jsonc.ts <path>

import { readFileSync } from "node:fs";

const target = process.argv[2] ?? "wrangler.jsonc";

function stripJsonc(input: string) {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    const next = input[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  // Remove trailing commas before ] or }.
  return out.replace(/,\s*([}\]])/g, "$1");
}

try {
  const raw = readFileSync(target, "utf8");
  const cleaned = stripJsonc(raw);
  JSON.parse(cleaned);
  console.log(`OK: ${target} parses as JSON after JSONC stripping.`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`FAIL: ${target} is not valid JSONC:`, message);
  process.exit(1);
}
