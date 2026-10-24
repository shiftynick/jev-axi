import type { EvalResult } from "../src/client.js";
import { describe, expect, it } from "vitest";
import { bandForConfidence, bandForNoul, noulConfidence } from "../src/bands.js";
import { chunkItems, type Item } from "../src/items.js";
import { estimateCost, formatCost, groupUsage, totals, type UsageEntry } from "../src/usage.js";
import { answerRow, distributionRows, mergedUsageLine, oneLine, usageLine } from "../src/format.js";

const T = { act: 0.75, confirm: 0.45 };

describe("bands", () => {
  it("maps confidence to act/confirm/escalate", () => {
    expect(bandForConfidence(0.9, T)).toBe("act");
    expect(bandForConfidence(0.5, T)).toBe("confirm");
    expect(bandForConfidence(0.1, T)).toBe("escalate");
  });
  it("treats confident yes and confident no the same for nouls", () => {
    expect(noulConfidence(0.95)).toBeCloseTo(0.9);
    expect(noulConfidence(0.05)).toBeCloseTo(0.9);
    expect(bandForNoul(0.5, T)).toBe("escalate");
    expect(bandForNoul(0.02, T)).toBe("act");
  });
});

describe("chunkItems", () => {
  const item = (i: number, len = 10): Item => ({ id: `I${i}`, label: `f${i}`, text: "x".repeat(len), total: len });
  it("caps items per chunk at 255", () => {
    const chunks = chunkItems(Array.from({ length: 600 }, (_, i) => item(i)));
    expect(chunks.map((c) => c.length)).toEqual([255, 255, 90]);
  });
  it("splits on the token budget", () => {
    const chunks = chunkItems(Array.from({ length: 10 }, (_, i) => item(i, 26_000)), 255, 24_000);
    expect(chunks).toHaveLength(5); // ~10k tokens each at 2.6 chars/token, two per 24k chunk
  });
});

describe("usage", () => {
  const e = (over: Partial<UsageEntry>): UsageEntry => ({ ts: "2026-09-16T10:00:00Z", cmd: "check", model: "jev", in: 100, out: 10, ms: 300, q: 1, cached: false, ...over });
  it("separates billed and cached tokens", () => {
    const t = totals([e({}), e({ cached: true, in: 50, out: 5 })]);
    expect(t.billed_calls).toBe(1);
    expect(t.cached_calls).toBe(1);
    expect(t.input).toBe(100);
    expect(t.saved_input).toBe(50);
  });
  it("does not turn unreported tokens into zero in totals or costs", () => {
    expect(totals([e({}), e({ in: null }), e({ cached: true, out: null })])).toMatchObject({ input: null, output: 20, saved_input: 100, saved_output: null });
    expect(estimateCost(null, 10)).toBeNull();
    expect(estimateCost(1_000_000, null, { input: 0.1, output: 0 })).toBeCloseTo(0.1);
    expect(estimateCost(10, null, { input: 0.1, output: 0.4 })).toBeNull();
    expect(formatCost(null)).toBe("unknown");
    const result: EvalResult = { model: "jev", answers: {}, usage: { input_tokens: null, output_tokens: 10 }, ms: 1, cached: false };
    expect(usageLine(result)).toBe("?in/10out 1ms jev unknown");
    expect(mergedUsageLine([result, { ...result, usage: { input_tokens: 100, output_tokens: 1 } }])).toBe("?in/11out 2ms 2 calls jev unknown");
  });
  it("groups by day and command", () => {
    const g = groupUsage([e({}), e({ cmd: "rank" }), e({ ts: "2026-09-15T10:00:00Z" })], "day");
    expect([...g.keys()]).toEqual(["2026-09-16", "2026-09-15"]);
    expect(groupUsage([e({}), e({ cmd: "rank" })], "command").size).toBe(2);
  });
  it("estimates cost from defaults or configured prices", () => {
    expect(estimateCost(1_000_000, 1_000_000)).toBeCloseTo(0.042); // default $0.042/1M input, output free
    expect(estimateCost(1_000_000, 1_000_000, { input: 0.1, output: 0.4 })).toBeCloseTo(0.5);
    expect(formatCost(0.5)).toBe("$0.5000");
    expect(formatCost(0.000123)).toBe("$0.00012");
  });
});

describe("format", () => {
  it("summarizes each answer type into a row", () => {
    expect(answerRow("a", { type: "choice", choice: "x", probabilities: { x: 0.9, y: 0.1 }, confidence: 0.8 }, T)).toEqual({ id: "a", type: "choice", answer: "x", confidence: 0.8, band: "act" });
    expect(answerRow("b", { type: "noul", noul: 0.5 }, T).band).toBe("escalate");
    expect(answerRow("c", { type: "score", score: 1.234, legend: { "0": "lo", "1": "hi" }, probabilities: { "0": 0.3, "1": 0.7 }, confidence: 0.4 }, T).answer).toBe(1.23);
  });
  it("orders distributions highest first and limits them", () => {
    const rows = distributionRows({ type: "choice", choice: "x", probabilities: { y: 0.1, x: 0.9 }, confidence: 0.8 }, 1);
    expect(rows).toEqual([{ option: "x", p: 0.9 }]);
  });
  it("collapses whitespace in previews", () => {
    expect(oneLine("a\n  b\tc", 10)).toBe("a b c");
    expect(oneLine("abcdefghijk", 5)).toBe("abcd…");
  });
});

describe("preview", () => {
  it("skips a leading import block, including multi-line imports", async () => {
    const { preview } = await import("../src/items.js");
    const src = 'import { a } from "./a.js";\nimport {\n  b,\n  c,\n} from "./b.js";\n\nexport function main() {}\n';
    expect(preview(src, 100)).toBe("export function main() {}\n");
    expect(preview("plain text\nmore", 100)).toBe("plain text\nmore");
    expect(preview('import x from "y";\n', 100)).toBe('import x from "y";\n');
  });
});

describe("package.json", () => {
  it("keeps a bin path that current npm accepts (no ./ prefix, no missing entry)", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.bin["jev-axi"]).toBe("dist/bin/jev-axi.js");
    expect(pkg.repository.url).toMatch(/^git\+https:/);
  });
});

describe("version", () => {
  it("src/version.ts matches package.json so --version reports the published version", async () => {
    const { readFileSync } = await import("node:fs");
    const { VERSION } = await import("../src/version.js");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
