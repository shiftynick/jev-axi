import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { evaluate, type EvalOptions, type EvalResult, type NoulAnswer } from "./client.js";
import { ensureDir, paths } from "./config.js";
import { round } from "./format.js";
import { PROGRESS_JOB, PROGRESS_THRESHOLDS as T, PROGRESS_WORKER } from "./recipes/questions.js";
import { parseDiff } from "./git.js";
import { redactSecrets } from "./safety.js";

/**
 * Supervision: independent yes/no judgments about an agent's work (is the job done?) and about
 * the worker itself (is it stuck, off track, or blocked on a person?). Jev only scores; the
 * action is picked by the fixed policy in `decideProgress`, never by a probability alone.
 */

export type ProgressVerdict = "finish" | "verify" | "continue" | "steer" | "escalate";

export interface Observation {
  job: string;
  diff?: string;
  output?: string;
  events?: SessionEvent[];
}

export interface SessionEvent {
  tool: string;
  input: string;
  result: string;
}

export interface Assessment {
  verdict: ProgressVerdict;
  reason: string;
  /** The scores sit between the thresholds: not evidence of a problem, so hooks stay quiet. */
  unclear?: boolean;
  scores: Record<string, number>;
  result: EvalResult;
}

const tail = (s: string, max: number) => (s.length <= max ? s : `... (${s.length - max} earlier chars omitted)\n${s.slice(-max)}`);
const head = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}\n... (truncated, ${s.length} chars total)`);

/** Bounded, redacted state. Only the parts that were observed are included, with the questions that read them. */
export function buildObservation(o: Observation): { state: Record<string, unknown>; questions: Record<string, unknown> } {
  const state: Record<string, unknown> = { job: head(o.job, T.jobChars) };
  const questions: Record<string, unknown> = {};
  if (o.diff !== undefined) {
    state["diff"] = redactSecrets(head(o.diff, T.diffChars)) || "(no changes)";
    state["output"] = o.output ? redactSecrets(tail(o.output, T.outputChars)) : "(none captured)";
    Object.assign(questions, PROGRESS_JOB);
  }
  if (o.events?.length) {
    state["events"] = o.events.slice(-T.events).map((e) => ({ tool: e.tool, input: redactSecrets(e.input), result: redactSecrets(e.result) }));
    Object.assign(questions, PROGRESS_WORKER);
  }
  return { state, questions };
}

/** Fixed policy, safety first: a person is needed, then the worker is stuck or off track, then the job itself. */
export function decideProgress(s: Record<string, number>): { verdict: ProgressVerdict; reason: string; unclear?: boolean } {
  const has = (k: string) => s[k] !== undefined;
  const p = (k: string) => `${k} ${s[k]}`;
  if (has("needs_human") && s["needs_human"]! >= T.concern) return { verdict: "escalate", reason: `a person may be needed to unblock this (${p("needs_human")})` };
  if (has("worker_stuck") && s["worker_stuck"]! >= T.concern) return { verdict: "steer", reason: `the recent tool calls look stuck in a loop (${p("worker_stuck")}); try a different approach` };
  if (has("work_off_track") && s["work_off_track"]! >= T.concern) return { verdict: "steer", reason: `the recent tool calls look unrelated to the job (${p("work_off_track")})` };
  if (!has("implementation_complete")) return { verdict: "continue", reason: "no worker concern above threshold" };
  const complete = s["implementation_complete"]!;
  const requirements = s["requirements_satisfied"]!;
  if (complete <= T.notDone) return { verdict: "continue", reason: `the job looks unfinished (${p("implementation_complete")})` };
  if (requirements <= T.notDone) return { verdict: "continue", reason: `a stated requirement looks unmet (${p("requirements_satisfied")})` };
  if (complete >= T.done && requirements >= T.done) {
    if (s["tests_sufficient"]! <= T.notDone) return { verdict: "verify", reason: `behavior changed without test coverage (${p("tests_sufficient")})` };
    if (s["needs_verification"]! >= T.done) return { verdict: "verify", reason: `nothing shows the change was built or tested (${p("needs_verification")})` };
    return { verdict: "finish", reason: "implemented, requirements met, verified" };
  }
  // Failing or missing runs make the model doubt completeness too; the useful next step is still to run and fix.
  if (s["needs_verification"]! >= T.done) return { verdict: "verify", reason: `not clearly done, and failures are visible or the change was not run (${p("needs_verification")})` };
  return { verdict: "continue", unclear: true, reason: `not clearly done (${p("implementation_complete")}, ${p("requirements_satisfied")})` };
}

export async function assess(o: Observation, options: EvalOptions): Promise<Assessment> {
  const { state, questions } = buildObservation(o);
  const result = await evaluate(state as never, questions as never, options);
  const scores = Object.fromEntries(Object.entries(result.answers).map(([k, a]) => [k, round((a as NoulAnswer).noul)]));
  return { ...decideProgress(scores), scores, result };
}

/* ------------------------------ observations ----------------------------- */

function git(args: string[], cwd: string): string | undefined {
  const r = spawnSync("git", ["--no-pager", ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

/** Files whose whole purpose is to hold credentials: never sent, whatever the patterns would redact. */
const CREDENTIAL_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.[a-z]+)?|secrets?\.[a-z]+)$|\.(pem|key|p12|pfx|keystore|jks)$/i;
export const isCredentialFile = (path: string) => CREDENTIAL_FILE.test(path.replaceAll("\\", "/")) && !/\.(example|sample|template)$/i.test(path);

const untrackedFiles = (cwd: string) => (git(["ls-files", "--others", "--exclude-standard"], cwd) ?? "").split("\n").filter(Boolean);

/**
 * Where the session began: a commit holding the tracked state, uncommitted changes included, and the
 * files that were already untracked. `git stash create` writes an unreferenced commit and touches
 * neither the working tree nor the stash list.
 */
export function sessionBase(cwd: string): { base?: string; untracked: string[] } {
  const base = git(["stash", "create"], cwd)?.trim() || git(["rev-parse", "--verify", "HEAD"], cwd)?.trim() || undefined;
  return { base, untracked: untrackedFiles(cwd) };
}

/** Everything changed since `base` (default HEAD): commits, working tree, and new untracked files. Undefined outside a repository. */
export function workDiff(cwd: string, base?: string, knownUntracked: string[] = []): string | undefined {
  const tracked = (base && git(["diff", "--no-color", "--no-ext-diff", base], cwd)) ?? git(["diff", "--no-color", "--no-ext-diff", "HEAD"], cwd) ?? git(["diff", "--no-color", "--no-ext-diff"], cwd);
  if (tracked === undefined) return undefined;
  let out = parseDiff(tracked).filter((f) => !isCredentialFile(f.path)).map((f) => f.patch).join("");
  const known = new Set(knownUntracked);
  for (const f of untrackedFiles(cwd)) {
    if (out.length > T.diffChars) break;
    if (known.has(f) || isCredentialFile(f)) continue;
    try {
      const full = join(cwd, f);
      if (statSync(full).size > 256 * 1024) continue;
      const text = readFileSync(full, "utf8");
      if (text.includes("\u0000")) continue;
      out += `diff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${text.split("\n").map((l) => `+${l}`).join("\n")}\n`;
    } catch {
      // unreadable: skip
    }
  }
  return out;
}

function blockText(content: unknown, kind: "text" | "tool_result"): string {
  if (typeof content === "string") return kind === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as any).type === kind)
    .map((b) => (kind === "text" ? String((b as any).text ?? "") : blockText((b as any).content, "text") || String(typeof (b as any).content === "string" ? (b as any).content : "")))
    .join("\n");
}

/** The job and recent tool output from a Claude Code transcript (JSONL). The job is the first prompt plus the latest one. */
export function readTranscript(file: string): { job: string; output: string } {
  const prompts: string[] = [];
  const outputs: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== "user" || e.isMeta || e.isSidechain) continue;
    const text = blockText(e.message?.content, "text").trim();
    // Harness-injected turns (slash-command echoes, reminders) are not the user's request.
    if (text && !text.startsWith("<")) prompts.push(text);
    const result = blockText(e.message?.content, "tool_result").trim();
    if (result) outputs.push(result);
  }
  const first = prompts[0] ?? "";
  const last = prompts[prompts.length - 1] ?? "";
  const job = first === last ? first : `${head(first, T.jobChars / 2)}\n\nLatest request: ${head(last, T.jobChars / 2)}`;
  return { job, output: outputs.slice(-5).join("\n---\n") };
}

/* -------------------------------- sessions ------------------------------- */

export interface Session {
  /** The repository when the session was first seen, so only the session's own work is judged (see sessionBase). */
  base?: string;
  untracked?: string[];
  count: number;
  events: SessionEvent[];
}

const sessionFile = (id: string) => join(paths.sessionsDir(), `${id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);

export function readSession(id: string): Session {
  try {
    return JSON.parse(readFileSync(sessionFile(id), "utf8")) as Session;
  } catch {
    return { count: 0, events: [] };
  }
}

/** Record one tool call in the session's bounded event tail. */
export function recordEvent(id: string, cwd: string, event: SessionEvent): Session {
  const s = readSession(id);
  if (s.count === 0) {
    Object.assign(s, sessionBase(cwd));
    pruneSessions();
  }
  s.count++;
  s.events = [...s.events, { tool: event.tool, input: event.input.slice(0, T.eventChars), result: event.result.slice(-T.eventChars) }].slice(-T.events);
  ensureDir(paths.sessionsDir());
  writeFileSync(sessionFile(id), JSON.stringify(s));
  return s;
}

function pruneSessions(maxAgeMs = 7 * 24 * 3600 * 1000): void {
  try {
    const dir = paths.sessionsDir();
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (Date.now() - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full);
    }
  } catch {
    // best-effort
  }
}
