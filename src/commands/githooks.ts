import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "../args.js";
import { evaluate, type NoulAnswer, type ScoreAnswer } from "../client.js";
import { resolveThresholds } from "../config.js";
import { AxiError, validation } from "../errors.js";
import { loadDiff, parseDiff, runGit, scanAddedLines, type FileDiff } from "../git.js";
import { COMMIT_QUESTIONS, COMMIT_THRESHOLDS } from "../recipes/questions.js";
import { redactSecrets } from "../safety.js";
import { renderWithHelp, type Renderable } from "./common.js";
import { reviewFiles } from "./diff.js";

export const GIT_HOOKS_HELP = `git hooks (install: jev-axi setup git-hooks):
  pre-commit           scans added lines for credentials locally (blocks; nothing is sent), then reviews the staged
                       diff with Jev, credentials redacted: risk, missing tests, debug leftovers (warns)
    --block-on <what>  secrets (default): block only on local credential matches; flags: also block on any Jev flag;
                       none: never block
  commit-msg <file>    checks the message describes the staged diff, and follows Conventional Commits when the
                       repo's history does (warns)
    --strict           block when the message does not describe the diff
  Both skip quietly when there is no API key or the API is unreachable. Bypass once with git commit --no-verify.`;

/** Diffs with more files than this are not sent for review (bulk renames, vendored code, merges). */
const MAX_REVIEW_FILES = 60;
const GIT_HOOK_TIMEOUT_MS = 20_000;
const CONVENTIONAL = /^(feat|fix|docs|refactor|test|chore|build|ci|perf|style|revert)(\([^)]*\))?!?: \S/;

/** Failures in a hook must never block a commit, except the checks the user asked to block on. */
function skipped(what: string, error: unknown): string {
  const e = error as AxiError;
  if (e?.code === "AUTH_REQUIRED") return `jev-axi: no API key, skipped ${what}`;
  return `jev-axi: ${what} unavailable (${(e as Error)?.message ?? String(error)}), skipped`;
}

export async function preCommitHook(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--block-on": "value" }, "hook pre-commit");
  const blockOn = p.values["--block-on"] ?? "secrets";
  if (!["secrets", "flags", "none"].includes(blockOn)) throw validation("--block-on must be secrets, flags, or none");
  let files: FileDiff[];
  try {
    files = parseDiff(loadDiff({ staged: true }).text);
  } catch {
    return "";
  }
  if (files.length === 0) return "";

  const secrets = scanAddedLines(files);
  if (secrets.length && blockOn !== "none") {
    process.exitCode = 1;
    return renderWithHelp({
      jev_axi_pre_commit: "blocked: staged changes add credentials",
      secrets,
      help: ["Remove the credential (load it from the environment or a secret store), then commit again", "If it is a deliberate test fixture, bypass once with `git commit --no-verify`"],
    });
  }
  if (files.length > MAX_REVIEW_FILES) return `jev-axi: ${files.length} staged files, skipped diff review (limit ${MAX_REVIEW_FILES})`;

  let review;
  try {
    review = await reviewFiles(files, { command: "git-hook", timeoutMs: GIT_HOOK_TIMEOUT_MS, maxRetries: 0 }, resolveThresholds({}));
  } catch (error) {
    return skipped("diff review", error);
  }
  const kind = review.overall.kind?.choice ?? "unknown";
  if (review.flagged.length === 0 && !secrets.length) return `jev-axi: staged diff looks ok (${files.length} files, ${kind})`;
  const block = blockOn === "flags";
  if (block) process.exitCode = 1;
  const help: string[] = [];
  if (review.flagged.some((v) => v.flags.includes("secrets"))) help.push("secrets: a file may add a credential; check it before pushing");
  if (review.flagged.some((v) => v.flags.includes("possible-secret"))) help.push("possible-secret: an added line looks like a credential (auth header, URL password, or PASSWORD=/TOKEN= value); check it before pushing");
  if (review.flagged.some((v) => v.flags.includes("leftovers"))) help.push("leftovers: debug output, commented-out code, or TODO markers");
  if (review.flagged.some((v) => v.flags.includes("needs-test"))) help.push("needs-test: behavior changed with no test change");
  if (review.scopeLevel === 2) help.push("The staged changes look like several unrelated changes; consider separate commits");
  help.push(block ? "Fix the flagged files, or bypass once with `git commit --no-verify`" : "Warnings only; the commit continues");
  return renderWithHelp({
    jev_axi_pre_commit: `${block ? "blocked" : "warning"}: ${review.flagged.length} of ${files.length} staged files flagged (${kind})`,
    ...(secrets.length ? { secrets } : {}),
    files: review.flagged.map((v) => ({ file: v.file, risk: v.risk, flags: v.flags })),
    help,
  });
}

/** Subject and body from a commit message file, without comments or the verbose diff. */
export function parseCommitMessage(raw: string): { subject: string; body: string } {
  const text = raw.split(/^# -+ >8 -+$/m)[0]!;
  const lines = text.split(/\r?\n/).filter((l) => !l.startsWith("#"));
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first === -1) return { subject: "", body: "" };
  return { subject: lines[first]!.trim(), body: lines.slice(first + 1).join("\n").trim() };
}

export async function commitMsgHook(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--strict": "bool" }, "hook commit-msg");
  const file = p.positional[0];
  if (!file) throw validation("hook commit-msg needs the message file git passes as $1");
  const { subject, body } = parseCommitMessage(readFileSync(file, "utf8"));
  if (!subject || /^(Merge |Revert "|fixup! |squash! |amend! )/.test(subject)) return "";
  let diff: string;
  try {
    diff = loadDiff({ staged: true }).text;
  } catch {
    return "";
  }
  if (diff.trim() === "") return "";
  diff = redactSecrets(diff);
  if (diff.length > COMMIT_THRESHOLDS.diffChars) diff = `${diff.slice(0, COMMIT_THRESHOLDS.diffChars)}\n... (truncated, ${diff.length} chars total)`;

  let answers;
  try {
    answers = (await evaluate({ subject, body, diff }, COMMIT_QUESTIONS, { command: "git-hook", timeoutMs: GIT_HOOK_TIMEOUT_MS, maxRetries: 0 })).answers;
  } catch (error) {
    return skipped("commit message check", error);
  }
  const describes = (answers["describes_diff"] as NoulAnswer).noul;
  const quality = (answers["subject_quality"] as ScoreAnswer).score;
  const issues: string[] = [];
  const help: string[] = [];
  if (describes < COMMIT_THRESHOLDS.pass) {
    issues.push("message-mismatch");
    help.push("The message does not seem to describe the staged diff's main change");
  }
  if (quality < 1) {
    issues.push("vague-subject");
    help.push("Say what changed and where, e.g. `fix(auth): refresh expired tokens before retrying`");
  }
  if (repoUsesConventionalCommits() && !CONVENTIONAL.test(subject)) {
    issues.push("not-conventional");
    help.push("This repo's history uses Conventional Commits: type(scope): description");
  }
  if (issues.length === 0) return "";
  const block = p.bools["--strict"] && issues.includes("message-mismatch");
  if (block) process.exitCode = 1;
  help.push(block ? "Reword the message, or bypass once with `git commit --no-verify`" : "Warnings only; the commit continues (reword later with `git commit --amend`)");
  return renderWithHelp({
    jev_axi_commit_msg: `${block ? "blocked" : "warning"}: ${issues.join(", ")}`,
    subject,
    matches_diff: Math.round(describes * 100) / 100,
    help,
  });
}

/** True when at least half of the last 20 commit subjects follow Conventional Commits. */
function repoUsesConventionalCommits(): boolean {
  try {
    const subjects = runGit(["log", "-20", "--format=%s"]).split("\n").filter(Boolean);
    return subjects.length >= 3 && subjects.filter((s) => CONVENTIONAL.test(s)).length * 2 >= subjects.length;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ installation

const MARKER = "# installed by jev-axi setup git-hooks";

const HOOK_SCRIPTS: Record<string, string> = {
  "pre-commit": `#!/bin/sh
${MARKER}; remove with: jev-axi setup git-hooks --remove
command -v jev-axi >/dev/null 2>&1 || exit 0
exec jev-axi hook pre-commit
`,
  "commit-msg": `#!/bin/sh
${MARKER}; remove with: jev-axi setup git-hooks --remove
command -v jev-axi >/dev/null 2>&1 || exit 0
exec jev-axi hook commit-msg "$1"
`,
};

export interface GitHookStatus {
  hook: string;
  status: string;
}

/** Install or remove the pre-commit and commit-msg hooks in the current repository. */
export function configureGitHooks(remove: boolean): { dir: string; hooks: GitHookStatus[]; help: string[] } {
  let hooksPath: string;
  try {
    hooksPath = runGit(["rev-parse", "--git-path", "hooks"]).trim();
  } catch {
    throw validation("not inside a git repository", ["Run `jev-axi setup git-hooks` from the repository you want to protect"]);
  }
  const dir = isAbsolute(hooksPath) ? hooksPath : join(process.cwd(), hooksPath);
  let custom = "";
  try {
    custom = runGit(["config", "--get", "core.hooksPath"]).trim();
  } catch {
    // unset
  }
  if (custom && !remove) {
    return {
      dir,
      hooks: Object.keys(HOOK_SCRIPTS).map((hook) => ({ hook, status: "not installed: core.hooksPath is managed by another tool" })),
      help: [
        `core.hooksPath is set to ${custom} (husky, lefthook, or similar); add these to that tool's hooks instead:`,
        "pre-commit: if command -v jev-axi >/dev/null 2>&1; then jev-axi hook pre-commit || exit 1; fi",
        'commit-msg: if command -v jev-axi >/dev/null 2>&1; then jev-axi hook commit-msg "$1" || exit 1; fi',
      ],
    };
  }
  const hooks: GitHookStatus[] = [];
  const help: string[] = [];
  for (const [hook, script] of Object.entries(HOOK_SCRIPTS)) {
    const file = join(dir, hook);
    const exists = existsSync(file);
    const ours = exists && readFileSync(file, "utf8").includes(MARKER);
    if (remove) {
      if (ours) rmSync(file);
      hooks.push({ hook, status: ours ? "removed" : exists ? "not ours, left untouched" : "not installed (no-op)" });
      continue;
    }
    if (exists && !ours) {
      hooks.push({ hook, status: "a different hook exists; left untouched" });
      help.push(`To chain it, add to ${file}: ${hook === "pre-commit" ? "jev-axi hook pre-commit || exit 1" : 'jev-axi hook commit-msg "$1"'}`);
      continue;
    }
    if (ours && readFileSync(file, "utf8") === script) {
      hooks.push({ hook, status: "already installed (no-op)" });
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    hooks.push({ hook, status: ours ? "updated" : "installed" });
  }
  if (!remove && hooks.some((h) => /installed|updated/.test(h.status))) {
    help.push("pre-commit blocks only on credentials found locally; Jev review of the staged diff (credentials redacted) only warns");
    help.push("Change behavior by editing the hook: `jev-axi hook pre-commit --block-on flags`, `jev-axi hook commit-msg \"$1\" --strict`");
  }
  return { dir, hooks, help };
}
