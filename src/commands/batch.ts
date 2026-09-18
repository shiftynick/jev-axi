import type { Renderable as AxiRenderable } from "./common.js";
import { numberFlag, parseArgs } from "../args.js";
import { bandForNoul } from "../bands.js";
import { evaluate, type ChoiceAnswer, type EvalResult, type NoulAnswer } from "../client.js";
import { validation } from "../errors.js";
import { oneLine, round } from "../format.js";
import { chunkItems, gatherItems, itemsState, type Item } from "../items.js";
import { mapLimit, requestConcurrency } from "../concurrency.js";
import { evalOptions, finish, quote, thresholdsFrom } from "./common.js";

export const RANK_HELP = `usage: jev-axi rank "<query>" [paths|dirs|-]... [--top N] [--preview CHARS] [--min P]
Rank items by how well they match a query, plus a yes/no on whether anything matches at all.
Items are files, every file under a directory, or stdin lines / JSONL. Sets over 255 items or the token budget are chunked automatically.
flags:
  --top <n>            rows to show (default 10)
  --preview <chars>    text per item sent to the model (default 600)
  --min <p>            hide rows below this probability (default 0.005)
examples:
  jev-axi rank "handles retry backoff for HTTP calls" src/
  jev-axi rank "which test covers the auth middleware" test/ --top 5
  gh-axi issue list --json | jev-axi rank "duplicate of: login page hangs on submit" -
`;

export const FILTER_HELP = `usage: jev-axi filter "<predicate>" [paths|dirs|-]... [--min P] [--all] [--preview CHARS]
Ask one yes/no question per item and keep those whose probability is at or above --min.
flags:
  --min <p>            keep threshold (default 0.5)
  --all                show rejected items too
  --preview <chars>    text per item sent to the model (default 600)
examples:
  jev-axi filter "this file contains a TODO that describes a bug, not a feature" src/
  cat errors.log | jev-axi filter "this log line is a real error, not a warning or noise" - --min 0.7
`;

const ITEM_FLAGS = { "--top": "value", "--preview": "value", "--min": "value", "--all": "bool" } as const;

function query(p: { positional: string[] }, cmd: string): { q: string; sources: string[] } {
  const q = p.positional[0];
  if (!q || q.trim() === "") throw validation(`${cmd} needs a query as its first argument`, [`jev-axi ${cmd} "<query>" <paths...>`]);
  return { q, sources: p.positional.slice(1) };
}

export async function rankCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, ITEM_FLAGS, "rank");
  const { q, sources } = query(p, "rank");
  const top = numberFlag(p, "--top", 10, 1);
  const preview = numberFlag(p, "--preview", 600, 50);
  const min = numberFlag(p, "--min", 0.005, 0, 1);
  const items = gatherItems(sources, { preview });
  if (items.length === 0) throw validation("0 items found in the given sources");
  if (items.length === 1) throw validation("rank needs at least 2 items", ["Use `jev-axi check` to ask a yes/no question about one item"]);
  const t = thresholdsFrom(p);
  const chunks = chunkItems(items);
  const results: EvalResult[] = [];
  const scored: { item: Item; p: number }[] = [];
  let existsMax = 0;
  const responses = await mapLimit(chunks, requestConcurrency(), (chunk) =>
    evaluate(
      itemsState(chunk),
      {
        where: {
          type: "choice",
          instructions: `Each option is the id of an item in the state; read its \`label\` and \`text\`. Which item is most relevant to: ${quote(q)}?`,
          criteria: Object.fromEntries(chunk.map((i) => [i.id, null])),
        },
        exists: {
          type: "noul",
          instructions: `Is at least one item in the state clearly relevant to: ${quote(q)}?`,
        },
      },
      evalOptions(p, "rank"),
    ),
  );
  for (const [ci, chunk] of chunks.entries()) {
    const r = responses[ci]!;
    results.push(r);
    const where = r.answers["where"] as ChoiceAnswer;
    const exists = (r.answers["exists"] as NoulAnswer).noul;
    existsMax = Math.max(existsMax, exists);
    // Across chunks, weight each chunk's distribution by its own existence
    // probability so a chunk with no real match cannot outrank one with a hit.
    const weight = chunks.length > 1 ? exists : 1;
    for (const item of chunk) scored.push({ item, p: (where.probabilities[item.id] ?? 0) * weight });
  }
  // p stays where × exists, never renormalized across chunks: an item's score
  // and the meaning of --min must not depend on how many items were given.
  const ranked = scored.filter((x) => x.p >= min).sort((a, b) => b.p - a.p);
  const shown = ranked.slice(0, top);
  const rows = shown.map((x, i) => ({ rank: i + 1, p: round(x.p, 3), item: x.item.label, preview: oneLine(x.item.text, 60) }));
  const out: Record<string, unknown> = {
    query: q,
    match_exists: round(existsMax, 2),
    band: bandForNoul(existsMax, t),
    count: `${shown.length} shown of ${items.length} items${chunks.length > 1 ? ` in ${chunks.length} calls` : ""}`,
    ranked: rows,
  };
  const help: string[] = [];
  if (existsMax < 0.35) help.push("Low match_exists: probably nothing here matches; treat the ranking as weak");
  if (ranked.length > shown.length) help.push(`Run with --top ${Math.min(ranked.length, 50)} for more rows`);
  if (rows.length === 0) out["ranked"] = "0 items above --min";
  return finish(p, out, results, help);
}

export async function filterCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, ITEM_FLAGS, "filter");
  const { q, sources } = query(p, "filter");
  const min = numberFlag(p, "--min", 0.5, 0, 1);
  const preview = numberFlag(p, "--preview", 600, 50);
  const items = gatherItems(sources, { preview });
  if (items.length === 0) throw validation("0 items found in the given sources");
  const t = thresholdsFrom(p);
  // Nouls have no 255 cap, but keep chunks moderate so questions fit the budget.
  const chunks = chunkItems(items, 120);
  const results: EvalResult[] = [];
  const scored: { item: Item; p: number }[] = [];
  const responses = await mapLimit(chunks, requestConcurrency(), (chunk) => {
    const questions = Object.fromEntries(
      chunk.map((i) => [
        i.id,
        { type: "noul" as const, instructions: `Considering only item \`${i.id}\` in the state (its \`label\` and \`text\`): is this true of it? ${quote(q)}` },
      ]),
    );
    return evaluate(itemsState(chunk), questions, evalOptions(p, "filter"));
  });
  for (const [ci, chunk] of chunks.entries()) {
    const r = responses[ci]!;
    results.push(r);
    for (const item of chunk) scored.push({ item, p: (r.answers[item.id] as NoulAnswer).noul });
  }
  scored.sort((a, b) => b.p - a.p);
  const kept = scored.filter((x) => x.p >= min);
  const rows = (p.bools["--all"] ? scored : kept).map((x) => ({
    p: round(x.p, 3),
    band: bandForNoul(x.p, t),
    keep: x.p >= min ? "yes" : "no",
    item: x.item.label,
    preview: oneLine(x.item.text, 60),
  }));
  const out: Record<string, unknown> = {
    predicate: q,
    count: `${kept.length} kept of ${items.length} items (min ${min})${chunks.length > 1 ? `, ${chunks.length} calls` : ""}`,
    items: rows.length ? rows : `0 items at or above ${min}`,
  };
  const help: string[] = [];
  if (!p.bools["--all"] && kept.length < scored.length) help.push("Add --all to see rejected items with their probabilities");
  const unsure = scored.filter((x) => bandForNoul(x.p, t) === "escalate").length;
  if (unsure) help.push(`${unsure} item(s) are near 0.5 (escalate band); review those by hand`);
  return finish(p, out, results, help);
}
