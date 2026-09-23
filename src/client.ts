import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type Fetch,
  type EntryType,
  type Question,
  type Usage,
} from "@typesafe-ai/sdk";
import { AxiError } from "./errors.js";
import { ensureDir, keySearchDescription, paths, readConfig, resolveApiKey, resolveCacheTtlHours, resolveModel, resolveThresholds } from "./config.js";
import { projectName, recordUsage, type BandCounts } from "./usage.js";
import { bandForConfidence, bandForNoul } from "./bands.js";

export type QuestionMap = Record<string, Question>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface NoulAnswer {
  type: "noul";
  noul: number;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface EvalResult {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
  ms: number;
  cached: boolean;
}

export interface EvalOptions {
  command: string;
  model?: string;
  cache?: boolean;
  fetch?: Fetch;
  /** Per-attempt timeout in ms and retry count, for latency-sensitive callers such as hooks. */
  timeoutMs?: number;
  maxRetries?: number;
}

let fetchOverride: Fetch | undefined;
/** Test hook: route all API traffic through a custom fetch. */
export function configureFetch(fetch: Fetch | undefined): void {
  fetchOverride = fetch;
}

let client: TypeSafeClient | undefined;
function getClient(fetch?: Fetch): TypeSafeClient {
  const f = fetch ?? fetchOverride;
  if (client && !f) return client;
  const { key } = resolveApiKey();
  if (!key) {
    throw new AxiError("TYPESAFE_API_KEY is not set", "AUTH_REQUIRED", [
      "Continue the task without jev-axi, and tell the user in your final answer that it was skipped because no API key is set",
      keySearchDescription(),
      "The user can fix it with `export TYPESAFE_API_KEY=<key>`, a `TYPESAFE_API_KEY=<key>` line in the repo's .env.local, or `jev-axi config set apiKey <key>` (keys: https://console.typesafe.ai/settings/keys)",
    ]);
  }
  const c = new TypeSafeClient({ apiKey: key, timeout: 60_000, logLevel: "error", ...(f ? { fetch: f } : {}) });
  if (!f) client = c;
  return c;
}

/** Band counts across a response's answers, using the configured thresholds. */
export function countBands(answers: Record<string, Answer>): BandCounts {
  const t = resolveThresholds({});
  const b: BandCounts = { act: 0, confirm: 0, escalate: 0 };
  for (const a of Object.values(answers)) {
    const band = a.type === "noul" ? bandForNoul(a.noul, t) : bandForConfidence(a.confidence, t);
    b[band]++;
  }
  return b;
}

function cacheKey(model: string, state: EntryType, questions: QuestionMap): string {
  return createHash("sha256").update(JSON.stringify({ model, state, questions })).digest("hex");
}

export function cacheEnabled(): boolean {
  return process.env["JEV_AXI_NO_CACHE"] !== "1" && resolveCacheTtlHours() > 0;
}

interface CacheEntry {
  /** Concrete model version that produced the answers, e.g. jev-1.13.0. */
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
  /** Epoch ms when written. Entries from before 0.2.1 lack it and are treated as expired. */
  created?: number;
}

/**
 * The version an alias such as `jev-latest` resolved to on the most recent live
 * call. Recorded on every live call so that when TypeSafe moves the alias, every
 * cached answer from the previous version stops being served.
 */
function aliasFile(): string {
  return join(paths.cacheDir(), "aliases.json");
}

function readAliases(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(aliasFile(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function recordAlias(requested: string, resolved: string): void {
  try {
    const aliases = readAliases();
    if (aliases[requested] === resolved) return;
    aliases[requested] = resolved;
    ensureDir(paths.cacheDir());
    writeFileSync(aliasFile(), JSON.stringify(aliases, null, 2));
  } catch {
    // best-effort
  }
}

/** Why a cache entry must not be served, or undefined when it is fresh. */
export function staleReason(entry: CacheEntry, requested: string, now = Date.now(), ttlHours = resolveCacheTtlHours(), aliases = readAliases()): string | undefined {
  if (!entry.created) return "no timestamp";
  if (now - entry.created > ttlHours * 3_600_000) return "expired";
  const current = aliases[requested];
  if (current && current !== entry.model) return `model moved from ${entry.model} to ${current}`;
  return undefined;
}

/**
 * Whether an entry is stale regardless of which alias asks for it: it expired, or
 * no alias currently resolves to the model version that produced it.
 */
function isStaleEntry(e: CacheEntry, now: number, ttlHours: number, aliasTargets: Set<string>): boolean {
  if (!e.created || now - e.created > ttlHours * 3_600_000) return true;
  return aliasTargets.size > 0 && !aliasTargets.has(e.model);
}

function* cacheEntries(): Generator<{ file: string; entry?: CacheEntry }> {
  const dir = paths.cacheDir();
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "aliases.json") continue;
    const file = join(dir, f);
    try {
      yield { file, entry: JSON.parse(readFileSync(file, "utf8")) as CacheEntry };
    } catch {
      yield { file };
    }
  }
}

export interface CacheStats {
  dir: string;
  entries: number;
  fresh: number;
  stale: number;
  bytes: number;
  ttlHours: number;
  aliases: Record<string, string>;
}

export function cacheStats(now = Date.now()): CacheStats {
  const ttlHours = resolveCacheTtlHours();
  const aliases = readAliases();
  const targets = new Set(Object.values(aliases));
  const stats: CacheStats = { dir: paths.cacheDir(), entries: 0, fresh: 0, stale: 0, bytes: 0, ttlHours, aliases };
  for (const { file, entry } of cacheEntries()) {
    stats.entries++;
    stats.bytes += statSync(file).size;
    if (!entry || isStaleEntry(entry, now, ttlHours, targets)) stats.stale++;
    else stats.fresh++;
  }
  return stats;
}

/** Delete cached responses: all of them (and the alias record), or only stale ones. Returns entries removed. */
export function clearCache(onlyStale: boolean, now = Date.now()): number {
  const ttlHours = resolveCacheTtlHours();
  const targets = new Set(Object.values(readAliases()));
  let removed = 0;
  for (const { file, entry } of cacheEntries()) {
    if (onlyStale && entry && !isStaleEntry(entry, now, ttlHours, targets)) continue;
    rmSync(file, { force: true });
    removed++;
  }
  if (!onlyStale) rmSync(aliasFile(), { force: true });
  return removed;
}

/**
 * Evaluate one state against a map of questions. Handles caching, timing,
 * the usage ledger, and translating SDK errors into structured AXI errors.
 */
export async function evaluate(
  state: EntryType,
  questions: QuestionMap,
  opts: EvalOptions,
): Promise<EvalResult> {
  const model = resolveModel(opts.model);
  const useCache = (opts.cache ?? true) && cacheEnabled();
  const key = cacheKey(model, state, questions);
  const cacheFile = join(paths.cacheDir(), `${key}.json`);
  const qCount = Object.keys(questions).length;

  if (useCache && existsSync(cacheFile)) {
    try {
      const hit = JSON.parse(readFileSync(cacheFile, "utf8")) as CacheEntry;
      if (staleReason(hit, model)) throw new Error("stale");
      recordUsage({
        ts: new Date().toISOString(),
        cmd: opts.command,
        model: hit.model,
        in: hit.usage.input_tokens,
        out: hit.usage.output_tokens,
        ms: 0,
        q: qCount,
        cached: true,
        project: projectName(),
        bands: countBands(hit.answers),
      });
      return { model: hit.model, answers: hit.answers, usage: hit.usage, ms: 0, cached: true };
    } catch {
      // fall through to a live call
    }
  }

  const started = performance.now();
  let raw;
  try {
    raw = await getClient(opts.fetch).systemOne(
      { state, questions, model },
      {
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        ...(opts.maxRetries !== undefined ? { retry: { maxRetries: opts.maxRetries } } : {}),
      },
    );
  } catch (error) {
    throw translateError(error);
  }
  const ms = Math.round(performance.now() - started);
  const result: EvalResult = {
    model: raw.model,
    answers: raw.answers as unknown as Record<string, Answer>,
    usage: raw.usage,
    ms,
    cached: false,
  };
  recordAlias(model, raw.model);
  recordUsage({
    ts: new Date().toISOString(),
    cmd: opts.command,
    model: raw.model,
    in: raw.usage.input_tokens,
    out: raw.usage.output_tokens,
    ms,
    q: qCount,
    cached: false,
    project: projectName(),
    bands: countBands(result.answers),
  });
  if (useCache) {
    try {
      ensureDir(paths.cacheDir());
      const entry: CacheEntry = { model: result.model, answers: result.answers, usage: result.usage, created: Date.now() };
      writeFileSync(cacheFile, JSON.stringify(entry));
    } catch {
      // cache is best-effort
    }
  }
  return result;
}

function translateError(error: unknown): AxiError {
  if (error instanceof AxiError) return error;
  if (error instanceof AuthenticationError) {
    return new AxiError("API key was rejected (401)", "AUTH_REQUIRED", [
      "Continue the task without jev-axi, and tell the user in your final answer that its API key was rejected",
      "The user can set a valid key with `export TYPESAFE_API_KEY=<key>` or `jev-axi config set apiKey <key>`",
    ]);
  }
  if (error instanceof RateLimitError) {
    return new AxiError("Rate limited by the TypeSafe API after retries (429)", "RATE_LIMITED", [
      "Wait a few seconds and rerun; batch more questions per call to reduce request count",
    ]);
  }
  if (error instanceof UnprocessableEntityError) {
    return new AxiError(`Request rejected by the API (422): ${detail(error.body)}`, "VALIDATION_ERROR", [
      "Check question shapes: choice needs `criteria` map, score needs >= 2 levels, noul needs `instructions`",
    ]);
  }
  if (error instanceof APIError && error.status === 400 && detail(error.body).includes("max_tokens_exceeded")) {
    return new AxiError("Request exceeds the model's token limit (~32k tokens for state plus questions)", "VALIDATION_ERROR", [
      "Send less state: lower --preview, --tail, or the number of items; batch commands chunk automatically but a single item can still be too large",
    ]);
  }
  if (error instanceof APIError) {
    const code = error.status === 529 ? "OVERLOADED" : error.status === 403 ? "API_REJECTED" : "API_ERROR";
    return new AxiError(`TypeSafe API error (${error.status}): ${detail(error.body) || error.message}`, code, [
      error.status === 529 ? "TypeSafe is overloaded; retry shortly" : "Retry; if it persists check https://status.typesafe.ai",
    ]);
  }
  if (error instanceof APIConnectionError) {
    return new AxiError(`Could not reach the TypeSafe API: ${error.message}`, "NETWORK", [
      "Check network access to api.typesafe.ai and retry",
    ]);
  }
  return new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
}

function detail(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 300);
  try {
    const b = body as Record<string, unknown>;
    const d = b["detail"] ?? b["error"] ?? b["message"] ?? body;
    return (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 300);
  } catch {
    return "";
  }
}

export async function listModels(fetch?: Fetch): Promise<{ name: string; description: string; release_date: string }[]> {
  try {
    return await getClient(fetch).models.list();
  } catch (error) {
    throw translateError(error);
  }
}

export { readConfig };
