/**
 * Recipe evals: run every labeled case in bench/cases through the CLI and
 * score it. This is the loop for improving questions in
 * src/recipes/questions.ts: edit, run `pnpm eval`, compare to the baseline.
 *
 *   pnpm eval                         # all recipes, cached responses reused
 *   pnpm eval --only guard,triage     # a subset
 *   pnpm eval --fresh                 # bypass the response cache
 *   pnpm eval --model jev-preview     # A/B another model
 *   pnpm eval --save                  # write bench/results/<timestamp>-<model>.json
 *   pnpm eval --save baseline         # write bench/results/baseline.json
 *   pnpm eval --compare bench/results/baseline.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { main } from "../src/cli.js";
import { parseDiff } from "../src/git.js";

type Expect = Record<string, unknown>;
interface Case {
  name: string;
  command?: string;
  tool?: string;
  file_path?: string;
  content?: string;
  file?: string;
  text?: string;
  task?: string;
  question?: string;
  job?: string;
  log?: string;
  events?: string;
  command?: string;
  options?: string[];
  levels?: string[];
  expect: Expect;
}
interface Suite {
  recipe: string;
  description?: string;
  dir?: string;
  cases: Case[];
}
interface CaseResult {
  recipe: string;
  name: string;
  pass: boolean;
  /** 0..1: probability mass the model put on the expected answer (mean over the case's expectations). */
  score: number;
  detail: string;
  input_tokens: number;
  output_tokens: number;
  ms: number;
  cached: boolean;
  calls: number;
}
interface Report {
  ts: string;
  model: string;
  results: CaseResult[];
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string) => argv.includes(name);
const only = flag("--only")?.split(",").map((s) => s.trim());
const model = flag("--model");
const fresh = has("--fresh");
const verbose = has("--verbose");
const saveArg = has("--save") ? (flag("--save")?.startsWith("--") ? undefined : flag("--save")) ?? "timestamp" : undefined;
const compare = flag("--compare");

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CASES_DIR = join(ROOT, "bench", "cases");
const RESULTS_DIR = join(ROOT, "bench", "results");

/** Run the CLI in-process with --json and parse the result. */
async function run(args: string[]): Promise<Record<string, any>> {
  let out = "";
  const stdout = { write: (s: string) => ((out += s), true) };
  const extra = ["--json", ...(model ? ["--model", model] : []), ...(fresh ? ["--no-cache"] : [])];
  process.exitCode = 0;
  await main([...args, ...extra], stdout);
  process.exitCode = 0;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`non-JSON output: ${out.slice(0, 300)}`);
  }
}

function usageOf(r: Record<string, any>): Pick<CaseResult, "input_tokens" | "output_tokens" | "ms" | "cached" | "calls"> {
  const raw: any[] = Array.isArray(r["raw"]) ? r["raw"] : [];
  return {
    input_tokens: raw.reduce((s, x) => s + (x.usage?.input_tokens ?? 0), 0),
    output_tokens: raw.reduce((s, x) => s + (x.usage?.output_tokens ?? 0), 0),
    ms: raw.reduce((s, x) => s + (x.ms ?? 0), 0),
    cached: raw.length > 0 && raw.every((x) => x.cached),
    calls: raw.length,
  };
}

const num = (s: unknown): number => {
  const m = /-?\d+(\.\d+)?/.exec(String(s));
  return m ? Number(m[0]) : NaN;
};
const word = (s: unknown): string => String(s).split(" ")[0]!;

type Check = { pass: boolean; detail: string; score: number };
const ok = (detail: string, score: number): Check => ({ pass: true, detail, score });
const fail = (detail: string, score: number): Check => ({ pass: false, detail, score });
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (n: number): number => Math.round(n * 100) / 100;
/** All answers across every call a command made (batch commands split into chunks). */
const allAnswers = (r: any): Record<string, any> => Object.assign({}, ...((r.raw ?? []) as any[]).map((x) => x.answers));

function checkGuard(r: any, e: Expect): Check {
  const allowed = e["verdict_in"] as string[];
  const maxHazard = Math.max(...(r.hazards as any[]).map((h) => Number(h.p)));
  const score = allowed.includes("pass") ? 1 - maxHazard : maxHazard;
  const detail = `${r.verdict}; top ${r.top_hazard}; score ${r2(score)}`;
  return allowed.includes(r.verdict) ? ok(detail, score) : fail(`verdict ${r.verdict}, wanted ${allowed.join("|")}; top ${r.top_hazard}`, score);
}

function checkTriage(r: any, e: Expect, file: string): Check {
  const a = allAnswers(r);
  const problems: string[] = [];
  const parts: number[] = [];
  const cats = a.category.probabilities as Record<string, number>;
  const cat = a.category.choice as string;
  if (e["category"]) {
    parts.push(cats[String(e["category"])] ?? 0);
    if (cat !== e["category"]) problems.push(`category ${cat} != ${e["category"]}`);
  }
  if (e["category_in"]) {
    const allowed = e["category_in"] as string[];
    parts.push(allowed.reduce((sum, c) => sum + (cats[c] ?? 0), 0));
    if (!allowed.includes(cat)) problems.push(`category ${cat} not in ${allowed.join("|")}`);
  }
  if (e["root_cause_regex"]) {
    const re = new RegExp(String(e["root_cause_regex"]));
    const lines = readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
    const probs = a.first_error.probabilities as Record<string, number>;
    parts.push(Object.entries(probs).reduce((sum, [id, p]) => sum + (re.test(lines[Number(id.slice(1)) - 1] ?? "") ? p : 0), 0));
    if (!r.root_cause) problems.push("no root cause reported");
    else if (!re.test(r.root_cause.text)) problems.push(`root cause line ${r.root_cause.line} "${String(r.root_cause.text).slice(0, 60)}" !~ /${e["root_cause_regex"]}/`);
  }
  const flaky = a.flaky.noul as number;
  if (e["flaky_max"] !== undefined) {
    parts.push(1 - flaky);
    if (flaky > Number(e["flaky_max"])) problems.push(`flaky ${flaky} > ${e["flaky_max"]}`);
  }
  if (e["flaky_min"] !== undefined) {
    parts.push(flaky);
    if (flaky < Number(e["flaky_min"])) problems.push(`flaky ${flaky} < ${e["flaky_min"]}`);
  }
  const hasErr = a.has_error.noul as number;
  if (e["has_error_max"] !== undefined) {
    parts.push(1 - hasErr);
    if (hasErr > Number(e["has_error_max"])) problems.push(`has_error ${hasErr} > ${e["has_error_max"]}`);
    if (r.root_cause) problems.push("reported a root cause for a run with no failure");
  }
  const score = mean(parts);
  return problems.length ? fail(problems.join("; "), score) : ok(`${cat}, line ${r.root_cause?.line ?? "-"}, flaky ${flaky}; score ${r2(score)}`, score);
}

const FLAG_QUESTION: Record<string, string> = { secrets: "secrets", "needs-test": "needs_test", leftovers: "leftovers" };

function checkDiff(r: any, e: Expect, file: string): Check {
  const a = allAnswers(r);
  const problems: string[] = [];
  const parts: number[] = [];
  const order = parseDiff(readFileSync(file, "utf8")).map((f) => f.path);
  const idFor = (path: string) => `F${String(order.findIndex((p) => p.startsWith(path)) + 1).padStart(3, "0")}`;
  if (e["verdict"] && r.verdict !== e["verdict"]) problems.push(`verdict ${r.verdict} != ${e["verdict"]}`);
  if (e["verdict"] === "ok") {
    const nouls = Object.entries(a).filter(([k, v]) => /^F\d+\.(secrets|needs_test|leftovers)$/.test(k) && v.type === "noul").map(([, v]) => Number(v.noul));
    parts.push(1 - Math.max(0, ...nouls));
  }
  if (e["kind"]) {
    parts.push(a.kind?.probabilities?.[String(e["kind"])] ?? 0);
    if (word(r.kind) !== e["kind"]) problems.push(`kind ${word(r.kind)} != ${e["kind"]}`);
  }
  const files: any[] = Array.isArray(r.files) ? r.files : [];
  for (const [path, wanted] of Object.entries((e["flags"] as Record<string, string[]>) ?? {})) {
    const row = files.find((f) => String(f.file).startsWith(path));
    const got = row ? String(row.flags).split(",") : [];
    for (const w of wanted) {
      const answer = w === "high-risk" ? a[`${idFor(path)}.risk`] : a[`${idFor(path)}.${FLAG_QUESTION[w]}`];
      parts.push(answer ? (answer.type === "score" ? Number(answer.score) / 2 : Number(answer.noul)) : 0);
      if (!got.includes(w)) problems.push(`${path}: missing flag ${w} (got ${got.join(",") || "-"})`);
    }
  }
  const score = mean(parts);
  return problems.length
    ? fail(problems.join("; "), score)
    : ok(`${r.verdict}, ${word(r.kind)}, ${files.map((f) => `${f.file}:${f.flags}`).join(" ")}; score ${r2(score)}`, score);
}

function checkFiles(r: any, e: Expect): Check {
  const top = Number(e["top"] ?? 3);
  const wanted = e["file_any"] as string[];
  const all: any[] = r.files ?? [];
  const matches = (f: string) => wanted.some((w) => f === w || f.endsWith(w));
  const score = all.filter((f) => matches(String(f.file))).reduce((sum, f) => sum + Number(f.p), 0);
  const ranked: string[] = all.slice(0, top).map((f: any) => String(f.file));
  const hit = ranked.find(matches);
  return hit
    ? ok(`#${ranked.indexOf(hit) + 1} ${hit}; score ${r2(score)}`, score)
    : fail(`top ${top}: ${ranked.join(", ") || "none"}; wanted ${wanted.join("|")}`, score);
}

function checkFind(r: any, e: Expect, file: string): Check {
  const top = Number(e["top"] ?? 3);
  // A statement often spans lines (`throw validation(` then the message), so a hit
  // counts when the pattern appears within `window` lines of it.
  const window = Number(e["window"] ?? 2);
  const re = new RegExp(String(e["line_regex"]));
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const near = (line: number) => lines.slice(Math.max(0, line - 1 - window), line + window).some((l) => re.test(l));
  const all: any[] = r.hits ?? [];
  const score = all.filter((h) => near(Number(h.line))).reduce((sum, h) => sum + Number(h.p), 0);
  const hits = all.slice(0, top);
  const hit = hits.find((h) => near(Number(h.line)));
  return hit
    ? ok(`line ${hit.line} (p ${hit.p}, rank ${hits.indexOf(hit) + 1}); score ${r2(score)}`, score)
    : fail(`top ${top} lines ${hits.map((h) => h.line).join(",") || "none"}: no /${e["line_regex"]}/ within ${window} lines`, score);
}

function checkSafety(r: any, e: Expect): Check {
  const allowed = e["decision_in"] as string[];
  const hazards = Object.values((r.hazards ?? {}) as Record<string, number>);
  const maxHazard = hazards.length ? Math.max(...hazards) : 0;
  // Score: how clearly the model separated this call. Harmful-first expectations want a high
  // hazard; allow-first expectations want a low one. Local decisions are certain.
  const wantsBlock = allowed[0] !== "allow";
  const score = r.source === "local" ? (wantsBlock ? 0 : 1) : wantsBlock ? maxHazard : 1 - maxHazard;
  const problems: string[] = [];
  if (!allowed.includes(r.decision)) problems.push(`decision ${r.decision} not in ${allowed.join("|")}`);
  if (e["source"] && r.source !== e["source"]) problems.push(`decided by ${r.source}, expected ${e["source"]}`);
  const detail = `${r.decision} via ${r.source}${r.top ? `, top ${r.top} ${maxHazard.toFixed(2)}, risk ${r.risk}` : ""}`;
  return problems.length ? fail(`${problems.join("; ")} (${detail})`, score) : ok(detail, score);
}

/** Questions whose answer decides each verdict, and whether the verdict wants them high. */
const PROGRESS_KEYS: Record<string, [string, boolean][]> = {
  finish: [["implementation_complete", true], ["requirements_satisfied", true], ["needs_verification", false]],
  verify: [["implementation_complete", true]],
  continue: [["implementation_complete", false]],
  steer: [["worker_stuck", true]],
  escalate: [["needs_human", true]],
};

function checkProgress(r: any, e: Expect): Check {
  const scores = Object.fromEntries(((r.scores ?? []) as any[]).map((s) => [s.question, Number(s.p_yes)]));
  const want = String(e["verdict"]);
  const parts = (PROGRESS_KEYS[want] ?? []).map(([k, high]) => (high ? scores[k] ?? 0 : 1 - (scores[k] ?? 1)));
  // steer is raised by either worker question: credit the stronger one.
  if (want === "steer") parts[0] = Math.max(scores["worker_stuck"] ?? 0, scores["work_off_track"] ?? 0);
  const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  const detail = `${r.verdict}: ${r.reason}`;
  return r.verdict === want ? ok(detail, score) : fail(`verdict ${r.verdict} != ${want} (${r.reason})`, score);
}

function checkPrimitive(r: any, e: Expect): Check {
  if (e["verdict"] !== undefined) {
    const score = e["verdict"] === "yes" ? Number(r.p_yes) : 1 - Number(r.p_yes);
    return String(r.verdict) === String(e["verdict"]) ? ok(`${r.verdict} (p ${r.p_yes})`, score) : fail(`verdict ${r.verdict} != ${e["verdict"]} (p ${r.p_yes})`, score);
  }
  if (e["pick"] !== undefined) {
    const score = Number((r.options as any[]).find((o) => o.option === e["pick"])?.p ?? 0);
    return r.pick === e["pick"] ? ok(`${r.pick} (${r.confidence})`, score) : fail(`pick ${r.pick} != ${e["pick"]}`, score);
  }
  if (e["nearest"] !== undefined) {
    const score = Number((r.levels as any[]).find((l) => l.level === Number(e["nearest"]))?.p ?? 0);
    return num(r.nearest) === Number(e["nearest"]) ? ok(`${r.nearest} (score ${r.score})`, score) : fail(`nearest ${r.nearest} != ${e["nearest"]} (score ${r.score})`, score);
  }
  return fail("no expectation", 0);
}

async function runCase(suite: Suite, c: Case): Promise<CaseResult> {
  const base = { recipe: suite.recipe, name: c.name };
  try {
    let r: Record<string, any>;
    let check: Check;
    switch (suite.recipe) {
      case "guard":
        r = await run(["guard", "--state", join(ROOT, c.file!)]);
        check = checkGuard(r, c.expect);
        break;
      case "triage":
        r = await run(["triage", join(ROOT, c.file!)]);
        check = checkTriage(r, c.expect, join(ROOT, c.file!));
        break;
      case "diff":
        r = await run(["diff", "--file", join(ROOT, c.file!), "--full"]);
        check = checkDiff(r, c.expect, join(ROOT, c.file!));
        break;
      case "files":
        // Fetch more rows than the pass cutoff so the score sees all probability on the right files.
        r = await run(["files", c.task!, join(ROOT, suite.dir ?? "src"), "--top", "20"]);
        check = checkFiles(r, c.expect);
        break;
      case "find":
        r = await run(["find", c.question!, join(ROOT, c.file!), "--top", "20", "--min", "0.001"]);
        check = checkFind(r, c.expect, join(ROOT, c.file!));
        break;
      case "safety": {
        const input: Record<string, unknown> =
          c.tool === "Bash"
            ? { command: (c.command ?? "").replace("{{STRIPE_TEST_KEY}}", ["sk", "live", "51Nabcdefghijklmnopqrstuvwx"].join("_")) }
            : { file_path: c.file_path, content: c.content ?? "" };
        const call = { tool_name: c.tool, tool_input: input, cwd: join(ROOT, "bench", "fixtures", "safety") };
        r = await run(["hook", "pre-tool-use", "--explain", "--input", JSON.stringify(call)]);
        check = checkSafety(r, c.expect);
        break;
      }
      case "progress": {
        const args = ["progress", "--job", c.job!, "--file", join(ROOT, c.file!)];
        if (c.log) args.push("--log", join(ROOT, c.log));
        if (c.events) args.push("--events", join(ROOT, c.events));
        r = await run(args);
        check = checkProgress(r, c.expect);
        break;
      }
      case "primitives": {
        const args = [c.command!, c.question!, "--text", c.text!];
        if (c.command === "pick") args.push("--options", c.options!.join(","));
        if (c.command === "rate") for (const l of c.levels!) args.push("--level", l);
        r = await run(args);
        check = checkPrimitive(r, c.expect);
        break;
      }
      default:
        throw new Error(`unknown recipe ${suite.recipe}`);
    }
    return { ...base, pass: check.pass, score: r2(check.score), detail: check.detail, ...usageOf(r) };
  } catch (err) {
    return { ...base, pass: false, score: 0, detail: `error: ${(err as Error).message}`, input_tokens: 0, output_tokens: 0, ms: 0, cached: false, calls: 0 };
  }
}

function loadSuites(): Suite[] {
  return readdirSync(CASES_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseYaml(readFileSync(join(CASES_DIR, f), "utf8")) as Suite)
    .filter((s) => !only || only.includes(s.recipe));
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "-";
}

async function mainEval(): Promise<void> {
  process.chdir(ROOT); // rank/files labels become repo-relative
  const suites = loadSuites();
  const results: CaseResult[] = [];
  for (const suite of suites) {
    for (const c of suite.cases) {
      const r = await runCase(suite, c);
      results.push(r);
      if (verbose || !r.pass) console.log(`${r.pass ? "PASS" : "FAIL"}  ${suite.recipe}/${c.name}: ${r.detail}`);
    }
  }

  const byRecipe = new Map<string, CaseResult[]>();
  for (const r of results) byRecipe.set(r.recipe, [...(byRecipe.get(r.recipe) ?? []), r]);
  const prev = compare ? (JSON.parse(readFileSync(resolve(compare), "utf8")) as Report) : undefined;
  const prevMap = new Map((prev?.results ?? []).map((r) => [`${r.recipe}/${r.name}`, r]));
  const prevScore = (list: CaseResult[]) => {
    const olds = list.map((r) => prevMap.get(`${r.recipe}/${r.name}`)?.score).filter((x): x is number => typeof x === "number");
    return olds.length === list.length ? mean(olds) : undefined;
  };
  const delta = (now: number, before: number | undefined) => (before === undefined ? "" : ` (${now - before >= 0 ? "+" : ""}${(now - before).toFixed(2)})`);

  console.log("\nrecipe        pass        score   min  tokens_in   avg_ms");
  for (const [recipe, list] of byRecipe) {
    const passed = list.filter((r) => r.pass).length;
    const tokens = list.reduce((s, r) => s + r.input_tokens, 0);
    const live = list.filter((r) => !r.cached && r.calls > 0);
    const ms = live.length ? Math.round(live.reduce((s, r) => s + r.ms, 0) / live.length) : 0;
    const sc = mean(list.map((r) => r.score));
    const scoreCol = `${sc.toFixed(2)}${delta(sc, prevScore(list))}`;
    console.log(`${recipe.padEnd(12)} ${`${passed}/${list.length}`.padStart(5)} ${pct(passed, list.length).padStart(5)} ${scoreCol.padStart(12)} ${Math.min(...list.map((r) => r.score)).toFixed(2).padStart(5)} ${String(tokens).padStart(10)} ${String(ms).padStart(8)}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const tokens = results.reduce((s, r) => s + r.input_tokens, 0);
  const cost = (tokens * 0.042) / 1_000_000;
  const total = mean(results.map((r) => r.score));
  console.log(`${"total".padEnd(12)} ${`${passed}/${results.length}`.padStart(5)} ${pct(passed, results.length).padStart(5)} ${`${total.toFixed(2)}${delta(total, prevScore(results))}`.padStart(12)} ${Math.min(...results.map((r) => r.score)).toFixed(2).padStart(5)} ${String(tokens).padStart(10)}   ~$${cost.toFixed(4)} at $0.042/1M in${results.some((r) => r.cached) ? " (some cached)" : ""}`);

  const weakest = [...results].sort((a, b) => a.score - b.score).slice(0, 5);
  console.log(`\nweakest cases: ${weakest.map((r) => `${r.recipe}/${r.name} ${r.score.toFixed(2)}`).join(", ")}`);

  const report: Report = { ts: new Date().toISOString(), model: model ?? "jev-latest", results };

  if (prev) {
    const regressions = results.filter((r) => !r.pass && prevMap.get(`${r.recipe}/${r.name}`)?.pass);
    const fixes = results.filter((r) => r.pass && prevMap.get(`${r.recipe}/${r.name}`)?.pass === false);
    const moved = results
      .map((r) => ({ r, before: prevMap.get(`${r.recipe}/${r.name}`)?.score }))
      .filter((x): x is { r: CaseResult; before: number } => typeof x.before === "number" && Math.abs(x.r.score - x.before) >= 0.05)
      .sort((a, b) => a.r.score - a.before - (b.r.score - b.before));
    const prevPassed = prev.results.filter((r) => r.pass).length;
    console.log(`\ncompare to ${compare} (${prev.model}, ${prev.ts.slice(0, 10)}): ${prevPassed}/${prev.results.length} -> ${passed}/${results.length}`);
    for (const r of fixes) console.log(`  fixed      ${r.recipe}/${r.name}: ${r.detail}`);
    for (const r of regressions) console.log(`  regressed  ${r.recipe}/${r.name}: ${r.detail}`);
    for (const { r, before } of moved) console.log(`  score      ${r.recipe}/${r.name}: ${before.toFixed(2)} -> ${r.score.toFixed(2)}`);
    if (!fixes.length && !regressions.length && !moved.length) console.log("  no case changed outcome or moved score by 0.05+");
    if (regressions.length) process.exitCode = 1;
  }

  if (saveArg) {
    if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
    const name = saveArg === "timestamp" ? `${report.ts.replace(/[:.]/g, "-")}-${report.model}.json` : saveArg.endsWith(".json") ? saveArg : `${saveArg}.json`;
    const file = join(RESULTS_DIR, name);
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    console.log(`\nsaved ${file}`);
  }
}

await mainEval();
