import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Prices {
  /** USD per 1M input tokens. */
  input?: number;
  /** USD per 1M output tokens. */
  output?: number;
}

export interface Thresholds {
  act: number;
  confirm: number;
}

export interface JevConfig {
  apiKey?: string;
  model?: string;
  price?: Prices;
  thresholds?: Partial<Thresholds>;
  /** Hours a cached response stays valid; 0 disables the cache. */
  cacheTtlHours?: number;
  /** false turns off the daily npm registry check behind the update notice. */
  updateCheck?: boolean;
}

export const DEFAULT_CACHE_TTL_HOURS = 24;

export function resolveCacheTtlHours(config = readConfig()): number {
  return config.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS;
}

export const DEFAULT_MODEL = "jev-latest";
/** USD per 1M tokens. Jev bills input only; output tokens are free unless a config override says otherwise. */
export const DEFAULT_PRICE: Required<Prices> = { input: 0.042, output: 0 };
export const DEFAULT_THRESHOLDS: Thresholds = { act: 0.75, confirm: 0.45 };

/** One-time rename of a directory left by the briefly used `jev-cli` name, if the current one does not exist yet. */
function adoptLegacyDir(dir: string): string {
  const legacy = join(dirname(dir), "jev-cli");
  if (!existsSync(dir) && existsSync(legacy)) {
    try {
      renameSync(legacy, dir);
    } catch {
      // leave both in place; the caller will just create the new dir
    }
  }
  return dir;
}

function base(kind: "config" | "state" | "cache"): string {
  return adoptLegacyDir(baseUnmigrated(kind));
}

function baseUnmigrated(kind: "config" | "state" | "cache"): string {
  const home = homedir();
  // Explicit XDG overrides win on every platform (tests and containers rely on this).
  const xdg = { config: "XDG_CONFIG_HOME", state: "XDG_STATE_HOME", cache: "XDG_CACHE_HOME" }[kind];
  const override = process.env[xdg]?.trim();
  if (override) return join(override, "jev-axi");
  if (process.platform === "win32") {
    const appdata = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
    const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    return kind === "config" ? join(appdata, "jev-axi") : join(local, "jev-axi", kind);
  }
  const defaults = { config: join(home, ".config"), state: join(home, ".local", "state"), cache: join(home, ".cache") };
  return join(defaults[kind], "jev-axi");
}

export const paths = {
  configDir: () => base("config"),
  configFile: () => join(base("config"), "config.json"),
  /** Stats live in the user config folder so they travel with the user's settings. */
  statsDir: () => join(base("config"), "stats"),
  usageLedger: () => join(base("config"), "stats", "usage.jsonl"),
  /** Pre-0.2 location, migrated on first write. */
  legacyUsageLedger: () => join(base("state"), "usage.jsonl"),
  /** One line per supervision verdict, written by the Stop and PostToolUse hooks. */
  superviseLog: () => join(base("config"), "stats", "supervise.jsonl"),
  cacheDir: () => base("cache"),
  /** Per-session event tails for the supervision hooks. */
  sessionsDir: () => join(base("state"), "sessions"),
  stateDir: () => base("state"),
  /** Latest published version and when it was last looked up. */
  updateCheck: () => join(base("state"), "update-check.json"),
};

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readConfig(): JevConfig {
  const file = paths.configFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JevConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: JevConfig): void {
  ensureDir(paths.configDir());
  writeFileSync(paths.configFile(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** Read TYPESAFE_API_KEY from a .env in the working directory, if present. */
function dotenvKey(cwd = process.cwd()): string | undefined {
  const file = join(cwd, ".env");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return m[1]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

export interface ResolvedKey {
  key?: string;
  source: "env" | ".env" | "config" | "missing";
}

export function resolveApiKey(config = readConfig()): ResolvedKey {
  const env = process.env["TYPESAFE_API_KEY"]?.trim();
  if (env) return { key: env, source: "env" };
  const dot = dotenvKey();
  if (dot) return { key: dot, source: ".env" };
  if (config.apiKey) return { key: config.apiKey, source: "config" };
  return { source: "missing" };
}

export function resolveModel(override?: string, config = readConfig()): string {
  return override ?? process.env["TYPESAFE_DEFAULT_MODEL"] ?? config.model ?? DEFAULT_MODEL;
}

export function resolveThresholds(
  overrides: Partial<Thresholds>,
  config = readConfig(),
): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...config.thresholds, ...stripUndefined(overrides) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function resolvePrices(config = readConfig()): Required<Prices> {
  return { input: config.price?.input ?? DEFAULT_PRICE.input, output: config.price?.output ?? DEFAULT_PRICE.output };
}

export function redactKey(key: string): string {
  if (key.length <= 12) return "****";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}
