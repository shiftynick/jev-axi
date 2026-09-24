import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stdinKind } from "../src/stdin.js";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const BIN = join(ROOT, "bin", "jev-axi.ts");

/** Run the CLI the way an agent harness does: non-interactive, stdin attached to /dev/null (or NUL). */
function runAgentStyle(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [TSX, BIN, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, TYPESAFE_API_KEY: "unused", XDG_CONFIG_HOME: join(cwd, ".cfg"), XDG_CACHE_HOME: join(cwd, ".cache") },
    timeout: 60_000,
  });
  return { out: r.stdout, code: r.status };
}

describe("stdinKind", () => {
  it("reads the stat type bits directly, so Windows named pipes count as pipes", () => {
    // A Windows shell pipe reports mode 0o10000 (S_IFIFO) with isFIFO() === false and isFile() === false.
    expect(stdinKind(0o10000, false)).toBe("pipe");
    expect(stdinKind(0o140000, false)).toBe("pipe");
    expect(stdinKind(0o100000, true)).toBe("file");
    expect(stdinKind(0o100000, false)).toBe("file");
    expect(stdinKind(0o020000, false)).toBe("none");
    expect(stdinKind(0o040000, false)).toBe("none");
  });
});

describe("empty stdin from agent harnesses", () => {
  it("diff reviews the git working tree instead of the empty stdin", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-stdin-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const { out, code } = runAgentStyle(["diff"], dir);
    expect(code).toBe(0);
    expect(out).toContain("diff: working tree changes");
    expect(out).toContain("0 changed files");
  });

  it("commands needing input say what to pass instead of 'state is empty'", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-stdin-"));
    writeFileSync(join(dir, "placeholder.txt"), "x");
    const check = runAgentStyle(["check", "is it?"], dir);
    expect(check.code).toBe(2);
    expect(check.out).toContain("error: no state given");
    const triage = runAgentStyle(["triage"], dir);
    expect(triage.out).toContain("triage needs a file or piped input");
    const rank = runAgentStyle(["rank", "q"], dir);
    expect(rank.out).toContain("error: no items given");
  });
});

describe("stdin held open but idle", () => {
  it("diff falls back to the working tree instead of waiting for EOF", async () => {
    const { spawn } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "jev-stdin-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    // stdio "pipe" and never ending stdin is what several agent harnesses hand a child.
    const child = spawn(process.execPath, [TSX, BIN, "diff"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, TYPESAFE_API_KEY: "unused", XDG_CONFIG_HOME: join(dir, ".cfg"), XDG_CACHE_HOME: join(dir, ".cache") },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const code = await new Promise((done) => child.on("exit", done));
    child.stdin.end();
    expect(code).toBe(0);
    expect(out).toContain("diff: working tree changes");
  }, 30_000);

  // Needs a POSIX shell pipeline; under Windows the runner's `sh` hands node a stdin that was never treated as piped input.
  it.skipIf(process.platform === "win32")("still reads a pipe whose producer is slow to start", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-stdin-"));
    const r = spawnSync("sh", ["-c", `(sleep 2; echo hello; echo world) | "${process.execPath}" "${TSX}" "${BIN}" rank q`], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TYPESAFE_API_KEY: "", XDG_CONFIG_HOME: join(dir, ".cfg"), XDG_CACHE_HOME: join(dir, ".cache") },
      timeout: 60_000,
    });
    // Input was read, so the failure is the missing key rather than "no items given".
    expect(r.stdout).not.toContain("no items given");
    expect(r.stdout).toContain("AUTH_REQUIRED");
  }, 60_000);
});
