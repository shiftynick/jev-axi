import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureFetch } from "../src/client.js";
import { main } from "../src/cli.js";
import { configureGitHooks, parseCommitMessage, parsePushUpdates, pushAlreadyWarned, pushRange, pushRecordWarned } from "../src/commands/githooks.js";
import { parseDiff, scanAddedLines, testStem } from "../src/git.js";

// Assembled at runtime so no key-shaped literal lives in the repo.
const githubToken = ["ghp", "Abc123Def456Ghi789Jkl012Mno345"].join("_");

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-githooks-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

/** Fake API that answers every noul with `noul` and every score with its lowest level. */
function fakeApi(noul: number) {
  const bodies: string[] = [];
  configureFetch((async (_url: unknown, init?: { body: string }) => {
    bodies.push(init!.body);
    const q = JSON.parse(init!.body).questions as Record<string, any>;
    const answers = Object.fromEntries(
      Object.entries(q).map(([id, spec]) => [
        id,
        spec.type === "noul"
          ? { type: "noul", noul }
          : spec.type === "choice"
            ? { type: "choice", choice: Object.keys(spec.criteria)[0], probabilities: {}, confidence: 0.9 }
            : { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 0.9 },
      ]),
    );
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
  }) as any);
  return bodies;
}

let out = "";
const stdout = { write: (s: string) => ((out += s), true) };
const origCwd = process.cwd();

beforeEach(() => {
  out = "";
  const state = mkdtempSync(join(tmpdir(), "jev-githooks-state-"));
  process.env["XDG_CACHE_HOME"] = join(state, "cache");
  process.env["XDG_CONFIG_HOME"] = join(state, "config");
  process.env["TYPESAFE_API_KEY"] = "test-key";
  process.exitCode = 0;
});
afterEach(() => {
  process.chdir(origCwd);
  configureFetch(undefined);
  process.exitCode = 0;
});

describe("git hook helpers", () => {
  it("finds strong credentials on added lines with new-file line numbers, ignoring removed lines", () => {
    const patch = [
      "diff --git a/cfg.js b/cfg.js",
      "--- a/cfg.js",
      "+++ b/cfg.js",
      "@@ -1,2 +1,3 @@",
      " const a = 1;",
      `-const old = "${githubToken}";`,
      `+const token = "${githubToken}";`,
      '+const password = "changeme";',
    ].join("\n");
    expect(scanAddedLines(parseDiff(patch))).toEqual([{ file: "cfg.js", line: 2, kind: "github token" }]);
  });

  it("parses commit messages without comments or the verbose diff", () => {
    const raw = "\nfix: handle empty input\n\nLonger body.\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n";
    expect(parseCommitMessage(raw)).toEqual({ subject: "fix: handle empty input", body: "Longer body." });
    expect(parseCommitMessage("# only comments\n")).toEqual({ subject: "", body: "" });
  });

  it("matches source files to their tests by stem", () => {
    expect(testStem("src/math.ts")).toBe(testStem("test/math.test.ts"));
    expect(testStem("pkg/foo.go")).toBe(testStem("pkg/foo_test.go"));
    expect(testStem("src/util.py")).toBe(testStem("tests/test_util.py"));
    expect(testStem("src/Parser.java")).toBe(testStem("src/ParserTest.java"));
  });
});

describe("setup git-hooks", () => {
  it("installs idempotently, leaves foreign hooks alone, and removes only its own", () => {
    const dir = repo();
    process.chdir(dir);
    const hooksDir = join(dir, ".git", "hooks");
    writeFileSync(join(hooksDir, "commit-msg"), "#!/bin/sh\necho mine\n");
    const first = configureGitHooks(false);
    expect(first.hooks).toEqual([
      { hook: "pre-commit", status: "installed" },
      { hook: "commit-msg", status: "a different hook exists; left untouched" },
      { hook: "pre-push", status: "installed" },
    ]);
    expect(readFileSync(join(hooksDir, "pre-commit"), "utf8")).toContain("exec jev-axi hook pre-commit");
    expect(configureGitHooks(false).hooks[0]!.status).toBe("already installed (no-op)");
    const removed = configureGitHooks(true);
    expect(removed.hooks.map((h) => h.status)).toEqual(["removed", "not ours, left untouched", "removed"]);
    expect(existsSync(join(hooksDir, "commit-msg"))).toBe(true);
  });

  it("does not write into a hooks directory managed by another tool", () => {
    const dir = repo();
    process.chdir(dir);
    git(dir, "config", "core.hooksPath", ".husky/_");
    const r = configureGitHooks(false);
    expect(r.hooks.every((h) => h.status.startsWith("not installed"))).toBe(true);
    expect(existsSync(join(dir, ".husky", "_", "pre-commit"))).toBe(false);
  });
});

describe("hook pre-commit", () => {
  it("blocks staged credentials without calling the API", async () => {
    const dir = repo();
    process.chdir(dir);
    writeFileSync(join(dir, "cfg.js"), `export const token = "${githubToken}";\n`);
    git(dir, "add", "cfg.js");
    const bodies = fakeApi(0.1);
    await main(["hook", "pre-commit"], stdout);
    expect(process.exitCode).toBe(1);
    expect(out).toContain("blocked: staged changes add credentials");
    expect(bodies).toHaveLength(0);
  });

  it("reviews the staged diff with credentials redacted and only warns", async () => {
    const dir = repo();
    process.chdir(dir);
    writeFileSync(join(dir, "db.js"), 'const DB_PASSWORD = "hunter2-prod-7731";\nconsole.log("debug");\n');
    git(dir, "add", "db.js");
    const bodies = fakeApi(0.95);
    await main(["hook", "pre-commit"], stdout);
    expect(process.exitCode).toBe(0);
    expect(out).toContain("warning:");
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join("")).not.toContain("hunter2-prod-7731");
  });

  it("is silent when nothing is staged", async () => {
    const dir = repo();
    process.chdir(dir);
    await main(["hook", "pre-commit"], stdout);
    expect(out).toBe("");
    expect(process.exitCode).toBe(0);
  });
});

const ZEROS = "0".repeat(40);

/** A repo with a bare origin, one pushed commit, and one unpushed commit. */
function repoWithRemote(): { dir: string; localSha: string; remoteSha: string; branch: string } {
  const dir = repo();
  const origin = mkdtempSync(join(tmpdir(), "jev-githooks-origin-"));
  git(origin, "init", "-q", "--bare");
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  git(dir, "add", "a.js");
  git(dir, "commit", "-qm", "first");
  git(dir, "remote", "add", "origin", origin);
  const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim();
  git(dir, "push", "-q", "origin", branch);
  const remoteSha = git(dir, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "b.js"), "export const b = 2; // TODO: finish\n");
  git(dir, "add", "b.js");
  git(dir, "commit", "-qm", "second");
  const localSha = git(dir, "rev-parse", "HEAD").trim();
  return { dir, localSha, remoteSha, branch };
}

describe("pre-push ref updates", () => {
  it("parses git's ref update lines and skips deletions and malformed lines", () => {
    const stdin = [
      `refs/heads/main aaa111 refs/heads/main bbb222`,
      `(delete) ${ZEROS} refs/heads/gone ccc333`,
      `garbage`,
      ``,
      `refs/tags/v1 ddd444 refs/tags/v1 ${ZEROS}`,
    ].join("\n");
    const updates = parsePushUpdates(stdin);
    expect(updates.map((u) => u.localSha)).toEqual(["aaa111", "ddd444"]);
  });

  it("uses remote..local when the remote already has the branch", () => {
    const { dir, localSha, remoteSha, branch } = repoWithRemote();
    process.chdir(dir);
    const r = pushRange({ localRef: `refs/heads/${branch}`, localSha, remoteRef: `refs/heads/${branch}`, remoteSha });
    expect(r?.commits).toEqual([localSha]);
    expect(r?.diffArgs).toEqual([remoteSha, localSha]);
  });

  it("for a new branch reviews only commits no remote has", () => {
    const { dir, localSha, branch } = repoWithRemote();
    process.chdir(dir);
    const r = pushRange({ localRef: `refs/heads/${branch}`, localSha, remoteRef: "refs/heads/feature", remoteSha: ZEROS });
    // The first commit is already on origin, so only the second is under review.
    expect(r?.commits).toEqual([localSha]);
  });

  it("returns nothing when the remote is already up to date", () => {
    const { dir, remoteSha, branch } = repoWithRemote();
    process.chdir(dir);
    expect(pushRange({ localRef: `refs/heads/${branch}`, localSha: remoteSha, remoteRef: `refs/heads/${branch}`, remoteSha })).toBeUndefined();
  });

  it("remembers a range so the same push is only reported once", () => {
    expect(pushAlreadyWarned("/repo#refs/heads/main#abc")).toBe(false);
    pushRecordWarned("/repo#refs/heads/main#abc");
    expect(pushAlreadyWarned("/repo#refs/heads/main#abc")).toBe(true);
    expect(pushAlreadyWarned("/repo#refs/heads/main#def")).toBe(false);
  });
});

describe("hook pre-push", () => {
  it("warns about the range, with credentials redacted, without blocking", async () => {
    const { dir } = repoWithRemote();
    process.chdir(dir);
    writeFileSync(join(dir, "db.js"), 'const DB_PASSWORD = "hunter2-prod-7731";\n');
    git(dir, "add", "db.js");
    git(dir, "commit", "-qm", "third");
    const bodies = fakeApi(0.95);
    await main(["hook", "pre-push", "--range", "HEAD~2..HEAD"], stdout);
    expect(process.exitCode).toBe(0);
    expect(out).toContain("warning:");
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join("")).not.toContain("hunter2-prod-7731");
  });

  it("says nothing is flagged when every concern is below the threshold", async () => {
    const { dir } = repoWithRemote();
    process.chdir(dir);
    fakeApi(0.1);
    await main(["hook", "pre-push", "--range", "HEAD~1..HEAD"], stdout);
    expect(process.exitCode).toBe(0);
    expect(out).toContain("nothing flagged");
  });

  it("blocks on a strong concern only with --block-on flags", async () => {
    const { dir } = repoWithRemote();
    process.chdir(dir);
    fakeApi(0.95);
    await main(["hook", "pre-push", "--range", "HEAD~1..HEAD", "--block-on", "flags"], stdout);
    expect(process.exitCode).toBe(1);
    expect(out).toContain("blocked:");
  });

  it("is silent when the range has no commits", async () => {
    const { dir } = repoWithRemote();
    process.chdir(dir);
    await main(["hook", "pre-push", "--range", "HEAD..HEAD"], stdout);
    expect(out).toBe("");
    expect(process.exitCode).toBe(0);
  });

  it("rejects an unknown --block-on value", async () => {
    const { dir } = repoWithRemote();
    process.chdir(dir);
    await main(["hook", "pre-push", "--range", "HEAD~1..HEAD", "--block-on", "secrets"], stdout);
    expect(process.exitCode).not.toBe(0);
    expect(out).toContain("--block-on");
  });
});
