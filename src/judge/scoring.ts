import type { BenchmarkResult } from "./types";

export function medianInteger(values: number[]): number {
  if (values.length === 0) throw new Error("median requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function scoreBenchmarks(benchmarks: BenchmarkResult[]): number {
  return benchmarks.reduce((sum, benchmark) => sum + benchmark.medianCpuTimeNs, 0);
}
