import type { SubmissionLanguage } from "../domain/enums";

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface LanguageDefinition {
  id: SubmissionLanguage;
  label: string;
  sourceFile: string;
  /** Native programs can use RLIMIT_AS; managed runtimes need RSS/cgroup limits because they reserve large virtual ranges. */
  memoryAccounting: "address-space" | "rss";
  compile(sourcePath: string, outputPath: string): CommandSpec;
  execute(sourcePath: string, outputPath: string): CommandSpec;
}

const LANGUAGES: Readonly<Record<SubmissionLanguage, LanguageDefinition>> = {
  cpp17: {
    id: "cpp17",
    label: "C++ 17",
    sourceFile: "source.cpp",
    memoryAccounting: "address-space",
    compile: (sourcePath, outputPath) => ({
      command: "g++",
      args: ["-std=c++17", "-O2", "-pipe", sourcePath, "-o", outputPath],
    }),
    execute: (_sourcePath, outputPath) => ({ command: outputPath, args: [] }),
  },
  c17: {
    id: "c17",
    label: "C 17",
    sourceFile: "source.c",
    memoryAccounting: "address-space",
    compile: (sourcePath, outputPath) => ({
      command: "gcc",
      args: ["-std=c17", "-O2", "-pipe", sourcePath, "-o", outputPath],
    }),
    execute: (_sourcePath, outputPath) => ({ command: outputPath, args: [] }),
  },
  python3: {
    id: "python3",
    label: "Python 3",
    sourceFile: "source.py",
    memoryAccounting: "rss",
    compile: (sourcePath) => ({ command: "python3", args: ["-m", "py_compile", sourcePath] }),
    execute: (sourcePath) => ({ command: "python3", args: ["-I", "-B", sourcePath] }),
  },
  javascript: {
    id: "javascript",
    label: "JavaScript (Node.js)",
    sourceFile: "source.cjs",
    memoryAccounting: "rss",
    compile: (sourcePath) => ({ command: "node", args: ["--check", sourcePath] }),
    execute: (sourcePath) => ({
      command: "node",
      args: ["--disable-proto=delete", "--no-addons", sourcePath],
    }),
  },
};

export const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(LANGUAGES) as SubmissionLanguage[]);

export function isSubmissionLanguage(value: string): value is SubmissionLanguage {
  return Object.hasOwn(LANGUAGES, value);
}

export function languageDefinition(language: SubmissionLanguage): LanguageDefinition {
  return LANGUAGES[language];
}
