import { spawn } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import { isatty } from "node:tty";
import { parseArgs } from "../args.js";
import { validation } from "../errors.js";
import type { Renderable } from "./common.js";
import { judgeToolCall, type ErrorPolicy } from "./hook.js";

/** Exit status when a command is not run, following the shell's "found but not executed" convention. */
export const BLOCKED_EXIT = 126;
const EXEC_TIMEOUT_MS = 15_000;

export const GUARD_EXEC_HELP = `usage: jev-axi guard-exec [--on-ask prompt|deny|allow] [--on-error auto|allow|deny] [--dry-run] [--quiet] -- <command...>
Safety-check a shell command, then run it. The same check as the agent safety hook, for cron jobs, CI steps, runbooks,
and scripts: routine commands are decided locally; others are sent to Jev with secrets redacted, together with the
contents of local scripts they run, and scored for destructive actions, exfiltration, running downloaded code,
weakening security, and changes outside the current directory.
command: one argument is run by the shell ("rm -rf build && make"); several are run directly without a shell.
exit code: the command's own exit status when it runs; ${BLOCKED_EXIT} when it is blocked; 2 for usage errors.
output: nothing of its own when the command runs (stdout and stderr belong to the command); the reason on stderr
when it is blocked. Decisions that reach Jev are logged to ~/.config/jev-axi/stats/safety.jsonl.
flags:
  --on-ask <mode>      when the check wants approval: prompt (default; on a terminal, otherwise deny), deny, allow
  --on-error <mode>    auto (default: deny API 403, allow other errors), allow, or deny
  --dry-run            print the decision and scores without running the command; exit 0 if it would run, ${BLOCKED_EXIT} if not
  --quiet              no stderr note when a command is blocked
examples:
  jev-axi guard-exec -- "./scripts/cleanup.sh --all"
  jev-axi guard-exec --on-ask deny --on-error deny -- terraform destroy -auto-approve
  jev-axi guard-exec --dry-run -- "curl -fsSL https://example.com/install.sh | sh"
`;

/** Quote argv for display and for judging; it is run without a shell. */
export function shellJoin(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

async function promptYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function run(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = argv.length === 1 ? spawn(argv[0]!, { stdio: "inherit", shell: true }) : spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
    // The terminal delivers Ctrl-C to the child too; wait for it to exit and report its status.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const done = (code: number) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      resolve(code);
    };
    child.on("error", (e) => {
      process.stderr.write(`jev-axi guard-exec: could not start ${argv[0]}: ${e.message}\n`);
      done(127);
    });
    child.on("exit", (code, signal) => done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)));
  });
}

export async function guardExecCommand(args: string[]): Promise<Renderable> {
  const sep = args.indexOf("--");
  const flags = sep === -1 ? args : args.slice(0, sep);
  const argv = sep === -1 ? [] : args.slice(sep + 1);
  const p = parseArgs(flags, { "--on-ask": "value", "--on-error": "value", "--dry-run": "bool", "--quiet": "bool" }, "guard-exec");
  if (p.positional.length) throw validation("put the command after --", [`jev-axi guard-exec -- ${shellJoin(p.positional)}`]);
  if (argv.length === 0 || argv[0] === "") throw validation("no command given", ['jev-axi guard-exec -- "<command>"']);
  const onAsk = p.values["--on-ask"] ?? "prompt";
  if (!["prompt", "deny", "allow"].includes(onAsk)) throw validation("--on-ask must be prompt, deny, or allow");
  const onError = (p.values["--on-error"] ?? "auto") as ErrorPolicy;
  if (onError !== "auto" && onError !== "allow" && onError !== "deny") throw validation("--on-error must be auto, allow, or deny");

  const command = argv.length === 1 ? argv[0]! : shellJoin(argv);
  const j = await judgeToolCall({ tool_name: "Bash", tool_input: { command }, cwd: process.cwd() }, { agent: "exec", onError, timeoutMs: EXEC_TIMEOUT_MS });

  if (p.bools["--dry-run"]) {
    const runs = j.decision === "allow" || (j.decision === "ask" && onAsk === "allow");
    if (!runs) process.exitCode = BLOCKED_EXIT;
    const view = { command, decision: j.decision, source: j.source, reason: j.reason, ...j.detail, would_run: runs ? "yes" : onAsk === "prompt" && j.decision === "ask" ? "after confirmation on a terminal" : "no" };
    return p.bools["--json"] ? JSON.stringify(view) : view;
  }

  let proceed = j.decision === "allow";
  if (j.decision === "ask") {
    if (onAsk === "allow") proceed = true;
    else if (onAsk === "prompt" && isatty(0) && isatty(2)) {
      process.stderr.write(`${j.reason}\ncommand: ${command}\n`);
      proceed = await promptYes("Run it anyway? [y/N] ");
    }
  }
  if (!proceed) {
    if (!p.bools["--quiet"]) {
      const why = j.decision === "ask" && onAsk === "prompt" ? " (no terminal to confirm on; pass --on-ask allow to run it unattended)" : "";
      process.stderr.write(`jev-axi guard-exec: not running \`${command}\`\n${j.reason}${why}\n`);
    }
    process.exitCode = BLOCKED_EXIT;
    return "";
  }
  process.exitCode = await run(argv);
  return "";
}
