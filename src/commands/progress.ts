import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "../args.js";
import { bandForNoul } from "../bands.js";
import { validation } from "../errors.js";
import { loadDiff } from "../git.js";
import { PROGRESS_THRESHOLDS } from "../recipes/questions.js";
import { readImplicitStdin } from "../stdin.js";
import { assess, workDiff, type SessionEvent } from "../supervise.js";
import { evalOptions, finish, thresholdsFrom, type Renderable } from "./common.js";

export const PROGRESS_HELP = `usage: jev-axi progress --job "<task>" [--staged | --range <a..b> | --file <patch>] [--log <file>] [--events <json>]
Is the job done? Scores the diff (and recent test or build output, when given) against the task: implementation
complete, tests sufficient, requirements satisfied, needs verification. A fixed policy turns the scores into a verdict.
Defaults to everything changed since HEAD, untracked files included. The diff is cut to ${PROGRESS_THRESHOLDS.diffChars} chars, the log to its last ${PROGRESS_THRESHOLDS.outputChars}.
With --events it also scores the worker: meaningful progress, stuck, off track, needs a person.
verdict: finish, verify (done but untested or unrun), continue (unfinished or unclear); with --events also
         steer (stuck or off track) and escalate (a person is needed), which take precedence
exit code: 0 for finish, 3 otherwise, so scripts can gate on it
flags:
  --job <text|path>    the task as it was given; a file path is read
  --log <file>         test or build output; piped stdin is used when not given
  --events <file>      recent tool calls, oldest first, as a JSON array of {tool, input, result}; the last ${PROGRESS_THRESHOLDS.events} are used
  --staged, --range <a..b>, --file <patch>   pick the diff, as in \`jev-axi diff\`
examples:
  npm test 2>&1 | jev-axi progress --job "add a --json flag to the list command"
  jev-axi progress --job TASK.md --range main..HEAD --log test.log
install as agent hooks: jev-axi setup supervise   (see \`jev-axi hook --help\`)
`;

export async function progressCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--job": "value", "--log": "value", "--events": "value", "--staged": "bool", "--range": "value", "--file": "value" }, "progress");
  if (p.positional.length) throw validation(`unexpected argument ${JSON.stringify(p.positional[0])}`, ['Pass the task with --job "<task>"']);
  const jobArg = p.values["--job"];
  if (!jobArg || jobArg.trim() === "") throw validation("progress needs the task it should judge against", ['jev-axi progress --job "<task>"']);
  const job = existsSync(jobArg) ? readFileSync(jobArg, "utf8") : jobArg;
  const logFile = p.values["--log"];
  if (logFile !== undefined && !existsSync(logFile)) throw validation(`log file not found: ${logFile}`);
  const output = logFile !== undefined ? readFileSync(logFile, "utf8") : readImplicitStdin("optional");

  const events = p.values["--events"] === undefined ? undefined : readEvents(p.values["--events"]);

  const explicit = p.bools["--staged"] || p.values["--range"] !== undefined || p.values["--file"] !== undefined;
  const diff = explicit ? loadDiff({ staged: p.bools["--staged"], range: p.values["--range"], file: p.values["--file"] }).text : workDiff(process.cwd());
  if (diff === undefined) throw validation("not inside a git repository", ["Pass the changes with --file <patch>"]);

  const a = await assess({ job, diff, output, events }, evalOptions(p, "progress"));
  const t = thresholdsFrom(p);
  if (a.verdict !== "finish") process.exitCode = 3;
  const help: string[] = [];
  if (diff.trim() === "") help.push("The diff is empty; pass --range <a..b> if the work is already committed");
  if (!output) help.push("No test or build output was given; pipe it in or pass --log <file> so verification can be judged");
  if (diff.length > PROGRESS_THRESHOLDS.diffChars) help.push(`The diff was cut to ${PROGRESS_THRESHOLDS.diffChars} of ${diff.length} chars; judge a narrower --range for large changes`);
  return finish(
    p,
    {
      verdict: a.verdict,
      reason: a.reason,
      scores: Object.entries(a.scores).map(([question, p_yes]) => ({ question, p_yes, band: bandForNoul(p_yes, t) })),
    },
    [a.result],
    help,
  );
}

function readEvents(file: string): SessionEvent[] {
  if (!existsSync(file)) throw validation(`events file not found: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw validation(`events file is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw validation("events must be a JSON array of {tool, input, result}");
  const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  return parsed.map((e: any) => ({ tool: text(e?.tool), input: text(e?.input).slice(0, PROGRESS_THRESHOLDS.eventChars), result: text(e?.result).slice(-PROGRESS_THRESHOLDS.eventChars) }));
}
