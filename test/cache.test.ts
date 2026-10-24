import { apiBody } from "./api-body.js";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureFetch, staleReason } from "../src/client.js";
import { readUsage, totals } from "../src/usage.js";
import { main } from "../src/cli.js";

/** Fake API whose reported model version can be changed mid-test, like TypeSafe moving jev-latest. */
function fakeApi(usage: { input_tokens: number | null; output_tokens: number | null } = { input_tokens: 10, output_tokens: 1 }) {
  const state = { version: "jev-1.13.0", calls: 0 };
  const fetch = async (_url: any, init?: any) => {
    state.calls++;
    const body = apiBody(init);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }]));
    return new Response(JSON.stringify({ model: state.version, answers, usage }), { status: 200 });
  };
  return { fetch: fetch as any, state };
}

let out = "";
const stdout = { write: (s: string) => ((out += s), true) };
let dir: string;
const origCwd = process.cwd();
const check = () => main(["check", "is it?", "--text", "yes"], stdout);

beforeEach(() => {
  out = "";
  dir = mkdtempSync(join(tmpdir(), "jev-cache-"));
  process.chdir(dir);
  process.env["XDG_CACHE_HOME"] = join(dir, "cache");
  process.env["XDG_STATE_HOME"] = join(dir, "state");
  process.env["XDG_CONFIG_HOME"] = join(dir, "config");
  process.env["TYPESAFE_API_KEY"] = "test-key";
});
afterEach(() => {
  process.chdir(origCwd);
  configureFetch(undefined);
  process.exitCode = 0;
});

describe("response cache", () => {
  it("reuses a fresh answer from the same model version", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    await check();
    await check();
    expect(api.state.calls).toBe(1);
  });

  it("preserves unknown token counts in live and cached answers and the ledger", async () => {
    const api = fakeApi({ input_tokens: null, output_tokens: null });
    configureFetch(api.fetch);
    await check();
    expect(out).toContain("?in/?out");
    expect(out).toContain("unknown");
    out = "";
    await check();
    expect(api.state.calls).toBe(1);
    expect(out).toContain("?in/?out cached");
    const entries = readUsage();
    expect(entries.map((e) => [e.in, e.out, e.cached])).toEqual([[null, null, false], [null, null, true]]);
    expect(totals(entries)).toMatchObject({ input: null, output: null, saved_input: null, saved_output: null });
    out = "";
    await main(["usage", "--json"], stdout);
    expect(JSON.parse(out)).toMatchObject({ cost: null, saved: null });
    out = "";
    await main(["stats"], stdout);
    expect(out).toContain("unknown");
    expect(out).not.toContain("NaN");
  });

  it("stops serving cached answers once jev-latest resolves to a new version", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    await check(); // cached under jev-1.13.0
    api.state.version = "jev-1.14.0";
    // A different request observes the alias move...
    await main(["check", "something else?", "--text", "no"], stdout);
    // ...so the original request must go live again instead of returning the old model's answer.
    out = "";
    await check();
    expect(api.state.calls).toBe(3);
    expect(out).toContain("jev-1.14.0");
    expect(out).not.toContain("cached");
  });

  it("treats entries past the TTL, or without a timestamp, as stale", () => {
    const now = Date.parse("2026-09-17T12:00:00Z");
    const entry = { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } };
    expect(staleReason({ ...entry, created: now - 3_600_000 }, "jev-latest", now, 24, {})).toBeUndefined();
    expect(staleReason({ ...entry, created: now - 25 * 3_600_000 }, "jev-latest", now, 24, {})).toBe("expired");
    expect(staleReason(entry, "jev-latest", now, 24, {})).toBe("no timestamp");
    expect(staleReason({ ...entry, created: now }, "jev-latest", now, 24, { "jev-latest": "jev-1.14.0" })).toMatch(/moved/);
  });

  it("disables caching entirely when cacheTtlHours is 0", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    await main(["config", "set", "cacheTtlHours", "0"], stdout);
    await check();
    await check();
    expect(api.state.calls).toBe(2);
  });

  it("cache clear --stale keeps fresh entries and removes old ones", async () => {
    const api = fakeApi();
    configureFetch(api.fetch);
    await check();
    const cacheDir = join(dir, "cache", "jev-axi");
    const legacy = { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } };
    writeFileSync(join(cacheDir, "legacy.json"), JSON.stringify(legacy));
    out = "";
    await main(["cache", "clear", "--stale"], stdout);
    expect(out).toContain("removed 1 stale responses");
    const left = readdirSync(cacheDir).filter((f) => f !== "aliases.json");
    expect(left).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(cacheDir, left[0]!), "utf8")).created).toBeTypeOf("number");
  });
});
