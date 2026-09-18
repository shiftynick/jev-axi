import { defineConfig } from "vitest/config";
// NO_UPDATE_NOTIFIER keeps the suite (and the CLIs it spawns) off the npm registry.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], pool: "forks", env: { NO_UPDATE_NOTIFIER: "1" } } });
