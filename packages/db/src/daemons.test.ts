import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  heartbeatDaemonSync,
  listDaemonSnapshotsSync,
  markDaemonOfflineSync,
  pruneOfflineDaemonsSync,
  readDaemonSnapshotSync,
  registerDaemonRuntimesSync,
} from "./index.ts";
import { getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-db-daemons-"));
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  ensureWorkspaceRow("default", "Default Workspace");
  ensureWorkspaceRow("workspace-mars", "Mars Workspace");
});

test("prunes old offline daemon connections within the target workspace", () => {
  registerDaemon("old-default", "default");
  registerDaemon("recent-default", "default");
  registerDaemon("online-default", "default");
  registerDaemon("old-mars", "workspace-mars");

  markDaemonOfflineSync("old-default");
  markDaemonOfflineSync("recent-default");
  markDaemonOfflineSync("old-mars");

  const db = getDatabase();
  const oldHeartbeat = new Date(Date.now() - eightDaysMs()).toISOString();
  const recentHeartbeat = new Date(Date.now() - sixDaysMs()).toISOString();
  db.prepare("UPDATE daemon_connection SET last_heartbeat_at = ? WHERE daemon_key IN (?, ?)")
    .run(oldHeartbeat, "old-default", "old-mars");
  db.prepare("UPDATE daemon_connection SET last_heartbeat_at = ? WHERE daemon_key = ?")
    .run(recentHeartbeat, "recent-default");

  const removed = pruneOfflineDaemonsSync(sevenDaysMs, { workspaceId: "default" });

  assert.equal(removed, 1);
  assert.deepEqual(listDaemonSnapshotsSync("default").map((snapshot) => snapshot.daemon.daemonKey).sort(), [
    "online-default",
    "recent-default",
  ]);
  assert.deepEqual(listDaemonSnapshotsSync("workspace-mars").map((snapshot) => snapshot.daemon.daemonKey), [
    "old-mars",
  ]);
});

test("heartbeat can refresh daemon metadata without changing runtimes", () => {
  registerDaemon("build-box-readiness", "default");

  const snapshot = heartbeatDaemonSync("build-box-readiness", {
    metadata: {
      mode: "remote",
      googleWorkspaceReadiness: {
        executor: "gws",
        gws: { available: true, version: "gws 0.22.5" },
      },
    },
  });
  const metadata = JSON.parse(snapshot.daemon.metadataJson) as {
    googleWorkspaceReadiness?: {
      executor?: string;
      gws?: { available?: boolean; version?: string };
    };
  };

  assert.equal(metadata.googleWorkspaceReadiness?.executor, "gws");
  assert.equal(metadata.googleWorkspaceReadiness?.gws?.available, true);
  assert.equal(snapshot.runtimes.length, 1);
});

test("registers multiple runtime variants for the same provider under one daemon", () => {
  const initial = registerDaemonRuntimesSync({
    daemonKey: "variant-box",
    deviceName: "Build Box",
    workspaceId: "default",
    runtimes: [
      {
        provider: "hermes",
        runtimeKey: "hermes:zero-qa:cheap",
        name: "Hermes QA Cheap",
        version: "0.2.0",
        metadata: { runtimeKey: "hermes:zero-qa:cheap", hermesProfile: "zero-qa", hermesModel: "deepseek-v4-flash" },
      },
      {
        provider: "hermes",
        runtimeKey: "hermes:zero-review:gpt-5.5",
        name: "Hermes Review Premium",
        version: "0.2.0",
        metadata: { runtimeKey: "hermes:zero-review:gpt-5.5", hermesProfile: "zero-review", hermesModel: "cliproxy/gpt-5.5" },
      },
    ],
  });

  assert.equal(initial.runtimes.length, 2);
  assert.deepEqual(initial.runtimes.map((runtime) => runtime.runtimeKey), [
    "hermes:zero-qa:cheap",
    "hermes:zero-review:gpt-5.5",
  ]);
  const qaRuntimeId = initial.runtimes.find((runtime) => runtime.runtimeKey === "hermes:zero-qa:cheap")?.id;
  const reviewRuntimeId = initial.runtimes.find((runtime) => runtime.runtimeKey === "hermes:zero-review:gpt-5.5")?.id;
  assert.ok(qaRuntimeId);
  assert.ok(reviewRuntimeId);
  assert.notEqual(qaRuntimeId, reviewRuntimeId);

  const repeated = registerDaemonRuntimesSync({
    daemonKey: "variant-box",
    deviceName: "Build Box",
    workspaceId: "default",
    runtimes: [
      {
        provider: "hermes",
        runtimeKey: "hermes:zero-qa:cheap",
        name: "Hermes QA Cheap v2",
        version: "0.3.0",
        metadata: { runtimeKey: "hermes:zero-qa:cheap", hermesProfile: "zero-qa", hermesModel: "deepseek-v4-flash-v2" },
      },
      {
        provider: "hermes",
        runtimeKey: "hermes:zero-review:gpt-5.5",
        name: "Hermes Review Premium",
        version: "0.2.0",
        metadata: { runtimeKey: "hermes:zero-review:gpt-5.5", hermesProfile: "zero-review", hermesModel: "cliproxy/gpt-5.5" },
      },
    ],
  });

  const repeatedQa = repeated.runtimes.find((runtime) => runtime.runtimeKey === "hermes:zero-qa:cheap");
  assert.equal(repeatedQa?.id, qaRuntimeId);
  assert.equal(repeatedQa?.name, "Hermes QA Cheap v2");
  assert.equal(JSON.parse(repeatedQa?.metadataJson ?? "{}").hermesModel, "deepseek-v4-flash-v2");

  const removedReview = registerDaemonRuntimesSync({
    daemonKey: "variant-box",
    deviceName: "Build Box",
    workspaceId: "default",
    runtimes: [
      {
        provider: "hermes",
        runtimeKey: "hermes:zero-qa:cheap",
        name: "Hermes QA Cheap v2",
        version: "0.3.0",
      },
    ],
  });
  assert.equal(removedReview.runtimes.find((runtime) => runtime.id === qaRuntimeId)?.status, "online");
  assert.equal(removedReview.runtimes.find((runtime) => runtime.id === reviewRuntimeId)?.status, "offline");
});

test("legacy runtime registration without runtimeKey still keys by provider", () => {
  const first = registerDaemonRuntimesSync({
    daemonKey: "legacy-box",
    deviceName: "Build Box",
    workspaceId: "default",
    runtimes: [{ provider: "codex", name: "Codex", version: "1.0.0" }],
  });
  const second = registerDaemonRuntimesSync({
    daemonKey: "legacy-box",
    deviceName: "Build Box",
    workspaceId: "default",
    runtimes: [{ provider: "codex", name: "Codex v2", version: "1.1.0" }],
  });

  assert.equal(first.runtimes[0]?.runtimeKey, "codex");
  assert.equal(second.runtimes[0]?.runtimeKey, "codex");
  assert.equal(second.runtimes[0]?.id, first.runtimes[0]?.id);
  assert.equal(second.runtimes[0]?.name, "Codex v2");
});

test("heartbeat can target duplicate-provider variants by runtimeKey", () => {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: "heartbeat-variant-box",
    deviceName: "Build Box",
    workspaceId: "default",
    runtimes: [
      { provider: "hermes", runtimeKey: "hermes:zero-qa", name: "Hermes QA" },
      { provider: "hermes", runtimeKey: "hermes:zero-review", name: "Hermes Review" },
    ],
  });

  const updated = heartbeatDaemonSync("heartbeat-variant-box", {
    runtimes: [{
      runtimeKey: "hermes:zero-qa",
      provider: "hermes",
      metadata: { providerHealth: { status: "healthy" } },
    }],
  });
  const qaMetadata = JSON.parse(updated.runtimes.find((runtime) => runtime.runtimeKey === "hermes:zero-qa")?.metadataJson ?? "{}");
  const reviewMetadata = JSON.parse(updated.runtimes.find((runtime) => runtime.runtimeKey === "hermes:zero-review")?.metadataJson ?? "{}");

  assert.equal(snapshot.runtimes.length, 2);
  assert.equal(qaMetadata.providerHealth.status, "healthy");
  assert.equal(reviewMetadata.providerHealth, undefined);
});

test("heartbeat can refresh runtime provider health metadata", () => {
  registerDaemon("openclaw-box", "default");
  const runtime = readDaemonSnapshotSync("openclaw-box").runtimes[0]!;

  const snapshot = heartbeatDaemonSync("openclaw-box", {
    runtimes: [{
      id: runtime.id,
      provider: runtime.provider,
      metadata: {
        providerHealth: {
          status: "broken",
          reason: "OpenClaw auth profile is missing.",
          error: {
            code: "provider.profile_missing",
            category: "profile",
            message: "OpenClaw auth profile is missing.",
          },
        },
      },
    }],
  });
  const metadata = JSON.parse(snapshot.runtimes[0]!.metadataJson) as {
    providerHealth?: { status?: string; error?: { code?: string } };
  };

  assert.equal(metadata.providerHealth?.status, "broken");
  assert.equal(metadata.providerHealth?.error?.code, "provider.profile_missing");
});

test.after(() => {
  process.chdir(originalCwd);
});

function registerDaemon(daemonKey: string, workspaceId: string): void {
  registerDaemonRuntimesSync({
    daemonKey,
    deviceName: "Build Box",
    workspaceId,
    runtimes: [
      {
        provider: "codex",
        name: "Remote Agent · Codex",
        version: "1.0.0",
      },
    ],
  });
}

function ensureWorkspaceRow(workspaceId: string, name: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES ('daemon-test-user', 'Daemon Test User', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspace (
       id,
       slug,
       name,
       created_by,
       created_at,
       updated_at,
       join_code,
       join_code_updated_at,
       join_code_updated_by
     )
     VALUES (?, ?, ?, 'daemon-test-user', ?, ?, ?, ?, 'daemon-test-user')
     ON CONFLICT(id) DO UPDATE SET
       name = EXCLUDED.name,
       updated_at = EXCLUDED.updated_at`,
  ).run(workspaceId, workspaceId, name, now, now, `join-${workspaceId}`, now);
}

function eightDaysMs(): number {
  return 8 * 24 * 60 * 60 * 1000;
}

function sixDaysMs(): number {
  return 6 * 24 * 60 * 60 * 1000;
}
