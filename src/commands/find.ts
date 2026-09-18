import { existsSync, readFileSync } from "node:fs";
import type { Renderable as AxiRenderable } from "./common.js";
import { numberFlag, parseArgs } from "../args.js";
import { bandForNoul } from "../bands.js";
import { evaluate, type ChoiceAnswer, type EvalResult, type NoulAnswer } from "../client.js";
import { validation } from "../errors.js";
import { oneLine, round } from "../format.js";
import { estimateTokens, MAX_CHOICE_OPTIONS, STATE_TOKEN_BUDGET } from "../items.js";
import { readImplicitStdin, readStdinSync, isStdinTTY } from "../stdin.js";
import { mapLimit, requestConcurrency } from "../concurrency.js";
import { evalOptions, finish, quote, thresholdsFrom } from "./common.js";

export const FIND_HELP = `usage: jev-axi find "<question>" <file|-> [--top N] [--context N]
Semantic grep: which line of a file best answers the question, plus whether the file answers it at all.
Lines are tagged with ids and searched in windows of 255; results are merged across windows.
flags:
  --top <n>            lines to show (default 5)
  --context <n>        extra lines of context around each hit (default 0)
  --min <p>            hide lines below this probability (default 0.01)
examples:
  jev-axi find "where is the retry delay decided?" src/net.ts
  jev-axi find "the first real error, not a warning" build.log --top 3
  git log --oneline -200 | jev-axi find "the commit that introduced the flaky test" -
`;

export async function findCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, { "--top": "value", "--context": "value", "--min": "value" }, "find");
  const q = p.positional[0];
  if (!q || q.trim() === "") throw validation("find needs a question as its first argument", ['jev-axi find "<question>" <file>']);
  const src = p.positional[1];
  if (p.positional.length > 2) throw validation(`unexpected argument ${JSON.stringify(p.positional[2])}`, ["find takes one file; use `jev-axi rank` across many files"]);
  const top = numberFlag(p, "--top", 5, 1);
  const context = numberFlag(p, "--context", 0, 0, 20);
  const min = numberFlag(p, "--min", 0.01, 0, 1);

  let text: string;
  let label: string;
  if (src === undefined || src === "-") {
    const piped = src === "-" ? (isStdinTTY() ? undefined : readStdinSync()) : readImplicitStdin();
    if (piped === undefined || piped.trim() === "") throw validation(src === "-" ? "`-` was given but stdin is empty" : "find needs a file or piped input", ['Pass a file: jev-axi find "<question>" src/app.ts', "Or pipe text: cat build.log | jev-axi find \"<question>\""]);
    text = piped;
    label = "stdin";
  } else {
    if (!existsSync(src)) throw validation(`file not found: ${src}`);
    text = readFileSync(src, "utf8");
    label = src;
  }
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) throw validation(`${label} is empty`);
  const t = thresholdsFrom(p);

  // Windows: at most 255 lines and within the token budget each.
  const windows: { start: number; lines: string[] }[] = [];
  let cur: string[] = [];
  let curStart = 0;
  let tokens = 0;
  lines.forEach((line, i) => {
    const lt = estimateTokens(line) + 4;
    if (cur.length > 0 && (cur.length >= MAX_CHOICE_OPTIONS || tokens + lt > STATE_TOKEN_BUDGET)) {
      windows.push({ start: curStart, lines: cur });
      cur = [];
      curStart = i;
      tokens = 0;
    }
    cur.push(line);
    tokens += lt;
  });
  if (cur.length) windows.push({ start: curStart, lines: cur });

  const results: EvalResult[] = [];
  const scored: { line: number; p: number }[] = [];
  let existsMax = 0;
  const idFor = (w: { start: number }) => (i: number) => `L${String(w.start + i + 1).padStart(4, "0")}`;
  const responses = await mapLimit(windows, requestConcurrency(), (w) => {
    const id = idFor(w);
    const doc = w.lines.map((l, i) => `${id(i)}| ${l}`).join("\n");
    return evaluate(
      doc,
      {
        where: {
          type: "choice",
          instructions: `Each line of the document starts with its id. Which line best answers: ${quote(q)}?`,
          criteria: Object.fromEntries(w.lines.map((_, i) => [id(i), null])),
        },
        exists: {
          type: "noul",
          instructions: `Does any line of the document address or answer: ${quote(q)}?`,
          criteria: { true: "At least one line states or directly implies the answer", false: "No line addresses this" },
        },
      },
      evalOptions(p, "find"),
    );
  });
  for (const [wi, w] of windows.entries()) {
    const id = idFor(w);
    const r = responses[wi]!;
    results.push(r);
    const where = r.answers["where"] as ChoiceAnswer;
    const exists = (r.answers["exists"] as NoulAnswer).noul;
    existsMax = Math.max(existsMax, exists);
    const weight = windows.length > 1 ? exists : 1;
    w.lines.forEach((_, i) => scored.push({ line: w.start + i + 1, p: (where.probabilities[id(i)] ?? 0) * weight }));
  }
  // p stays where × exists, never renormalized across windows: a line's score
  // and the meaning of --min must not depend on how large the file is.
  const hits = scored
    .filter((x) => x.p >= min)
    .sort((a, b) => b.p - a.p)
    .slice(0, top);

  const rows = hits.map((h) => {
    const row: Record<string, unknown> = { p: round(h.p, 3), line: h.line, text: oneLine(lines[h.line - 1] ?? "", 100) };
    if (context > 0) {
      const from = Math.max(1, h.line - context);
      const to = Math.min(lines.length, h.line + context);
      row["context"] = lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`);
    }
    return row;
  });
  const out: Record<string, unknown> = {
    question: q,
    file: label,
    answer_exists: round(existsMax, 2),
    band: bandForNoul(existsMax, t),
    count: `${rows.length} shown of ${lines.length} lines${windows.length > 1 ? ` in ${windows.length} calls` : ""}`,
    hits: rows.length ? rows : `0 lines above --min ${min}`,
  };
  const help: string[] = [];
  if (existsMax < 0.35) help.push("Low answer_exists: this file probably does not answer the question");
  if (context === 0 && rows.length) help.push("Add --context 3 to see surrounding lines");
  return finish(p, out, results, help);
}
