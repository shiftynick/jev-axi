import { existsSync, readFileSync } from "node:fs";
import { numberFlag, parseArgs } from "../args.js";
import { paths, resolvePrices } from "../config.js";
import { round } from "../format.js";
import {
  dailySeries,
  estimateCost,
  formatCost,
  formatTokens,
  groupUsage,
  projectName,
  readUsage,
  sparkline,
  sumBands,
  totals,
  trendLabel,
  type UsageEntry,
} from "../usage.js";
import { finish, type Renderable } from "./common.js";

export const STATS_HELP = `usage: jev-axi stats [--days N] [--top N] [--json]
Lifetime usage and trends from the local stats ledger in your config folder: daily activity with sparklines,
this period vs the previous one, per-command and per-project breakdowns, answer confidence, cache savings,
and a projected monthly cost. When the supervision hooks are installed, also what they judged and how often they spoke.
flags:
  --days <n>           trend window (default 30); the comparison period is the same length before it
  --top <n>            rows per breakdown (default 8)
ledger: ${paths.usageLedger()}
examples:
  jev-axi stats
  jev-axi stats --days 7
`;

export async function statsCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--days": "value", "--top": "value" }, "stats");
  const days = numberFlag(p, "--days", 30, 1, 3650);
  const top = numberFlag(p, "--top", 8, 1);
  const now = new Date();
  const all = readUsage(undefined, now);
  if (all.length === 0) {
    return finish(p, { stats: "0 calls recorded yet", ledger: paths.usageLedger() }, [], ["Every jev-axi API call is logged locally; run a few commands and come back"]);
  }
  const price = resolvePrices();
  const since = all.reduce((min, e) => (e.ts < min ? e.ts : min), all[0]!.ts).slice(0, 10);
  const lifetime = totals(all);
  const lifetimeCost = estimateCost(lifetime.input, lifetime.output);
  const lifetimeSaved = estimateCost(lifetime.saved_input, lifetime.saved_output);

  const cutoff = now.getTime() - days * 86_400_000;
  const prevCutoff = cutoff - days * 86_400_000;
  const current = all.filter((e) => new Date(e.ts).getTime() >= cutoff);
  const previous = all.filter((e) => {
    const t = new Date(e.ts).getTime();
    return t >= prevCutoff && t < cutoff;
  });
  const cur = totals(current);
  const prev = totals(previous);
  const curCost = estimateCost(cur.input, cur.output);
  const prevCost = estimateCost(prev.input, prev.output);

  const series = dailySeries(current, days, now);
  const activeDays = series.filter((d) => d.calls > 0).length;
  const sparkDays = Math.min(days, 30);
  const tail = series.slice(-sparkDays);

  const bands = sumBands(current);
  const answered = bands.act + bands.confirm + bands.escalate;
  const pct = (n: number) => (answered ? `${Math.round((n / answered) * 100)}%` : "-");

  const breakdown = (entries: UsageEntry[], by: "command" | "project") =>
    [...groupUsage(entries, by)]
      .map(([key, list]) => {
        const t = totals(list);
        const b = sumBands(list);
        const n = b.act + b.confirm + b.escalate;
        return {
          [by]: key,
          calls: t.calls,
          share: cur.calls ? `${Math.round((t.calls / cur.calls) * 100)}%` : "-",
          avg_q: t.calls ? round(t.questions / t.calls, 1) : 0,
          avg_in: t.billed_calls ? Math.round(t.input / t.billed_calls) : 0,
          avg_ms: t.billed_calls ? Math.round(t.ms / t.billed_calls) : 0,
          act: n ? `${Math.round((b.act / n) * 100)}%` : "-",
          cost: formatCost(estimateCost(t.input, t.output)),
        };
      })
      .sort((a, b) => Number(b["calls"]) - Number(a["calls"]))
      .slice(0, top);

  const biggest = all.reduce((m, e) => (e.in > m.in ? e : m), all[0]!);
  const busiest = [...groupUsage(all, "day")].map(([day, list]) => ({ day, calls: list.length })).sort((a, b) => b.calls - a.calls)[0]!;
  const dailyRate = activeDays ? cur.calls / days : 0;
  const monthly = (curCost / days) * 30;

  const out: Record<string, unknown> = {
    ledger: paths.usageLedger(),
    lifetime: `since ${since}: ${lifetime.calls} calls, ${lifetime.questions} questions, ${formatTokens(lifetime.input)} in / ${formatTokens(lifetime.output)} out, ${formatCost(lifetimeCost)} at $${price.input}/1M in${lifetime.cached_calls ? `; ${lifetime.cached_calls} cached calls saved ${formatCost(lifetimeSaved)}` : ""}`,
    window: `last ${days} days vs the ${days} before`,
    calls: `${cur.calls} (${trendLabel(cur.calls, prev.calls)}), ${activeDays} active days, ${round(dailyRate, 1)}/day`,
    questions: `${cur.questions} (${trendLabel(cur.questions, prev.questions)}), ${cur.calls ? round(cur.questions / cur.calls, 1) : 0} per call`,
    tokens: `${formatTokens(cur.input)} in (${trendLabel(cur.input, prev.input)}), ${cur.billed_calls ? Math.round(cur.input / cur.billed_calls) : 0} avg per call`,
    cost: `${formatCost(curCost)} (${trendLabel(curCost, prevCost)}), projected ${formatCost(monthly)}/month at this rate`,
    latency: `${cur.billed_calls ? Math.round(cur.ms / cur.billed_calls) : 0}ms avg (${prev.billed_calls ? trendLabel(cur.ms / Math.max(1, cur.billed_calls), prev.ms / prev.billed_calls) : "new"})`,
    cache: `${cur.calls ? Math.round((cur.cached_calls / cur.calls) * 100) : 0}% hit rate, ${formatCost(estimateCost(cur.saved_input, cur.saved_output))} saved`,
    confidence: answered ? `${answered} answers: act ${pct(bands.act)}, confirm ${pct(bands.confirm)}, escalate ${pct(bands.escalate)}` : "no band data yet",
    [`trend_calls_${sparkDays}d`]: sparkline(tail.map((d) => d.calls)),
    [`trend_cost_${sparkDays}d`]: sparkline(tail.map((d) => d.cost)),
    by_command: breakdown(current, "command"),
    by_project: breakdown(current, "project"),
    ...superviseStats(cutoff),
    records: {
      biggest_call: `${biggest.cmd} on ${biggest.ts.slice(0, 10)}: ${formatTokens(biggest.in)} in, ${biggest.q} questions, ${formatCost(estimateCost(biggest.in, biggest.out))}`,
      busiest_day: `${busiest.day}: ${busiest.calls} calls`,
    },
  };
  const help: string[] = [];
  if (answered && bands.escalate / answered > 0.25) help.push("Over a quarter of answers land in the escalate band; narrower questions or clearer criteria usually raise confidence");
  if (cur.calls && cur.questions / cur.calls < 1.5) help.push("Most calls ask a single question; batching related questions into one `ask` costs almost nothing extra");
  if (out["supervise"]) help.push("supervise: read `spoke_recently` against what really happened in those sessions before installing with --block");
  help.push(`Run \`jev-axi usage --by day\` for a day-by-day table, or \`jev-axi stats --days 7\` for a shorter window`);
  return finish(p, out, [], help);
}

const VERDICTS = ["finish", "verify", "continue", "steer", "escalate"] as const;

/** What the supervision hooks judged in the window, and the last times they interrupted. Empty when never used. */
export function superviseStats(cutoff: number, file = paths.superviseLog()): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const entries: Record<string, any>[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e.ts === "string" && new Date(e.ts).getTime() >= cutoff) entries.push(e);
    } catch {
      // skip partial lines
    }
  }
  if (entries.length === 0) return {};
  const spoke = (e: Record<string, any>) => e["action"] !== undefined && e["action"] !== "none";
  const rows = ["stop", "post-tool-use"].flatMap((hook) => {
    const list = entries.filter((e) => e["hook"] === hook);
    if (list.length === 0) return [];
    const count = (v: string) => list.filter((e) => e["verdict"] === v).length;
    return [{ hook, checks: list.length, ...Object.fromEntries(VERDICTS.map((v) => [v, count(v)])), unclear: list.filter((e) => e["unclear"]).length, spoke: list.filter(spoke).length, blocked: list.filter((e) => e["action"] === "block").length }];
  });
  const recent = entries.filter(spoke).slice(-5).reverse().map((e) => ({ when: String(e["ts"]).slice(0, 16).replace("T", " "), project: projectName(String(e["cwd"] ?? "")), hook: e["hook"], action: e["action"], reason: e["reason"] }));
  return { supervise: rows, ...(recent.length ? { spoke_recently: recent } : {}) };
}
