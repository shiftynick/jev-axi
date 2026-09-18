import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureFetch } from "../src/client.js";
import { main } from "../src/cli.js";
import { buildObservation, decideProgress, readTranscript, recordEvent, readSession, workDiff } from "../src/supervise.js";

function fakeApi(nouls: Record<string, number> = {}, fallback = 0.1) {
  const requests: any[] = [];
  const fetch = async (_url: any, init?: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: nouls[id] ?? fallback }]));
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 50, output_tokens: 5 } }), { status: 200 });
  };
  return { fetch: fetch as any, requests };
}

const DONE = { implementation_complete: 0.9, requirements_satisfied: 0.9, tests_sufficient: 0.9, needs_verification: 0.1 };

let out = "";
const stdout = { write: (s: string) => { out += s; return true; } };
let dir: string;
const origCwd = process.cwd();

beforeEach(() => {
  out = "";
  dir = mkdtempSync(join(tmpdir(), "jev-axi-supervise-"));
  process.chdir(dir);
  process.env["XDG_CACHE_HOME"] = join(dir, ".x", "cache");
  process.env["XDG_STATE_HOME"] = join(dir, ".x", "state");
  process.env["XDG_CONFIG_HOME"] = join(dir, ".x", "config");
  process.env["TYPESAFE_API_KEY"] = "test-key";
  process.exitCode = 0;
  // No shell: CI also runs on Windows.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".x\n.x-*\n");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "init");
});
afterEach(() => {
  process.chdir(origCwd);
  configureFetch(undefined);
  process.exitCode = 0;
});

function transcript(prompt = "add a multiply function with a test"): string {
  const file = join(dir, ".x-transcript.jsonl");
  writeFileSync(
    file,
    [
      { type: "user", message: { content: "<command-name>/clear</command-name>" } },
      { type: "user", message: { content: prompt } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "Tests 3 passed" }] }] } },
    ].map((e) => JSON.stringify(e)).join("\n"),
  );
  return file;
}

describe("policy", () => {
  it("orders a needed person above stuck above the job", () => {
    expect(decideProgress({ ...DONE, needs_human: 0.8, worker_stuck: 0.9 }).verdict).toBe("escalate");
    expect(decideProgress({ ...DONE, needs_human: 0.2, worker_stuck: 0.9 }).verdict).toBe("steer");
    expect(decideProgress({ needs_human: 0.2, worker_stuck: 0.2, work_off_track: 0.75 }).verdict).toBe("steer");
    expect(decideProgress({ needs_human: 0.2, worker_stuck: 0.2, work_off_track: 0.2 }).verdict).toBe("continue");
  });
  it("finishes only when done, tested, and verified", () => {
    expect(decideProgress(DONE).verdict).toBe("finish");
    expect(decideProgress({ ...DONE, needs_verification: 0.8 }).verdict).toBe("verify");
    expect(decideProgress({ ...DONE, tests_sufficient: 0.2 }).verdict).toBe("verify");
    expect(decideProgress({ ...DONE, implementation_complete: 0.2 }).verdict).toBe("continue");
    expect(decideProgress({ ...DONE, implementation_complete: 0.5 }).verdict).toBe("continue");
    expect(decideProgress({ ...DONE, implementation_complete: 0.5, needs_verification: 0.9 }).verdict).toBe("verify");
  });
});

describe("observations", () => {
  it("bounds the diff, tails the output, and redacts secrets", () => {
    const { state, questions } = buildObservation({ job: "j", diff: `+key = "sk-ant-api03-${"a".repeat(90)}"\n${"x".repeat(30000)}`, output: `${"old ".repeat(5000)}LAST LINE` });
    expect(String(state["diff"]).length).toBeLessThan(20200);
    expect(String(state["diff"])).not.toContain("sk-ant-api03-aaaa");
    expect(String(state["output"])).toContain("LAST LINE");
    expect(String(state["output"]).length).toBeLessThan(12100);
    expect(Object.keys(questions)).toEqual(["implementation_complete", "tests_sufficient", "requirements_satisfied", "needs_verification"]);
  });
  it("reads the job and recent tool output from a transcript, skipping injected turns", () => {
    const t = readTranscript(transcript());
    expect(t.job).toBe("add a multiply function with a test");
    expect(t.output).toContain("Tests 3 passed");
  });
  it("never sends credential files, and judges only work done since the session began", () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 'dirty before the session';\n");
    writeFileSync(join(dir, "old-notes.md"), "untracked before the session\n");
    recordEvent("s9", dir, { tool: "Read", input: "a.ts", result: "" });
    const s = readSession("s9");
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    writeFileSync(join(dir, ".env"), "API_TOKEN=hunter2hunter2\n");
    writeFileSync(join(dir, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
    const diff = workDiff(dir, s.base, s.untracked)!;
    expect(diff).toContain("b.ts");
    expect(diff).not.toContain("dirty before the session");
    expect(diff).not.toContain("old-notes.md");
    expect(diff).not.toContain("hunter2");
    expect(diff).not.toContain("deploy.pem");
    expect(workDiff(dir)).toContain("dirty before the session");
  });
});

describe("progress", () => {
  it("reports finish with exit 0 and sends untracked files", async () => {
    writeFileSync(join(dir, "mul.ts"), "export const mul = (a: number, b: number) => a * b;\n");
    const api = fakeApi(DONE);
    configureFetch(api.fetch);
    writeFileSync(join(dir, ".x-test.log"), "Tests 3 passed\n");
    await main(["progress", "--job", "add mul", "--log", ".x-test.log"], stdout);
    expect(out).toContain("verdict: finish");
    expect(process.exitCode).toBe(0);
    expect(api.requests[0].state.diff).toContain("+export const mul");
  });
  it("exits 3 when unfinished", async () => {
    configureFetch(fakeApi({ ...DONE, implementation_complete: 0.2 }).fetch);
    writeFileSync(join(dir, ".x-test.log"), "1 failed\n");
    await main(["progress", "--job", "add mul", "--log", ".x-test.log"], stdout);
    expect(out).toContain("verdict: continue");
    expect(process.exitCode).toBe(3);
  });
});

describe("hook stop", () => {
  const input = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: "s1", transcript_path: transcript(), cwd: dir, ...extra });
  it("stays silent when nothing changed, without calling the API", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    await main(["hook", "stop", "--block", "--input", input()], stdout);
    expect(out).toBe("");
    expect(api.requests).toHaveLength(0);
  });
  it("warns by default and blocks only with --block", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    configureFetch(fakeApi({ ...DONE, implementation_complete: 0.2 }).fetch);
    await main(["hook", "stop", "--input", input()], stdout);
    expect(JSON.parse(out)).toHaveProperty("systemMessage");
    out = "";
    await main(["hook", "stop", "--block", "--no-cache", "--input", input()], stdout);
    expect(JSON.parse(out).decision).toBe("block");
    expect(readFileSync(join(dir, ".x", "config", "jev-axi", "stats", "supervise.jsonl"), "utf8")).toContain('"verdict":"continue"');
  });
  it("stays silent when the scores are merely unclear", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    configureFetch(fakeApi({}, 0.5).fetch);
    await main(["hook", "stop", "--block", "--input", input()], stdout);
    expect(out).toBe("");
  });
  it("never blocks twice in a row, stays silent on finish and on API errors", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    const api = fakeApi({ implementation_complete: 0.1 });
    configureFetch(api.fetch);
    await main(["hook", "stop", "--block", "--input", input({ stop_hook_active: true })], stdout);
    expect(api.requests).toHaveLength(0);
    configureFetch(fakeApi(DONE).fetch);
    await main(["hook", "stop", "--block", "--input", input()], stdout);
    configureFetch((async () => new Response("boom", { status: 500 })) as any);
    await main(["hook", "stop", "--block", "--no-cache", "--input", input()], stdout);
    expect(out).toBe("");
    expect(process.exitCode).toBe(0);
  });
});

describe("hook post-tool-use", () => {
  it("records events and checks the worker every N calls", async () => {
    const api = fakeApi({ worker_stuck: 0.9 });
    configureFetch(api.fetch);
    const call = (n: number) => main(["hook", "post-tool-use", "--every", "3", "--input", JSON.stringify({ session_id: "s2", transcript_path: transcript(), cwd: dir, tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: `fail ${n}` } })], stdout);
    await call(1);
    await call(2);
    expect(out).toBe("");
    expect(api.requests).toHaveLength(0);
    await call(3);
    expect(api.requests[0].state.events).toHaveLength(3);
    expect(Object.keys(api.requests[0].questions)).toContain("worker_stuck");
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("stuck");
  });
});

describe("setup supervise", () => {
  it("installs, switches mode, and removes without touching other hooks", async () => {
    const file = join(dir, ".claude", "settings.json");
    await main(["setup", "safety", "--project"], stdout);
    await main(["setup", "supervise", "--project"], stdout);
    let cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.hooks.Stop[0].hooks[0].command).toBe("jev-axi hook stop");
    expect(cfg.hooks.PostToolUse).toHaveLength(1);
    await main(["setup", "supervise", "--project", "--block"], stdout);
    cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.hooks.Stop).toHaveLength(1);
    expect(cfg.hooks.Stop[0].hooks[0].command).toBe("jev-axi hook stop --block");
    await main(["setup", "supervise", "--project", "--remove"], stdout);
    cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.hooks.Stop).toBeUndefined();
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(existsSync(file)).toBe(true);
  });
});
