import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureFetch } from "../src/client.js";
import { main } from "../src/cli.js";

/** Fake TypeSafe API: answers every question with a canned shape and records requests. */
function fakeApi() {
  const requests: any[] = [];
  const fetch = async (_url: any, init?: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(body.questions)) {
      if (q.type === "noul") answers[id] = { type: "noul", noul: id.endsWith("2") ? 0.2 : 0.9 };
      else if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.7 : 0.3 / (keys.length - 1)]));
        answers[id] = { type: "choice", choice: keys[0], probabilities, confidence: 0.6 };
      } else {
        const n = q.criteria.length;
        answers[id] = {
          type: "score",
          score: n - 1,
          legend: Object.fromEntries(q.criteria.map((c: string, i: number) => [String(i), c])),
          probabilities: Object.fromEntries(q.criteria.map((_: string, i: number) => [String(i), i === n - 1 ? 1 : 0])),
          confidence: 0.99,
        };
      }
    }
    const res = { model: "jev-test", answers, usage: { input_tokens: 100, output_tokens: 10 } };
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetch as any, requests };
}

let out: string;
const stdout = { write: (s: string) => { out += s; return true; } };
let dir: string;
const origCwd = process.cwd();

beforeEach(() => {
  out = "";
  dir = mkdtempSync(join(tmpdir(), "jev-axi-test-"));
  process.chdir(dir); // no .env from the repo, and rank labels become relative
  process.env["XDG_CACHE_HOME"] = join(dir, "cache");
  process.env["XDG_STATE_HOME"] = join(dir, "state");
  process.env["XDG_CONFIG_HOME"] = join(dir, "config");
  process.env["TYPESAFE_API_KEY"] = "test-key";
  process.exitCode = 0;
});
afterEach(() => {
  process.chdir(origCwd);
  configureFetch(undefined);
  process.exitCode = 0;
});

describe("cli", () => {
  it("pick renders the choice, band, and usage line", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    await main(["pick", "Which team?", "--options", "billing,tech", "--text", "charged twice"], stdout);
    expect(out).toContain("pick: billing");
    expect(out).toContain("band: confirm");
    expect(out).toMatch(/usage: 100in\/10out \d+ms jev-test/);
    expect(api.requests[0].questions.answer.criteria).toEqual({ billing: null, tech: null });
  });

  it("check uses stdin-free --text and reports a noul verdict", async () => {
    configureFetch(fakeApi().fetch);
    await main(["check", "Is it urgent?", "--text", "ASAP please"], stdout);
    expect(out).toContain("verdict: yes");
    expect(out).toContain("p_yes: 0.9");
    expect(out).toContain("band: act");
  });

  it("serves the second identical call from cache and records both in the ledger", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    await main(["check", "Is it urgent?", "--text", "ASAP please"], stdout);
    out = "";
    await main(["check", "Is it urgent?", "--text", "ASAP please"], stdout);
    expect(out).toContain("cached");
    expect(api.requests).toHaveLength(1);
    out = "";
    await main(["usage"], stdout);
    expect(out).toContain("calls: \"2 (1 billed, 1 cached)\"");
  });

  it("ask sends all questions in one request and renders a table", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    const q = JSON.stringify({
      cat: { type: "choice", instructions: "kind?", criteria: { bug: null, feature: null } },
      sev: { type: "score", instructions: "severity?", criteria: ["low", "high"] },
      urgent2: { type: "noul", instructions: "urgent?" },
    });
    await main(["ask", "--questions", q, "--text", "it is broken"], stdout);
    expect(api.requests).toHaveLength(1);
    expect(out).toContain("answers[3]{id,type,answer,confidence,band}:");
    expect(out).toContain("cat,choice,bug,0.6,confirm");
    expect(out).toContain("urgent2,noul,0.2,0.6,confirm");
  });

  it("rank chunks nothing for a small set and flags a weak match", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.txt`), `file ${n} content`);
    await main(["rank", "the b file", join(dir, "a.txt"), join(dir, "b.txt"), join(dir, "c.txt"), "--top", "2"], stdout);
    expect(api.requests).toHaveLength(1);
    expect(Object.keys(api.requests[0].questions.where.criteria)).toEqual(["I001", "I002", "I003"]);
    expect(out).toContain("count: 2 shown of 3 items");
    expect(out).toContain("ranked[2]{rank,p,item,preview}:");
  });

  it("filter keeps items above --min and lists the rest with --all", async () => {
    configureFetch(fakeApi().fetch);
    writeFileSync(join(dir, "lines.txt"), "one\ntwo\n");
    await main(["filter", "is a number word", join(dir, "lines.txt"), "--all"], stdout);
    expect(out).toContain("count: 1 kept of 1 items");
  });

  it("find tags lines with ids and reports the best line", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    writeFileSync(join(dir, "src.ts"), "const a = 1;\nfunction retry() {}\n");
    await main(["find", "where is retry?", join(dir, "src.ts")], stdout);
    expect(api.requests[0].state).toBe("L0001| const a = 1;\nL0002| function retry() {}");
    expect(out).toContain("answer_exists: 0.9");
    expect(out).toContain("hits[");
  });

  it("keeps a high-probability hit in a later window of a large file", async () => {
    const api = async (_url: unknown, init?: any) => {
      const body = JSON.parse(init.body);
      const state = String(body.state);
      const exists = state.includes("THE RETRY DELAY") ? 0.9 : 0.1;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries<any>(body.questions)) {
        if (q.type === "noul") {
          answers[id] = { type: "noul", noul: exists };
        } else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          answers[id] = {
            type: "choice",
            choice: keys[0],
            probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.7 : 0.3 / Math.max(1, keys.length - 1)])),
            confidence: 0.9,
          };
        }
      }
      return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    };
    configureFetch(api as any);
    writeFileSync(join(dir, "large.ts"), Array.from({ length: 26_000 }, (_, i) => i === 255 ? "THE RETRY DELAY IS DECIDED HERE" : `ordinary source line ${i}`).join("\n"));
    await main(["find", "where is the retry delay decided?", join(dir, "large.ts"), "--min", "0.5", "--no-cache"], stdout);
    expect(out).toContain("answer_exists: 0.9");
    expect(out).toContain("count: 1 shown");
    expect(out).toContain("THE RETRY DELAY IS DECIDED HERE");
    expect(out).not.toContain("ordinary source line 0");
    // The shown p is the same where × exists score --min was applied to, not a share diluted by 102 windows.
    expect(out).toMatch(/\n\s+0\.63,256,/);
  });

  it("rank scores an item the same however many chunks surround it", async () => {
    const api = async (_url: unknown, init?: any) => {
      const body = JSON.parse(init.body);
      const target = Object.entries<any>(body.state).find(([, v]) => v.text.includes("THE RETRY DELAY"))?.[0];
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries<any>(body.questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: target ? 0.9 : 0.1 };
        else {
          const keys = Object.keys(q.criteria);
          const best = target ?? keys[0]!;
          answers[id] = {
            type: "choice",
            choice: best,
            probabilities: Object.fromEntries(keys.map((k) => [k, k === best ? 0.7 : 0.3 / (keys.length - 1)])),
            confidence: 0.9,
          };
        }
      }
      return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    };
    configureFetch(api as any);
    const many = join(dir, "many");
    mkdirSync(many);
    for (let i = 0; i < 2600; i++) writeFileSync(join(many, `f${i}.txt`), i === 1300 ? "THE RETRY DELAY IS DECIDED HERE" : `ordinary file ${i}`);
    await main(["rank", "where is the retry delay decided?", many, "--min", "0.5", "--no-cache"], stdout);
    expect(out).toContain("count: 1 shown of 2600 items");
    expect(out).toMatch(/1,0\.63,.*f1300\.txt/);
  });

  it("fails loud on unknown flags with exit code 2", async () => {
    await main(["check", "q", "--bogus", "--text", "x"], stdout);
    expect(process.exitCode).toBe(2);
    expect(out).toContain("error: unknown flag --bogus for `check`");
    expect(out).toContain("help[1]:\n  valid flags for `check`");
  });

  it("reports a missing key as AUTH_REQUIRED", async () => {
    delete process.env["TYPESAFE_API_KEY"];
    configureFetch(fakeApi().fetch);
    await main(["check", "q", "--text", "x", "--no-cache"], stdout);
    expect(out).toContain("code: AUTH_REQUIRED");
    expect(process.exitCode).toBe(1);
  });

  it("--json returns machine-readable output with the raw response", async () => {
    configureFetch(fakeApi().fetch);
    await main(["check", "q", "--text", "x", "--json"], stdout);
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe("yes");
    expect(parsed.raw[0].answers.answer.noul).toBe(0.9);
  });
});
