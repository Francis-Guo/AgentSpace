import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const configDir = dirname(fileURLToPath(import.meta.url));
const e2eEnv = prepareE2eDatabaseEnv();
const webServerEnv = toWebServerEnv({ ...process.env, ...e2eEnv });
const port = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL,
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  webServer: {
    command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${port}`,
    env: webServerEnv,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});

function prepareE2eDatabaseEnv(): Record<string, string> {
  const explicitTestDatabaseUrl = process.env.AGENT_SPACE_TEST_DATABASE_URL?.trim()
    || process.env.AGENT_SPACE_PG_TEST_URL?.trim();
  if (explicitTestDatabaseUrl && process.env.AGENT_SPACE_E2E_FORCE_NEON_BRANCH !== "1") {
    const env = {
      AGENT_SPACE_E2E: "1",
      AGENT_SPACE_E2E_DATABASE_URL: explicitTestDatabaseUrl,
      AGENT_SPACE_E2E_NEON_BRANCH_ID: process.env.AGENT_SPACE_E2E_NEON_BRANCH_ID ?? "local-test-database",
      AGENT_SPACE_E2E_NEON_BRANCH_NAME: process.env.AGENT_SPACE_E2E_NEON_BRANCH_NAME ?? "e2e-local-test-database",
      AGENT_SPACE_TEST_DATABASE_URL: explicitTestDatabaseUrl,
      AGENT_SPACE_PG_TEST_URL: explicitTestDatabaseUrl,
      AGENT_SPACE_PG_URL: explicitTestDatabaseUrl,
      DATABASE_URL: explicitTestDatabaseUrl,
      NEON_DATABASE_URL: explicitTestDatabaseUrl,
    };
    Object.assign(process.env, env);
    console.log("[e2e] Using explicit local test database.");
    return env;
  }

  const scriptPath = join(configDir, "scripts", "prepare-e2e-neon-branch.mjs");
  const raw = execFileSync(process.execPath, [scriptPath, "--json"], {
    cwd: resolve(configDir, "..", ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_SPACE_E2E_FORCE_NEON_BRANCH: process.env.AGENT_SPACE_E2E_FORCE_NEON_BRANCH ?? "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!raw) {
    throw new Error("E2E database setup returned empty output.");
  }
  const parsed = JSON.parse(raw) as { env?: Record<string, string>; branchName?: string };
  if (!parsed.env?.AGENT_SPACE_TEST_DATABASE_URL) {
    throw new Error("E2E database setup did not return AGENT_SPACE_TEST_DATABASE_URL.");
  }
  Object.assign(process.env, parsed.env);
  if (parsed.branchName) {
    console.log(`[e2e] Using Neon test branch ${parsed.branchName}.`);
  }
  return parsed.env;
}

function toWebServerEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
