import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isStdinTTY, readStdinSync } from "../stdin.js";
import { parseArgs } from "../args.js";
import { evaluate, type NoulAnswer, type ScoreAnswer } from "../client.js";
import { ensureDir, paths, resolveThresholds } from "../config.js";
import { AxiError, validation } from "../errors.js";
import { loadDiff, parseDiff, runGit, scanAddedLines, type FileDiff } from "../git.js";
import { COMMIT_QUESTIONS, COMMIT_THRESHOLDS, PUSH_QUESTIONS, PUSH_THRESHOLDS } from "../recipes/questions.js";
import { redactSecrets } from "../safety.js";
import { finish, renderWithHelp, type Renderable } from "./common.js";
import { reviewFiles } from "./diff.js";

export const GIT_HOOKS_HELP = `git hooks (install: jev-axi setup git-hooks):
  pre-commit           scans added lines for credentials locally (blocks; nothing is sent), then reviews the staged
                       diff with Jev, credentials redacted: risk, missing tests, debug leftovers (warns)
    --block-on <what>  secrets (default): block only on local credential matches; flags: also block on any Jev flag;
                       none: never block
  commit-msg <file>    checks the message describes the staged diff, and follows Conventional Commits when the
                       repo's history does (warns)
    --strict           block when the message does not describe the diff
  pre-push             judges everything the push would send, as one range: schema change with no rollback note,
                       auth/crypto/permission changes, hand-edited generated files, work-in-progress leftovers (warns)
    --block-on <what>  none (default): never block; flags: block when a concern is strong
    --range <a..b>     judge this range instead of reading git's ref updates on stdin
    --file <patch>     judge a patch file instead (no commit subjects are available)
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

const ZERO_SHA = /^0{40,}$/;

export interface PushUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** Parse the `<local ref> <local sha> <remote ref> <remote sha>` lines git sends a pre-push hook. */
export function parsePushUpdates(stdin: string): PushUpdate[] {
  const updates: PushUpdate[] = [];
  for (const line of stdin.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts as [string, string, string, string];
    // A deletion has an all-zero local sha: there is nothing to judge.
    if (ZERO_SHA.test(localSha)) continue;
    updates.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return updates;
}

/**
 * The commits a push would actually send. When the remote already has the branch this is
 * `remote..local`; for a new branch there is no remote side, so it is everything on the branch
 * that no remote already has.
 */
export function pushRange(u: PushUpdate): { commits: string[]; diffArgs: string[] } | undefined {
  try {
    const revs = ZERO_SHA.test(u.remoteSha)
      ? ["rev-list", "--max-count", String(PUSH_THRESHOLDS.maxCommits + 1), u.localSha, "--not", "--remotes"]
      : ["rev-list", "--max-count", String(PUSH_THRESHOLDS.maxCommits + 1), `${u.remoteSha}..${u.localSha}`];
    const commits = runGit(revs).trim().split("\n").filter(Boolean);
    if (commits.length === 0) return undefined;
    if (ZERO_SHA.test(u.remoteSha)) {
      const oldest = commits[commits.length - 1]!;
      // `oldest^` does not exist for a root commit; diff against the empty tree instead.
      let base: string;
      try {
        base = runGit(["rev-parse", "--verify", `${oldest}^`]).trim();
      } catch {
        base = runGit(["hash-object", "-t", "tree", "/dev/null"]).trim();
      }
      return { commits, diffArgs: [base, u.localSha] };
    }
    return { commits, diffArgs: [u.remoteSha, u.localSha] };
  } catch {
    return undefined;
  }
}

/** Ranges already warned about, so re-pushing the same commits stays quiet. */
function seenFile(): string {
  return join(paths.statsDir(), "push-seen.json");
}

/** Exported for tests. */
export function pushAlreadyWarned(key: string): boolean {
  try {
    const seen = JSON.parse(readFileSync(seenFile(), "utf8")) as Record<string, number>;
    return typeof seen[key] === "number";
  } catch {
    return false;
  }
}

/** Exported for tests. */
export function pushRecordWarned(key: string): void {
  let seen: Record<string, number> = {};
  try {
    seen = JSON.parse(readFileSync(seenFile(), "utf8")) as Record<string, number>;
  } catch {
    // first write
  }
  seen[key] = Date.now();
  // Keep the file small: drop anything older than 30 days.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [k, at] of Object.entries(seen)) if (at < cutoff) delete seen[k];
  try {
    ensureDir(paths.statsDir());
    writeFileSync(seenFile(), JSON.stringify(seen));
  } catch {
    // a hook must not fail because state could not be written
  }
}

type PushConcernId = "migration_without_note" | "sensitive_area" | "generated_by_hand" | "unreviewed_leftovers";

const PUSH_CONCERNS: Array<{ id: PushConcernId; label: string; help: string }> = [
  { id: "migration_without_note", label: "migration-without-note", help: "migration-without-note: a schema or data-format change with no rollback or deploy note in the commits" },
  { id: "sensitive_area", label: "sensitive-area", help: "sensitive-area: this range changes auth, permissions, crypto, or credential handling; worth a second reader" },
  { id: "generated_by_hand", label: "generated-by-hand", help: "generated-by-hand: files a build normally produces look hand-edited; regenerate them instead" },
  { id: "unreviewed_leftovers", label: "leftovers", help: "leftovers: debug output, commented-out code, TODO markers, or skipped tests are still in the added lines" },
];

export async function prePushHook(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--block-on": "value", "--range": "value", "--file": "value" }, "hook pre-push");
  const blockOn = p.values["--block-on"] ?? "none";
  if (!["flags", "none"].includes(blockOn)) throw validation("--block-on must be flags or none");

  let diffArgs: string[];
  let commits: string[];
  let key: string;
  let branch: string;
  const range = p.values["--range"];
  const patchFile = p.values["--file"];
  if (patchFile) {
    // A patch on disk has no commit history to read; the questions fall back to the diff alone.
    diffArgs = [];
    commits = [];
    branch = patchFile;
    key = "";
  } else if (range) {
    diffArgs = [range];
    try {
      commits = runGit(["rev-list", "--max-count", String(PUSH_THRESHOLDS.maxCommits + 1), range]).trim().split("\n").filter(Boolean);
    } catch {
      return "";
    }
    if (commits.length === 0) return "";
    branch = range;
    key = "";
  } else {
    if (isStdinTTY()) throw validation("hook pre-push reads git's ref updates on stdin", ["Pass --range <a..b> to check a range by hand"]);
    const updates = parsePushUpdates(readStdinSync());
    if (updates.length === 0) return "";
    // Judge the largest update; a push of several branches at once is rare and one report is enough.
    let chosen: { u: PushUpdate; r: NonNullable<ReturnType<typeof pushRange>> } | undefined;
    for (const u of updates) {
      const r = pushRange(u);
      if (r && (!chosen || r.commits.length > chosen.r.commits.length)) chosen = { u, r };
    }
    if (!chosen) return "";
    diffArgs = chosen.r.diffArgs;
    commits = chosen.r.commits;
    branch = chosen.u.remoteRef.replace(/^refs\/heads\//, "");
    let root = "";
    try {
      root = runGit(["rev-parse", "--show-toplevel"]).trim();
    } catch {
      root = process.cwd();
    }
    key = `${root}#${chosen.u.remoteRef}#${chosen.u.localSha}`;
    if (pushAlreadyWarned(key)) return "";
  }

  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (commits.length > PUSH_THRESHOLDS.maxCommits) return `jev-axi: ${plural(commits.length, "commit")} to push, skipped review (limit ${PUSH_THRESHOLDS.maxCommits})`;

  let files: FileDiff[];
  let diff: string;
  try {
    diff = patchFile ? loadDiff({ file: patchFile }).text : runGit(["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", ...diffArgs]);
    files = parseDiff(diff);
  } catch (error) {
    if (patchFile) throw error;
    return "";
  }
  if (files.length === 0) return "";
  if (files.length > PUSH_THRESHOLDS.maxFiles) return `jev-axi: ${plural(files.length, "file")} in the push, skipped review (limit ${PUSH_THRESHOLDS.maxFiles})`;

  diff = redactSecrets(diff);
  if (diff.length > PUSH_THRESHOLDS.diffChars) diff = `${diff.slice(0, PUSH_THRESHOLDS.diffChars)}\n... (truncated, ${diff.length} chars total)`;
  const subjects = patchFile
    ? []
    : commits.map((sha) => {
        try {
          return runGit(["log", "-1", "--format=%s", sha]).trim();
        } catch {
          return sha;
        }
      });

  let result;
  try {
    result = await evaluate(
      { branch, commits: subjects, files: files.map((f) => `${f.path} +${f.added}/-${f.removed}`), diff },
      PUSH_QUESTIONS,
      { command: "git-hook", timeoutMs: GIT_HOOK_TIMEOUT_MS, maxRetries: 0 },
    );
  } catch (error) {
    return skipped("pre-push review", error);
  }

  const scored = PUSH_CONCERNS.map((c) => ({ ...c, p: (result.answers[c.id] as NoulAnswer).noul }));
  const raised = scored.filter((c) => c.p >= PUSH_THRESHOLDS.warn);
  if (key) pushRecordWarned(key);
  const scale = patchFile ? plural(files.length, "file") : `${plural(commits.length, "commit")}, ${plural(files.length, "file")}`;
  const json = p.bools["--json"];
  // A hook should stay quiet when it has nothing to say; --json always reports every score.
  if (raised.length === 0 && !json) return `jev-axi: ${scale}, nothing flagged`;

  const block = blockOn === "flags" && raised.some((c) => c.p >= PUSH_THRESHOLDS.block);
  if (block) process.exitCode = 1;
  const help = raised.map((c) => c.help);
  if (raised.length) help.push(block ? "Fix these, or bypass once with `git push --no-verify`" : "Warnings only; the push continues");
  if (key) help.push("This range is reported once; pushing the same commits again stays quiet");
  return finish(
    p,
    {
      jev_axi_pre_push: raised.length === 0 ? `nothing flagged (${scale})` : `${block ? "blocked" : "warning"}: ${raised.map((c) => c.label).join(", ")} (${scale})`,
      concerns: (json ? scored : raised).map((c) => ({ concern: c.label, p: Math.round(c.p * 100) / 100, raised: c.p >= PUSH_THRESHOLDS.warn })),
    },
    [result],
    help,
  );
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
  "pre-push": `#!/bin/sh
${MARKER}; remove with: jev-axi setup git-hooks --remove
command -v jev-axi >/dev/null 2>&1 || exit 0
exec jev-axi hook pre-push
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
        "pre-push: if command -v jev-axi >/dev/null 2>&1; then jev-axi hook pre-push || exit 1; fi",
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
      const chain = hook === "pre-commit" ? "jev-axi hook pre-commit || exit 1" : hook === "pre-push" ? "jev-axi hook pre-push || exit 1" : 'jev-axi hook commit-msg "$1"';
      help.push(`To chain it, add to ${file}: ${chain}`);
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
    help.push("pre-push judges the whole range being pushed and reports each range once; it never blocks unless you add --block-on flags");
    help.push("Change behavior by editing the hook: `jev-axi hook pre-commit --block-on flags`, `jev-axi hook commit-msg \"$1\" --strict`, `jev-axi hook pre-push --block-on flags`");
  }
  return { dir, hooks, help };
}
