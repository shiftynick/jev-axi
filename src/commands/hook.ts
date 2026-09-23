import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "../args.js";
import { evaluate, type NoulAnswer, type ScoreAnswer } from "../client.js";
import { ensureDir, paths } from "../config.js";
import { AxiError, validation } from "../errors.js";
import { SAFETY_QUESTIONS } from "../recipes/questions.js";
import { buildSafetyState, decide, hookOutput, localVerdict, reasonText, redactSecrets, type Decision, type ToolCall } from "../safety.js";
import { GIT_HOOKS_HELP, commitMsgHook, preCommitHook, prePushHook } from "./githooks.js";
import { isStdinTTY, readStdinSync } from "../stdin.js";
import { assess, readSession, readTranscript, recordEvent, workDiff, type Assessment } from "../supervise.js";
import { PROGRESS_THRESHOLDS } from "../recipes/questions.js";
import type { Renderable } from "./common.js";

export const HOOK_HELP = `usage: jev-axi hook pre-tool-use [--agent claude|codex] [--input <json|path>] [--on-error auto|allow|ask|deny] [--explain]
       jev-axi hook pre-commit [--block-on secrets|flags|none]   |   jev-axi hook commit-msg <file> [--strict]
       jev-axi hook pre-push [--block-on flags|none] [--range <a..b>]
Safety check for a tool call an agent is about to make, run as a PreToolUse hook. Reads the hook JSON on stdin.
Routine calls (read-only commands, the project's tests and builds, edits inside the project) are decided locally with
no API call. Other calls are sent to Jev with secrets redacted and scored for destructive actions, exfiltration,
running downloaded code, weakening security, and changes outside the project.
output: nothing (normal permission flow applies; never auto-approves), or a PreToolUse decision JSON to ask or deny.
flags:
  --agent <name>       output format: claude (default) or codex (Codex supports only deny, so ask becomes deny)
  --input <json|path>  hook JSON instead of stdin, for testing
  --on-error <mode>    auto (default: deny API 403, allow other errors), allow, ask, or deny
  --explain            print the decision, scores, and reason as TOON instead of hook JSON
install: jev-axi setup safety [--project] [--agent claude|codex]
supervision hooks for Claude Code and Codex (install: jev-axi setup supervise [--project] [--agent claude|codex] [--block]):
  stop [--block]       when the agent ends its turn with changes in the repository, scores whether the job from the
                       transcript is implemented, tested, and verified. Warns the user on a clear signal only; with --block it
                       sends the agent back to work once per stop, with the reason. Turns with no changes are skipped.
  post-tool-use        keeps the last ${PROGRESS_THRESHOLDS.events} tool calls of the session locally and, every ${PROGRESS_THRESHOLDS.every} calls (--every <n>), scores whether
                       the agent is stuck, off track, or blocked on a person. Adds a note to the agent's context; never blocks.
  Both send a bounded, secret-redacted snapshot to Jev, stay silent on any error, and log every verdict, spoken or
  not, to stats/supervise.jsonl (summarized by \`jev-axi stats\`). Tool calls the agent was denied are not seen.
${GIT_HOOKS_HELP}
log: every decision that reaches Jev is appended to ~/.config/jev-axi/stats/safety.jsonl
examples:
  echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf ~/"},"cwd":"'"$PWD"'"}' | jev-axi hook pre-tool-use --explain
`;

/** Hooks run on every tool call, so keep the check well inside agent hook timeouts. */
const HOOK_TIMEOUT_MS = 6000;

function readCall(p: ReturnType<typeof parseArgs>): ToolCall {
  const src = p.values["--input"];
  let raw: string;
  if (src !== undefined) raw = src.trim().startsWith("{") ? src : readFileSync(src, "utf8");
  else if (!isStdinTTY()) raw = readStdinSync();
  else throw validation("hook pre-tool-use reads the hook JSON on stdin", ["Pass --input '<json>' to test it by hand"]);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw validation(`hook input is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed["tool_name"] !== "string") throw validation("hook input has no tool_name");
  return {
    tool_name: parsed["tool_name"],
    tool_input: (parsed["tool_input"] as Record<string, unknown>) ?? {},
    cwd: typeof parsed["cwd"] === "string" ? parsed["cwd"] : process.cwd(),
  };
}

function logDecision(entry: Record<string, unknown>, name = "safety"): void {
  try {
    const file = join(paths.statsDir(), `${name}.jsonl`);
    ensureDir(paths.statsDir());
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // best-effort
  }
}

export async function hookCommand(args: string[]): Promise<Renderable> {
  if (args[0] === "pre-commit") return preCommitHook(args.slice(1));
  if (args[0] === "commit-msg") return commitMsgHook(args.slice(1));
  if (args[0] === "pre-push") return prePushHook(args.slice(1));
  if (args[0] === "stop" || args[0] === "post-tool-use") return superviseHook(args[0], args.slice(1));
  const p = parseArgs(args, { "--agent": "value", "--input": "value", "--on-error": "value", "--explain": "bool" }, "hook");
  if (p.positional[0] !== "pre-tool-use") throw validation("unknown hook", ["jev-axi hook pre-tool-use", "jev-axi hook stop", "jev-axi hook post-tool-use", "jev-axi hook pre-commit", "jev-axi hook commit-msg <file>", "jev-axi hook pre-push"]);
  const agent = (p.values["--agent"] ?? "claude") as "claude" | "codex";
  if (agent !== "claude" && agent !== "codex") throw validation("--agent must be claude or codex");
  const onError = (p.values["--on-error"] ?? "auto") as ErrorPolicy;
  if (!["auto", "allow", "ask", "deny"].includes(onError)) throw validation("--on-error must be auto, allow, ask, or deny");
  const call = readCall(p);
  const j = await judgeToolCall(call, { agent, onError, timeoutMs: HOOK_TIMEOUT_MS });
  if (p.bools["--explain"]) {
    const view = { decision: j.decision, source: j.source, reason: j.reason, ...j.detail };
    return p.bools["--json"] ? JSON.stringify(view) : view;
  }
  return hookOutput(j.decision, j.reason, agent);
}

export interface Judgment {
  decision: Decision;
  /** local: decided without an API call; jev: scored by Jev; error: Jev unavailable, on-error policy applied. */
  source: "local" | "jev" | "error";
  reason: string;
  detail: Record<string, unknown>;
}

export type ErrorPolicy = Decision | "auto";

/** Decide a tool call locally when routine, otherwise with Jev. Jev decisions are logged. */
export async function judgeToolCall(
  call: ToolCall,
  opts: { agent: string; onError: ErrorPolicy; timeoutMs: number },
): Promise<Judgment> {
  const local = localVerdict(call);
  if (local.decision === "allow") return { decision: "allow", source: "local", reason: local.reason, detail: {} };
  const summary = redactSecrets(String(call.tool_input["command"] ?? call.tool_input["file_path"] ?? "")).slice(0, 200);
  let j: Judgment;
  try {
    const r = await evaluate(buildSafetyState(call), SAFETY_QUESTIONS, { command: opts.agent === "exec" ? "guard-exec" : "hook", timeoutMs: opts.timeoutMs, maxRetries: 0 });
    const hazards = Object.fromEntries(
      Object.entries(r.answers).filter(([, a]) => a.type === "noul").map(([k, a]) => [k, Math.round((a as NoulAnswer).noul * 100) / 100]),
    );
    const risk = Math.round((r.answers["risk"] as ScoreAnswer).score * 100) / 100;
    const verdict = decide({ hazards, risk });
    const reason = verdict.decision === "allow" ? "no hazard above thresholds" : reasonText(verdict.decision, verdict.top, risk, opts.agent === "exec" ? "human" : "agent");
    j = { decision: verdict.decision, source: "jev", reason, detail: { hazards, risk, top: verdict.top[0] } };
  } catch (error) {
    const message = (error as Error).message;
    const rejected = error instanceof AxiError && error.code === "API_REJECTED";
    const decision = opts.onError === "auto" ? (rejected ? "deny" : "allow") : opts.onError;
    const reason = rejected
      ? `jev-axi safety check rejected by the API (403); on-error policy: ${opts.onError}, decision: ${decision}.`
      : `jev-axi safety check unavailable (${message}); on-error policy: ${opts.onError}, decision: ${decision}.`;
    j = { decision, source: "error", reason, detail: { error: message } };
  }
  logDecision({ agent: opts.agent, tool: call.tool_name, decision: j.decision, input: summary, cwd: call.cwd, ...j.detail });
  return j;
}

// ------------------------------------------------------------------ supervision

/** Stop runs once per turn and may take longer; PostToolUse runs mid-work and must stay quick. */
const STOP_TIMEOUT_MS = 10000;

function readHookJson(p: ReturnType<typeof parseArgs>, name: string): Record<string, unknown> {
  const src = p.values["--input"];
  let raw: string;
  if (src !== undefined) raw = src.trim().startsWith("{") ? src : readFileSync(src, "utf8");
  else if (!isStdinTTY()) raw = readStdinSync();
  else throw validation(`hook ${name} reads the hook JSON on stdin`, ["Pass --input '<json>' to test it by hand"]);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw validation(`hook input is not valid JSON: ${(e as Error).message}`);
  }
}

const asText = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

async function superviseHook(name: "stop" | "post-tool-use", args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--input": "value", "--block": "bool", "--every": "value", "--explain": "bool" }, "hook");
  const input = readHookJson(p, name);
  const explain = (view: Record<string, unknown>, fallback: string): Renderable => (p.bools["--explain"] ? (p.bools["--json"] ? JSON.stringify(view) : view) : fallback);
  const cwd = typeof input["cwd"] === "string" ? input["cwd"] : process.cwd();
  const sessionId = typeof input["session_id"] === "string" ? input["session_id"] : "";
  const transcript = typeof input["transcript_path"] === "string" && existsSync(input["transcript_path"]) ? input["transcript_path"] : undefined;
  let a: Assessment;
  try {
    if (name === "post-tool-use") {
      if (!sessionId) return explain({ skipped: "hook input has no session_id" }, "");
      const every = Math.max(1, Number(p.values["--every"] ?? PROGRESS_THRESHOLDS.every) || PROGRESS_THRESHOLDS.every);
      const s = recordEvent(sessionId, cwd, { tool: String(input["tool_name"] ?? ""), input: asText(input["tool_input"]), result: asText(input["tool_response"]) });
      if (s.count % every !== 0) return explain({ skipped: `call ${s.count}; the worker is checked every ${every}` }, "");
      const job = transcript ? readTranscript(transcript).job : "";
      if (!job) return explain({ skipped: "no job found in the transcript" }, "");
      a = await assess({ job, events: s.events }, { command: "hook-post-tool-use", timeoutMs: HOOK_TIMEOUT_MS, maxRetries: 0 });
    } else {
      // The agent is already continuing because of a stop hook: never block twice in a row.
      if (input["stop_hook_active"] === true) return explain({ skipped: "stop_hook_active" }, "");
      const t = transcript ? readTranscript(transcript) : { job: "", output: "" };
      if (!t.job) return explain({ skipped: "no job found in the transcript" }, "");
      const session = sessionId ? readSession(sessionId) : undefined;
      const diff = workDiff(cwd, session?.base, session?.untracked);
      if (!diff || diff.trim() === "") return explain({ skipped: "no changes in the repository" }, "");
      a = await assess({ job: t.job, diff, output: t.output }, { command: "hook-stop", timeoutMs: STOP_TIMEOUT_MS, maxRetries: 0 });
    }
  } catch (error) {
    // Supervision is advisory: an unreachable API must never disturb the session.
    return explain({ skipped: (error as Error).message }, "");
  }
  // Speak only on a clear signal: mid-range scores (a vague job, a partial diff) are not worth an interruption.
  const quiet = a.verdict === "finish" || a.unclear || (name === "post-tool-use" && a.verdict === "continue");
  const action = quiet ? "none" : name === "post-tool-use" ? "note" : p.bools["--block"] && (a.verdict === "continue" || a.verdict === "verify") ? "block" : "warn";
  // A replay by hand is not a session event: keep it out of the log that calibration reads.
  if (!p.bools["--explain"]) logDecision({ hook: name, verdict: a.verdict, ...(a.unclear ? { unclear: true } : {}), action, reason: a.reason, cwd, ...a.scores }, "supervise");
  const view = { verdict: a.verdict, reason: a.reason, ...a.scores, action };
  if (action === "none") return explain(view, "");
  const note = `jev-axi supervision: ${a.reason}.`;
  if (action === "note") {
    const advice = a.verdict === "escalate" ? " Stop and ask the user before going further." : " Reconsider the approach against the original request; ignore this note if it is wrong.";
    return explain(view, JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note + advice } }));
  }
  const out = action === "block" ? { decision: "block", reason: `${note} Finish or verify the work, or explain to the user why it is already complete.` } : { systemMessage: note };
  return explain(view, JSON.stringify(out));
}

// ------------------------------------------------------------------ installation

export const SUPERVISE_HOOK_COMMAND = "jev-axi hook stop";
const SUPERVISE_POST_COMMAND = "jev-axi hook post-tool-use";

/** Add or remove the Stop and PostToolUse supervision hooks. Idempotent; re-running switches --block. */
export function configureSuperviseHooks(agent: "claude" | "codex", project: boolean, remove: boolean, block: boolean): { file: string; changed: boolean } {
  const file = safetyHookPath(agent, project);
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const data = (before ? JSON.parse(before) : {}) as Record<string, any>;
  const hooks = (data["hooks"] ??= {});
  // No matcher: both agents then run the hook for every tool.
  const wanted: [string, string, number][] = [
    ["Stop", block ? `${SUPERVISE_HOOK_COMMAND} --block` : SUPERVISE_HOOK_COMMAND, 20],
    ["PostToolUse", SUPERVISE_POST_COMMAND, 15],
  ];
  for (const [event, command, timeout] of wanted) {
    const base = command.replace(/ --block$/, "");
    const list: HookEntry[] = (hooks[event] ?? []).map((e: HookEntry) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !h.command.startsWith(base)) })).filter((e: HookEntry) => e.hooks.length > 0);
    if (!remove) list.push({ hooks: [{ type: "command", command, timeout }] });
    if (list.length) hooks[event] = list;
    else delete hooks[event];
  }
  const after = JSON.stringify(data, null, 2) + "\n";
  if (after === before || (remove && !before)) return { file, changed: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after);
  return { file, changed: true };
}

export const SAFETY_HOOK_COMMAND = "jev-axi hook pre-tool-use";
const MATCHER = "Bash|Write|Edit|MultiEdit";

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

export function safetyHookPath(agent: "claude" | "codex", project: boolean): string {
  if (agent === "claude") return project ? join(process.cwd(), ".claude", "settings.json") : join(homedir(), ".claude", "settings.json");
  return project ? join(process.cwd(), ".codex", "hooks.json") : join(homedir(), ".codex", "hooks.json");
}

/** Add or remove the PreToolUse safety hook. Idempotent; leaves other hooks untouched. */
export function configureSafetyHook(agent: "claude" | "codex", project: boolean, remove: boolean): { file: string; changed: boolean } {
  const file = safetyHookPath(agent, project);
  const data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8") || "{}") as Record<string, any>) : {};
  const hooks = (data["hooks"] ??= {});
  const list: HookEntry[] = (hooks["PreToolUse"] ??= []);
  const command = agent === "codex" ? `${SAFETY_HOOK_COMMAND} --agent codex` : SAFETY_HOOK_COMMAND;
  const isOurs = (h: { command: string }) => h.command.startsWith(SAFETY_HOOK_COMMAND);
  const present = list.some((e) => e.hooks?.some(isOurs));
  if (remove) {
    if (!present) return { file, changed: false };
    for (const e of list) e.hooks = (e.hooks ?? []).filter((h) => !isOurs(h));
    hooks["PreToolUse"] = list.filter((e) => e.hooks.length > 0);
    if (!hooks["PreToolUse"].length) delete hooks["PreToolUse"];
  } else {
    if (present) return { file, changed: false };
    list.push({ matcher: MATCHER, hooks: [{ type: "command", command, timeout: 15 }] });
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return { file, changed: true };
}
