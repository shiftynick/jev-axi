import { numberFlag, parseArgs } from "../args.js";
import { bandForNoul } from "../bands.js";
import { evaluate, type ChoiceAnswer, type EvalResult, type NoulAnswer } from "../client.js";
import { validation } from "../errors.js";
import { oneLine, round } from "../format.js";
import { chunkItems, gatherItems, itemsState, MAX_CHOICE_OPTIONS, type Item } from "../items.js";
import { mapLimit, requestConcurrency } from "../concurrency.js";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { FILES_PATH_QUESTION, FILES_QUESTIONS } from "../recipes/questions.js";
import { evalOptions, finish, thresholdsFrom, type Renderable } from "./common.js";

/** Above this many files, rank paths first and only read the shortlist. */
const PATH_PASS_THRESHOLD = 120;

export const FILES_HELP = `usage: jev-axi files "<task>" [dirs|paths]... [--top N] [--preview CHARS] [--shortlist N] [--no-docs]
Which files would a developer open or change for a task. Ranks source files under the given dirs (default: .)
by the start of their contents; run this before reading files yourself.
Large sets are shortlisted by path first, so only likely files are read in full. Markdown under the repository's
docs/ directory is included automatically, since design docs often hold the answer.
flags:
  --top <n>            rows to show (default 8)
  --preview <chars>    text per file sent to the model, after leading imports (default 700)
  --shortlist <n>      files kept after the path-only pass when there are more than ${PATH_PASS_THRESHOLD} (default 60)
  --no-docs            don't add the repository's docs/ directory
examples:
  jev-axi files "add a --json flag to the list command"
  jev-axi files "why does login redirect loop" src/ app/
`;

/** The repository's docs/ directory, if the sources don't already include it. */
function docsSource(sources: string[]): string | undefined {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 40; i++) {
    const docs = join(dir, "docs");
    if (existsSync(docs) && statSync(docs).isDirectory()) {
      const covered = sources.some((s) => {
        const abs = resolve(s);
        return abs === docs || abs.startsWith(docs + sep) || docs.startsWith(abs + sep) || abs === dir;
      });
      return covered ? undefined : docs;
    }
    if (existsSync(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export async function filesCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--top": "value", "--preview": "value", "--shortlist": "value", "--no-docs": "bool" }, "files");
  const task = p.positional[0];
  if (!task || task.trim() === "") throw validation("files needs a task description as its first argument", ['jev-axi files "<task>" [dirs...]']);
  const sources = p.positional.length > 1 ? p.positional.slice(1) : ["."];
  const top = numberFlag(p, "--top", 8, 1);
  const preview = numberFlag(p, "--preview", 700, 50);
  const shortlistSize = numberFlag(p, "--shortlist", 60, 10);
  let items = gatherItems(sources, { preview });
  const docs = p.bools["--no-docs"] ? undefined : docsSource(sources);
  if (docs) {
    const docItems = gatherItems([docs], { preview }).filter((i) => /\.mdx?$/i.test(i.label));
    items = [...items, ...docItems].map((item, i) => ({ ...item, id: `I${String(i + 1).padStart(4, "0")}` }));
  }
  if (items.length < 2) throw validation(`only ${items.length} file(s) found under ${sources.join(", ")}`);
  const t = thresholdsFrom(p);
  const results: EvalResult[] = [];

  // Pass 1: rank by path alone. Paths are ~15 tokens each, so a few thousand files cost a few calls.
  let candidates = items;
  let shortlisted = false;
  if (items.length > PATH_PASS_THRESHOLD) {
    const pathChunks: Item[][] = [];
    for (let i = 0; i < items.length; i += MAX_CHOICE_OPTIONS) pathChunks.push(items.slice(i, i + MAX_CHOICE_OPTIONS));
    const pathResponses = await mapLimit(pathChunks, requestConcurrency(), (chunk) =>
      evaluate(
        Object.fromEntries(chunk.map((i) => [i.id, i.label])),
        FILES_PATH_QUESTION(task, chunk.map((i) => i.id)),
        evalOptions(p, "files"),
      ),
    );
    const byPath: { item: Item; p: number }[] = [];
    pathChunks.forEach((chunk, ci) => {
      const r = pathResponses[ci]!;
      results.push(r);
      const where = r.answers["where"] as ChoiceAnswer;
      // Each chunk's distribution sums to 1; scale by chunk size so chunks are comparable.
      for (const item of chunk) byPath.push({ item, p: (where.probabilities[item.id] ?? 0) * chunk.length });
    });
    byPath.sort((a, b) => b.p - a.p);
    // Keep the global top plus each chunk's best few, so one strong chunk can't crowd out the rest.
    const keep = new Set(byPath.slice(0, shortlistSize).map((x) => x.item.id));
    pathChunks.forEach((chunk, ci) => {
      const where = (pathResponses[ci]!.answers["where"] as ChoiceAnswer).probabilities;
      chunk
        .map((item) => ({ id: item.id, p: where[item.id] ?? 0 }))
        .sort((a, b) => b.p - a.p)
        .slice(0, 3)
        .forEach((x) => keep.add(x.id));
    });
    candidates = items.filter((i) => keep.has(i.id));
    shortlisted = true;
  }

  // Pass 2: rank the candidates by path and the start of their contents.
  const chunks = chunkItems(candidates);
  const responses = await mapLimit(chunks, requestConcurrency(), (chunk) =>
    evaluate(itemsState(chunk), FILES_QUESTIONS(task, chunk.map((i) => i.id)), evalOptions(p, "files")),
  );
  const scored: { item: Item; p: number }[] = [];
  let existsMax = 0;
  chunks.forEach((chunk, ci) => {
    const r = responses[ci]!;
    results.push(r);
    const where = r.answers["where"] as ChoiceAnswer;
    const exists = (r.answers["exists"] as NoulAnswer).noul;
    existsMax = Math.max(existsMax, exists);
    const weight = chunks.length > 1 ? exists : 1;
    for (const item of chunk) scored.push({ item, p: (where.probabilities[item.id] ?? 0) * weight });
  });
  // p stays where × exists, never renormalized across chunks, so the cutoff
  // below means the same thing in a small repo and a large one.
  const ranked = [...scored].sort((a, b) => b.p - a.p);
  const shown = ranked.slice(0, top).filter((x) => x.p >= 0.005);
  const out: Record<string, unknown> = {
    task,
    relevant_file_exists: round(existsMax, 2),
    band: bandForNoul(existsMax, t),
    count: `${shown.length} shown of ${items.length} files${docs ? " (docs included)" : ""}${shortlisted ? `, ${candidates.length} shortlisted by path` : ""}, ${results.length} calls`,
    files: shown.map((x, i) => ({ rank: i + 1, p: round(x.p, 3), file: x.item.label, preview: oneLine(x.item.text, 50) })),
  };
  const help: string[] = [];
  if (existsMax < 0.35) help.push("Low relevant_file_exists: the task may live outside these directories");
  if (shortlisted && existsMax < 0.35) help.push(`Only ${candidates.length} of ${items.length} files were read in full; rerun with a larger --shortlist or narrower dirs`);
  if (shown.length) help.push(`Open the top file(s) first; run \`jev-axi find "<question>" <file>\` to locate the exact lines`);
  return finish(p, out, results, help);
}
