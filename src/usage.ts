import { appendFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDir, paths, resolvePrices, type Prices } from "./config.js";

export interface BandCounts {
  act: number;
  confirm: number;
  escalate: number;
}

export interface UsageEntry {
  ts: string;
  cmd: string;
  model: string;
  /** null means the API did not report the token count. */
  in: number | null;
  out: number | null;
  ms: number;
  q: number;
  cached: boolean;
  /** Git root or working directory name, for per-project trends. */
  project?: string;
  /** How confident the answers were, so trends can show question quality over time. */
  bands?: BandCounts;
}

/** Name of the enclosing git repository, or the working directory. */
export function projectName(cwd = process.cwd()): string {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return basename(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return basename(cwd) || cwd;
}

function migrateLegacyLedger(): void {
  const legacy = paths.legacyUsageLedger();
  const current = paths.usageLedger();
  if (existsSync(legacy) && !existsSync(current)) {
    ensureDir(paths.statsDir());
    try {
      renameSync(legacy, current);
    } catch {
      appendFileSync(current, readFileSync(legacy, "utf8"));
    }
  }
}

export function recordUsage(entry: UsageEntry): void {
  try {
    ensureDir(paths.statsDir());
    migrateLegacyLedger();
    appendFileSync(paths.usageLedger(), JSON.stringify(entry) + "\n");
  } catch {
    // The ledger is best-effort; never fail a command because of it.
  }
}

export function readUsage(days?: number, now = new Date()): UsageEntry[] {
  migrateLegacyLedger();
  const file = paths.usageLedger();
  if (!existsSync(file)) return [];
  const cutoff = days === undefined ? 0 : now.getTime() - days * 86_400_000;
  const entries: UsageEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as UsageEntry;
      if (new Date(e.ts).getTime() >= cutoff) entries.push(e);
    } catch {
      // skip corrupt lines
    }
  }
  return entries;
}

export interface UsageTotals {
  calls: number;
  billed_calls: number;
  cached_calls: number;
  input: number | null;
  output: number | null;
  saved_input: number | null;
  saved_output: number | null;
  questions: number;
  ms: number;
}

export function totals(entries: UsageEntry[]): UsageTotals {
  const t: UsageTotals = {
    calls: 0,
    billed_calls: 0,
    cached_calls: 0,
    input: 0,
    output: 0,
    saved_input: 0,
    saved_output: 0,
    questions: 0,
    ms: 0,
  };
  for (const e of entries) {
    t.calls++;
    t.questions += e.q;
    t.ms += e.ms;
    if (e.cached) {
      t.cached_calls++;
      t.saved_input = sumTokens(t.saved_input, e.in);
      t.saved_output = sumTokens(t.saved_output, e.out);
    } else {
      t.billed_calls++;
      t.input = sumTokens(t.input, e.in);
      t.output = sumTokens(t.output, e.out);
    }
  }
  return t;
}

export type GroupBy = "command" | "day" | "model" | "project";

export function groupUsage(entries: UsageEntry[], by: GroupBy): Map<string, UsageEntry[]> {
  const groups = new Map<string, UsageEntry[]>();
  for (const e of entries) {
    const key = by === "command" ? e.cmd : by === "model" ? e.model : by === "project" ? (e.project ?? "unknown") : e.ts.slice(0, 10);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  return groups;
}

/** A total is unknown if any of its counts were not reported. */
export function sumTokens(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/** Estimated USD cost using configured prices, falling back to the defaults. */
export function estimateCost(input: number | null, output: number | null, price?: Prices): number | null {
  const p = price === undefined ? resolvePrices() : { input: price.input ?? resolvePrices().input, output: price.output ?? resolvePrices().output };
  if ((input === null && p.input !== 0) || (output === null && p.output !== 0)) return null;
  return ((input ?? 0) * p.input + (output ?? 0) * p.output) / 1_000_000;
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "unknown";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(n: number | null): string {
  if (n === null) return "unknown";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export interface DayPoint {
  day: string;
  calls: number;
  questions: number;
  input: number | null;
  cost: number | null;
}

/** One point per calendar day (UTC) for the last `days` days, zero-filled. */
export function dailySeries(entries: UsageEntry[], days: number, now = new Date()): DayPoint[] {
  const byDay = groupUsage(entries, "day");
  const out: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const list = byDay.get(d) ?? [];
    const t = totals(list);
    out.push({ day: d, calls: t.calls, questions: t.questions, input: t.input, cost: estimateCost(t.input, t.output) });
  }
  return out;
}

const BARS = "▁▂▃▄▅▆▇█";

/** Unicode sparkline; an all-zero series renders as flat baseline. */
export function sparkline(values: (number | null)[]): string {
  const max = Math.max(...values.filter((v): v is number => v !== null), 0);
  return values.map((v) => v === null ? "?" : BARS[max === 0 ? 0 : Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))]).join("");
}

/** "+12%" / "-5%" / "new" / "flat" comparing a period against the one before it. */
export function trendLabel(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return "unknown";
  if (previous === 0) return current === 0 ? "flat" : "new";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "flat";
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

export function sumBands(entries: UsageEntry[]): BandCounts {
  const b: BandCounts = { act: 0, confirm: 0, escalate: 0 };
  for (const e of entries) {
    if (!e.bands) continue;
    b.act += e.bands.act;
    b.confirm += e.bands.confirm;
    b.escalate += e.bands.escalate;
  }
  return b;
}
