import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { AxiError, validation } from "./errors.js";
import { findPossibleSecrets, findStrongSecrets } from "./safety.js";

export function runGit(args: string[], cwd = process.cwd()): string {
  const r = spawnSync("git", ["--no-pager", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    throw new AxiError(`git is not available: ${r.error.message}`, "NOT_FOUND", ["Install git or pass the diff with --file <patch>"]);
  }
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim().split("\n")[0] ?? "git failed";
    throw new AxiError(`git ${args[0]} failed: ${msg}`, "VALIDATION_ERROR", ["Run inside a git repository, or pass --file <patch>"]);
  }
  return r.stdout;
}

export interface DiffSource {
  staged?: boolean;
  range?: string;
  file?: string;
  stdin?: string;
}

/** Unified diff text from the working tree, index, a commit range, a patch file, or stdin. */
export function loadDiff(src: DiffSource): { text: string; label: string } {
  if (src.stdin !== undefined) return { text: src.stdin, label: "stdin" };
  if (src.file !== undefined) {
    if (!existsSync(src.file)) throw validation(`patch file not found: ${src.file}`);
    return { text: readFileSync(src.file, "utf8"), label: src.file };
  }
  const args = ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
  if (src.range) args.push(src.range);
  else if (src.staged) args.push("--cached");
  const text = runGit(args);
  const label = src.range ?? (src.staged ? "staged changes" : "working tree changes");
  return { text, label };
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|rs)$|Test\.(java|kt|cs)$/.test(path);
}

/** File name without directories, extension, or test markers: src/math.ts and test/math.test.ts both give "math". */
export function testStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "").replace(/(\.(test|spec)|_test|Test|_spec)$/, "").replace(/^test_/, "").toLowerCase();
}

export interface FileDiff {
  path: string;
  patch: string;
  added: number;
  removed: number;
}

/** Split a unified diff into per-file patches with line counts. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const blocks = text.split(/^(?=diff --git )/m).filter((b) => b.trim() !== "");
  for (const block of blocks) {
    // Prefixes are usually a/ and b/, but diff.mnemonicPrefix and --src/dst-prefix change them.
    const header = /^diff --git \S+?\/(.+?) \S+?\/(.+)$/m.exec(block);
    const plus = /^\+\+\+ (.+)$/m.exec(block)?.[1];
    const minus = /^--- (.+)$/m.exec(block)?.[1];
    const strip = (s: string) => s.replace(/^[^/]+\//, "");
    const path = plus && plus !== "/dev/null" ? strip(plus) : minus && minus !== "/dev/null" ? strip(minus) : header ? header[2]! : "unknown";
    let added = 0;
    let removed = 0;
    for (const line of block.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    files.push({ path, patch: block, added, removed });
  }
  return files;
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
  diff: string;
}

/** Commits in a range (default the last one), newest first, each with its diff. */
export function loadCommits(range?: string, limit = 20): Commit[] {
  const spec = range ?? "HEAD~1..HEAD";
  const shas = runGit(["rev-list", "--max-count", String(limit), spec]).trim().split("\n").filter(Boolean);
  if (shas.length === 0 && !range) {
    // Root commit or a repo with a single commit.
    const head = runGit(["rev-parse", "--verify", "HEAD"]).trim();
    shas.push(head);
  }
  return shas.map((sha) => {
    const subject = runGit(["log", "-1", "--format=%s", sha]).trim();
    const body = runGit(["log", "-1", "--format=%b", sha]).trim();
    const diff = runGit(["show", "--no-color", "--no-ext-diff", "--format=", sha]);
    return { sha: sha.slice(0, 10), subject, body, diff };
  });
}

export interface SecretHit {
  file: string;
  line: number;
  kind: string;
}

/** Strong credential patterns on added lines, with new-file line numbers. Runs locally only. */
export function scanAddedLines(files: FileDiff[]): SecretHit[] {
  return scanAdded(files, findStrongSecrets);
}

/**
 * Looser credential shapes on added lines (auth headers, URL passwords, `PASSWORD=` assignments).
 * They are redacted before sending, so this local pass is the only thing that can report them.
 */
export function scanPossibleSecrets(files: FileDiff[]): SecretHit[] {
  return scanAdded(files, findPossibleSecrets);
}

function scanAdded(files: FileDiff[], find: (text: string) => string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const f of files) {
    let line = 0;
    const lines = f.patch.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) {
        line = Number(hunk[1]);
        continue;
      }
      if (text.startsWith("+++") || text.startsWith("---")) continue;
      if (text.startsWith("+")) {
        // Private keys span lines: test the added block that starts here.
        const block = text.includes("-----BEGIN") ? lines.slice(i, i + 80).filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n") : text.slice(1);
        for (const kind of find(block)) hits.push({ file: f.path, line, kind });
        line++;
      } else if (text.startsWith(" ")) line++;
    }
  }
  return hits;
}
