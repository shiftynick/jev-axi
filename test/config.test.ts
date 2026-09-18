import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keySearchDescription, resolveApiKey } from "../src/config.js";

describe("dotenv key discovery", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jev-config-"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    vi.stubEnv("TYPESAFE_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("finds .env.local at the repo root from a subdirectory, ahead of .env", () => {
    writeFileSync(join(root, ".env"), "TYPESAFE_API_KEY=committed-default\n");
    writeFileSync(join(root, ".env.local"), 'TYPESAFE_API_KEY="real-key"\n');
    vi.spyOn(process, "cwd").mockReturnValue(join(root, "src", "deep"));
    expect(resolveApiKey({})).toEqual({ key: "real-key", source: ".env", file: join(root, ".env.local") });
  });

  it("does not search above the git root, and says where it looked", () => {
    const repo = join(root, "nested");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(root, ".env"), "TYPESAFE_API_KEY=outside\n");
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    expect(resolveApiKey({}).source).toBe("missing");
    expect(keySearchDescription()).toContain(`.env.local and .env in ${repo}`);
  });
});
