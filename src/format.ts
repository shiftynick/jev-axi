import { bandForConfidence, bandForNoul, noulConfidence, type Band } from "./bands.js";
import type { Answer, EvalResult } from "./client.js";
import type { Thresholds } from "./config.js";
import { estimateCost, formatCost, sumTokens } from "./usage.js";

export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export interface AnswerRow {
  id: string;
  type: Answer["type"];
  answer: string | number;
  confidence: number;
  band: Band;
}

export function answerRow(id: string, a: Answer, t: Thresholds): AnswerRow {
  switch (a.type) {
    case "choice":
      return { id, type: a.type, answer: a.choice, confidence: round(a.confidence), band: bandForConfidence(a.confidence, t) };
    case "score":
      return { id, type: a.type, answer: round(a.score), confidence: round(a.confidence), band: bandForConfidence(a.confidence, t) };
    case "noul":
      return { id, type: a.type, answer: round(a.noul, 3), confidence: round(noulConfidence(a.noul)), band: bandForNoul(a.noul, t) };
  }
}

/** Probability distribution as rows, highest first. */
export function distributionRows(a: Answer, limit?: number): Record<string, unknown>[] {
  if (a.type === "noul") return [{ yes: round(a.noul, 3), no: round(1 - a.noul, 3) }];
  const entries = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  const rows =
    a.type === "choice"
      ? entries.map(([option, p]) => ({ option, p: round(p, 3) }))
      : entries.map(([level, p]) => ({ level: Number(level), p: round(p, 3), label: a.legend[level] ?? "" }));
  return limit === undefined ? rows : rows.slice(0, limit);
}

/** One compact line the agent can read at a glance: tokens, latency, model, cost when known. */
export function usageLine(r: EvalResult): string {
  const cost = estimateCost(r.usage.input_tokens, r.usage.output_tokens);
  const parts = [`${r.usage.input_tokens ?? "?"}in/${r.usage.output_tokens ?? "?"}out`, r.cached ? "cached" : `${r.ms}ms`, r.model, r.cached ? `saved ${formatCost(cost)}` : formatCost(cost)];
  return parts.join(" ");
}

export function mergedUsageLine(results: EvalResult[]): string {
  if (results.length === 1) return usageLine(results[0]!);
  const input = results.reduce<number | null>((s, r) => sumTokens(s, r.usage.input_tokens), 0);
  const output = results.reduce<number | null>((s, r) => sumTokens(s, r.usage.output_tokens), 0);
  const ms = results.reduce((s, r) => s + r.ms, 0);
  const cached = results.filter((r) => r.cached).length;
  const cost = estimateCost(input, output);
  return [`${input ?? "?"}in/${output ?? "?"}out`, `${ms}ms`, `${results.length} calls${cached ? ` (${cached} cached)` : ""}`, results[0]!.model, formatCost(cost)].join(" ");
}

export function truncate(text: string, max: number): { text: string; truncated: boolean; total: number } {
  const total = text.length;
  if (total <= max) return { text, truncated: false, total };
  return { text: text.slice(0, max), truncated: true, total };
}

/** Collapse whitespace so a preview fits on one TOON row. */
export function oneLine(text: string, max = 100): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
