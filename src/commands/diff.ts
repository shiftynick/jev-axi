import { parseArgs } from "../args.js";
import { bandForConfidence } from "../bands.js";
import { evaluate, type ChoiceAnswer, type EvalOptions, type EvalResult, type NoulAnswer, type ScoreAnswer } from "../client.js";
import type { Thresholds } from "../config.js";
import { validation } from "../errors.js";
import { round } from "../format.js";
import { isTestPath, loadDiff, parseDiff, scanAddedLines, scanPossibleSecrets, testStem, type FileDiff } from "../git.js";
import { estimateTokens, STATE_TOKEN_BUDGET } from "../items.js";
import { DIFF_OVERALL, DIFF_PER_FILE, DIFF_THRESHOLDS } from "../recipes/questions.js";
import { isStdinTTY, readImplicitStdin, readStdinSync } from "../stdin.js";
import { mapLimit, requestConcurrency } from "../concurrency.js";
import { redactSecrets } from "../safety.js";
import { evalOptions, finish, thresholdsFrom, type Renderable } from "./common.js";

export const DIFF_HELP = `usage: jev-axi diff [--staged | --range <a..b> | --file <patch> | -]
Review a diff before committing: per-file risk, missing tests, secrets, debug leftovers, plus overall scope and kind.
Credentials in known formats are detected locally and redacted before anything is sent.
Vendor token formats and private keys block; looser shapes (auth headers, URL passwords, PASSWORD= values) flag possible-secret for review.
Defaults to unstaged working-tree changes. Files are chunked to the token budget; large patches are truncated to ${DIFF_THRESHOLDS.patchChars} chars.
flags:
  --staged             review the index (what \`git commit\` would include)
  --range <a..b>       review commits, e.g. main..HEAD
  --file <patch>       review a unified diff file; or pipe one on stdin
  --full               show every file, not only flagged ones
examples:
  jev-axi diff --staged
  jev-axi diff --range main..HEAD
  git diff HEAD~3 | jev-axi diff -
`;

export interface FileVerdict {
  file: string;
  "+/-": string;
  risk: number;
  band: string;
  flags: string;
}

export async function diffCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--staged": "bool", "--range": "value", "--file": "value" }, "diff");
  const explicitStdin = p.positional[0] === "-";
  if (p.positional.length > (explicitStdin ? 1 : 0)) throw validation(`unexpected argument ${JSON.stringify(p.positional[explicitStdin ? 1 : 0])}`, ["Use --staged, --range <a..b>, --file <patch>, or pipe a diff"]);
  const sourceFlags = p.bools["--staged"] || p.values["--range"] !== undefined || p.values["--file"] !== undefined;
  let stdin: string | undefined;
  if (explicitStdin) {
    stdin = isStdinTTY() ? undefined : readStdinSync();
    if (!stdin || stdin.trim() === "") throw validation("`diff -` needs a diff piped on stdin", ["git diff | jev-axi diff -", "Run `jev-axi diff` with no arguments to review working-tree changes"]);
  } else if (!sourceFlags) {
    // A piped diff wins; otherwise review the working tree (agents run with empty stdin).
    stdin = readImplicitStdin();
  }
  const { text, label } = loadDiff({
    staged: p.bools["--staged"],
    range: p.values["--range"],
    file: p.values["--file"],
    stdin,
  });
  const files = parseDiff(text);
  if (files.length === 0) {
    const next = label === "working tree changes" ? ["Run `jev-axi diff --staged` for staged changes or `--range main..HEAD` for commits"] : label === "staged changes" ? ["Run `jev-axi diff` for unstaged working-tree changes"] : [];
    return finish(p, { diff: label, files: "0 changed files; nothing to review" }, [], next);
  }
  const review = await reviewFiles(files, evalOptions(p, "diff"), thresholdsFrom(p));
  const { verdicts, flagged, overall, results, chunks, testFiles, scopeLevel, verdict } = review;
  const shown = p.bools["--full"] ? verdicts : flagged.length ? flagged : verdicts.slice(0, 5);
  const scopeLabel = ["focused", "mostly focused", "several unrelated changes"][scopeLevel];
  const secretsHit = verdict === "block";

  const out: Record<string, unknown> = {
    diff: label,
    verdict,
    kind: overall.kind ? `${overall.kind.choice} (${round(overall.kind.confidence)})` : "unknown",
    scope: overall.scope ? `${scopeLabel} (${round(overall.scope.score)} of 0..2)` : "unknown",
    count: `${flagged.length} flagged of ${files.length} files (${testFiles} test files)${chunks > 1 ? ` in ${chunks} calls` : ""}`,
    files: shown,
  };
  const help: string[] = [];
  if (secretsHit) help.push("A file appears to add a real credential; remove it before committing");
  if (flagged.some((v) => v.flags.includes("possible-secret"))) help.push("possible-secret: an added line looks like a credential (auth header, URL password, or PASSWORD=/TOKEN= value); it was redacted, so check it yourself");
  if (flagged.some((v) => v.flags.includes("needs-test"))) help.push("needs-test: behavior changed with no test change in the diff");
  if (scopeLevel === 2) help.push("Consider splitting this into separate commits or PRs");
  if (!p.bools["--full"] && shown.length < verdicts.length) help.push(`Add --full to see all ${verdicts.length} files`);
  return finish(p, out, results, help);
}

export interface DiffReview {
  verdicts: FileVerdict[];
  flagged: FileVerdict[];
  overall: { scope?: ScoreAnswer; kind?: ChoiceAnswer };
  results: EvalResult[];
  chunks: number;
  testFiles: number;
  /** 0 focused, 1 mostly focused, 2 several unrelated changes. */
  scopeLevel: number;
  /** block when a file appears to add a credential, review when anything is flagged. */
  verdict: "ok" | "review" | "block";
}

/** Review parsed file diffs: per-file risk and flags plus overall scope and kind, highest risk first. */
export async function reviewFiles(files: FileDiff[], options: EvalOptions, t: Thresholds): Promise<DiffReview> {
  // When the diff carries test files, a source file's tests are probably among them, so the
  // per-file "no test in this patch" signal is weaker; require a stronger noul before flagging.
  const testFiles = files.filter((f) => isTestPath(f.path)).length;
  // A source file whose matching test file is in the same diff is covered, whatever its own patch says.
  const testedStems = new Set(files.filter((f) => isTestPath(f.path)).map((f) => testStem(f.path)));
  const needsTestFlag = testFiles > 0 ? DIFF_THRESHOLDS.flagWhenTestsPresent : DIFF_THRESHOLDS.flag;

  // Credentials never leave the machine: known formats are found locally and redacted before sending.
  const localSecrets = new Set(scanAddedLines(files).map((h) => h.file));
  // Looser shapes are redacted too, so the model cannot judge them: report them here, as review rather than block.
  const possibleSecrets = new Set(scanPossibleSecrets(files).map((h) => h.file));
  // Chunk files to the budget, truncating oversized patches.
  const prepared = files.map((f, i) => ({ id: `F${String(i + 1).padStart(3, "0")}`, f, patch: redactSecrets(truncatePatch(f)) }));
  const chunks: typeof prepared[] = [];
  let cur: typeof prepared = [];
  let tokens = 0;
  for (const item of prepared) {
    // Each file also carries five questions (~180 tokens of instructions).
    const size = estimateTokens(item.patch) + 200;
    if (cur.length && tokens + size > STATE_TOKEN_BUDGET) {
      chunks.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(item);
    tokens += size;
  }
  if (cur.length) chunks.push(cur);

  const results: EvalResult[] = [];
  const verdicts: FileVerdict[] = [];
  let overall: DiffReview["overall"] = {};
  const responses = await mapLimit(chunks, requestConcurrency(), (chunk, ci) => {
    const state = Object.fromEntries(chunk.map((c) => [c.id, { path: c.f.path, patch: c.patch }]));
    const questions = Object.assign({}, ...chunk.map((c) => DIFF_PER_FILE(c.id)), ci === 0 ? DIFF_OVERALL : {});
    return evaluate(state, questions, options);
  });
  for (const [ci, chunk] of chunks.entries()) {
    const r = responses[ci]!;
    results.push(r);
    if (ci === 0) overall = { scope: r.answers["scope"] as ScoreAnswer, kind: r.answers["kind"] as ChoiceAnswer };
    for (const c of chunk) {
      const risk = r.answers[`${c.id}.risk`] as ScoreAnswer;
      const noul = (k: string) => (r.answers[`${c.id}.${k}`] as NoulAnswer).noul;
      const flags: string[] = [];
      if (localSecrets.has(c.f.path) || noul("secrets") >= DIFF_THRESHOLDS.flag) flags.push("secrets");
      else if (possibleSecrets.has(c.f.path)) flags.push("possible-secret");
      if (!isTestPath(c.f.path) && !testedStems.has(testStem(c.f.path)) && noul("needs_test") >= needsTestFlag) flags.push("needs-test");
      if (noul("leftovers") >= DIFF_THRESHOLDS.flag) flags.push("leftovers");
      if (risk.score >= DIFF_THRESHOLDS.highRisk) flags.push("high-risk");
      verdicts.push({
        file: c.f.path + (c.f.patch.length > DIFF_THRESHOLDS.patchChars ? " (truncated)" : ""),
        "+/-": `+${c.f.added}/-${c.f.removed}`,
        risk: round(risk.score),
        band: bandForConfidence(risk.confidence, t),
        flags: flags.join(",") || "-",
      });
    }
  }
  verdicts.sort((a, b) => b.risk - a.risk);
  const flagged = verdicts.filter((v) => v.flags !== "-");
  const scopeLevel = overall.scope ? Math.min(2, Math.max(0, Math.round(overall.scope.score))) : 0;
  const verdict = verdicts.some((v) => v.flags.includes("secrets")) ? "block" : flagged.length ? "review" : "ok";
  return { verdicts, flagged, overall, results, chunks: chunks.length, testFiles, scopeLevel, verdict };
}

function truncatePatch(f: FileDiff): string {
  const max = DIFF_THRESHOLDS.patchChars;
  if (f.patch.length <= max) return f.patch;
  return `${f.patch.slice(0, max)}\n... (truncated, ${f.patch.length} chars total)`;
}
