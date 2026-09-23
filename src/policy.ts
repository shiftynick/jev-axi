import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { paths } from "./config.js";
import { redactSecrets, type ToolCall } from "./safety.js";

export const MAX_POLICY_BYTES = 16_384;

export function policyPath(value: string): string {
  return resolve(value.replace(/^~(?=[\\/]|$)/, homedir()));
}

/** A malformed settings file must not silently disable a previously enabled policy. */
export function configuredPolicyFile(): string | undefined {
  const file = paths.configFile();
  if (!existsSync(file)) return undefined;
  const config = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("jev-axi settings are invalid");
  const safety = (config as Record<string, unknown>)["safety"];
  if (safety === undefined) return undefined;
  if (!safety || typeof safety !== "object" || Array.isArray(safety)) throw new Error("jev-axi safety settings are invalid");
  const value = (safety as Record<string, unknown>)["policyFile"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("configured policy path must be absolute");
  return value;
}

/** Read on every check so a policy edit takes effect immediately and changes the cache key. */
export function loadPolicy(value: string): { path: string; text: string } {
  const path = realpathSync(policyPath(value));
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("policy path is not a regular file");
  if (stat.size > MAX_POLICY_BYTES) throw new Error(`policy file exceeds ${MAX_POLICY_BYTES} bytes`);
  const text = readFileSync(path, "utf8").trim();
  if (!text) throw new Error("policy file is empty");
  return { path, text: redactSecrets(text) };
}

/** Prevent an agent's direct file editing tool from rewriting the policy it is checked against. */
export function editsPolicyFile(call: ToolCall, path: string): boolean {
  if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.tool_name)) return false;
  const target = call.tool_input["file_path"] ?? call.tool_input["notebook_path"];
  if (typeof target !== "string" || !target) return false;
  const candidate = resolve(call.cwd ?? process.cwd(), target.replace(/^~(?=[\\/]|$)/, homedir()));
  if (candidate === path) return true;
  try {
    return realpathSync(candidate) === path;
  } catch {
    return false;
  }
}
