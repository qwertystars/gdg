import type { OutputComparator } from "./types";

function normalize(output: string): string {
  return output
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "");
}

/** Trusted-side default comparator. Expected output is never sent to a sandbox. */
export class WhitespaceInsensitiveComparator implements OutputComparator {
  compare(actual: string, expected: string): boolean {
    return normalize(actual) === normalize(expected);
  }
}

export function compareOutput(actual: string, expected: string): boolean {
  return new WhitespaceInsensitiveComparator().compare(actual, expected);
}
