import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildRemoteDaemonConfig,
  buildRemoteDaemonRelaunchCommand,
  buildRemoteRuntimeHeartbeatMetadata,
  buildRemoteRuntimeRecords,
  reconcileRemoteRuntimesWithHeartbeat,
  resolveRemoteTaskProviderSessionId,
} from "./remote-daemon.ts";

test("buildRemoteDaemonConfig reads env-backed defaults without repository state", () => {
  const config = buildRemoteDaemonConfig(
    {},
    {
      environment: {
        HOME: "/tmp/daemon-home",
        HOSTNAME: "daemon-box",
        AGENT_SPACE_SERVER_URL: "https://agentspace.example",
        AGENT_SPACE_DAEMON_TOKEN: "adt_test",
      },
    },
  );

  assert.equal(config.stateDir, join("/tmp/daemon-home", ".agent-space-daemon"));
  assert.equal(config.daemonKey, "daemon-box");
  assert.equal(config.deviceName, "daemon-box");
  assert.equal(config.runtimeName, "Remote Agent");
  assert.equal(config.serverUrl, "https://agentspace.example");
  assert.equal(config.daemonToken, "adt_test");
  assert.equal(config.taskTimeoutMs, 12 * 60 * 60 * 1000);
});

test("buildRemoteDaemonConfig prefers explicit flags over env", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
      "device-name": "gpu-box-1",
      "runtime-name": "GPU Agent",
      "server-url": "https://override.example",
      "daemon-token": "adt_override",
      "heartbeat-interval": "20000",
      "poll-interval": "5000",
      "task-timeout": "28800000",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
        HOSTNAME: "daemon-box",
        AGENT_SPACE_SERVER_URL: "https://agentspace.example",
        AGENT_SPACE_DAEMON_TOKEN: "adt_test",
      },
    },
  );

  assert.equal(config.stateDir, "/srv/daemon-state");
  assert.equal(config.daemonKey, "daemon-prod-01");
  assert.equal(config.deviceName, "gpu-box-1");
  assert.equal(config.runtimeName, "GPU Agent");
  assert.equal(config.serverUrl, "https://override.example");
  assert.equal(config.daemonToken, "adt_override");
  assert.equal(config.heartbeatIntervalMs, 20000);
  assert.equal(config.taskPollIntervalMs, 5000);
  assert.equal(config.taskTimeoutMs, 28800000);
});

test("buildRemoteDaemonRelaunchCommand reuses the installed daemon bin without strip-types", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
      "device-name": "gpu-box-1",
      "runtime-name": "GPU Agent",
      "server-url": "https://agentspace.example",
      "daemon-token": "adt_override",
      "heartbeat-interval": "20000",
      "poll-interval": "5000",
      "task-timeout": "28800000",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );

  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "/opt/agent-space/bin/agent-space-daemon.js"],
    execPath: "/usr/bin/node",
  });

  assert.equal(command.command, "/usr/bin/node");
  assert.equal(command.args[0], "/opt/agent-space/bin/agent-space-daemon.js");
  assert.equal(command.args.includes("--experimental-strip-types"), false);
  assert.deepEqual(command.args.slice(1, 8), [
    "start",
    "--foreground",
    "--state-dir",
    "/srv/daemon-state",
    "--daemon-id",
    "daemon-prod-01",
    "--device-name",
  ]);
  assert.equal(command.args.includes("--server-url"), true);
  assert.equal(command.args.includes("https://agentspace.example"), true);
  assert.equal(command.args.includes("--daemon-token"), true);
  assert.equal(command.args.includes("adt_override"), true);
});

test("buildRemoteDaemonRelaunchCommand resolves relative daemon bin paths before changing cwd", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );

  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "runtime/bin/agent-space-daemon.js"],
    execPath: "/usr/bin/node",
  });

  assert.equal(command.args[0], resolve("runtime/bin/agent-space-daemon.js"));
});

test("buildRemoteDaemonRelaunchCommand preserves strip-types only for source TypeScript entrypoints", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );

  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "packages/daemon/src/cli.ts"],
    execPath: "/usr/bin/node",
  });

  assert.deepEqual(command.args.slice(0, 4), [
    "--experimental-strip-types",
    resolve("packages/daemon/src/cli.ts"),
    "start",
    "--foreground",
  ]);
});

test("resolveRemoteTaskProviderSessionId reads channel session from task payload", () => {
  assert.equal(
    resolveRemoteTaskProviderSessionId(JSON.stringify({ channelSessionId: " session-1 " })),
    "session-1",
  );
  assert.equal(resolveRemoteTaskProviderSessionId(JSON.stringify({ channelSessionId: "" })), undefined);
  assert.equal(resolveRemoteTaskProviderSessionId("{not-json"), undefined);
});

test("buildRemoteRuntimeRecords reconciles duplicate-provider variants by runtimeKey", () => {
  const config = buildRemoteDaemonConfig(
    {
      "device-name": "Build Box",
      "runtime-name": "Fei AgentSpace",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );
  const registrations = [
    {
      provider: "hermes" as const,
      runtimeKey: "hermes:zero-qa:cheap",
      name: "Hermes QA Cheap",
      version: "hermes 0.2.0",
      deviceInfo: "Build Box",
      metadata: {
        executablePath: "/usr/local/bin/hermes",
        mode: "remote" as const,
        runtimeKey: "hermes:zero-qa:cheap",
        variantLabel: "Hermes QA Cheap",
        hermesProfile: "zero-qa",
        hermesModel: "deepseek-v4-flash",
        purpose: "qa/batch",
        costTier: "cheap" as const,
      },
    },
    {
      provider: "hermes" as const,
      runtimeKey: "hermes:zero-review:gpt-5.5",
      name: "Hermes Review Premium",
      version: "hermes 0.2.0",
      deviceInfo: "Build Box",
      metadata: {
        executablePath: "/usr/local/bin/hermes",
        mode: "remote" as const,
        runtimeKey: "hermes:zero-review:gpt-5.5",
        variantLabel: "Hermes Review Premium",
        hermesProfile: "zero-review",
        hermesModel: "cliproxy/gpt-5.5",
        purpose: "review",
        costTier: "premium" as const,
      },
    },
  ];

  const records = buildRemoteRuntimeRecords(
    config,
    {
      daemon: {
        daemonKey: "build-box",
        status: "online",
        workspaceId: "workspace-1",
      },
      runtimes: [
        {
          id: "runtime-review",
          provider: "hermes",
          runtimeKey: "hermes:zero-review:gpt-5.5",
          name: "Registered Review",
          status: "online",
        },
        {
          id: "runtime-qa",
          provider: "hermes",
          runtimeKey: "hermes:zero-qa:cheap",
          name: "Registered QA",
          status: "online",
        },
      ],
    },
    registrations,
  );

  assert.equal(records.length, 2);
  const qaRuntime = records.find((runtime) => runtime.metadata.runtimeKey === "hermes:zero-qa:cheap");
  const reviewRuntime = records.find((runtime) => runtime.metadata.runtimeKey === "hermes:zero-review:gpt-5.5");
  assert.equal(qaRuntime?.id, "runtime-qa");
  assert.equal(qaRuntime?.metadata.hermesProfile, "zero-qa");
  assert.equal(qaRuntime?.metadata.hermesModel, "deepseek-v4-flash");
  assert.equal(reviewRuntime?.id, "runtime-review");
  assert.equal(reviewRuntime?.metadata.hermesProfile, "zero-review");
  assert.equal(reviewRuntime?.metadata.hermesModel, "cliproxy/gpt-5.5");
});

test("remote runtime heartbeat metadata preserves variant identity and profile details", () => {
  const runtimes = [
    {
      id: "runtime-qa",
      workspaceId: "workspace-1",
      provider: "hermes" as const,
      name: "Hermes QA Cheap",
      version: "hermes 0.2.0",
      status: "online" as const,
      deviceInfo: "Build Box",
      metadata: {
        executablePath: "/usr/local/bin/hermes",
        mode: "remote" as const,
        runtimeKey: "hermes:zero-qa:cheap",
        variantLabel: "Hermes QA Cheap",
        hermesProfile: "zero-qa",
        hermesModel: "deepseek-v4-flash",
        purpose: "qa/batch",
        costTier: "cheap" as const,
      },
    },
    {
      id: "runtime-review",
      workspaceId: "workspace-1",
      provider: "hermes" as const,
      name: "Hermes Review Premium",
      version: "hermes 0.2.0",
      status: "online" as const,
      deviceInfo: "Build Box",
      metadata: {
        executablePath: "/usr/local/bin/hermes",
        mode: "remote" as const,
        runtimeKey: "hermes:zero-review:gpt-5.5",
        variantLabel: "Hermes Review Premium",
        hermesProfile: "zero-review",
        hermesModel: "cliproxy/gpt-5.5",
      },
    },
  ];

  const heartbeatMetadata = buildRemoteRuntimeHeartbeatMetadata(runtimes);

  assert.deepEqual(
    heartbeatMetadata.map((runtime) => runtime.metadata.runtimeKey),
    ["hermes:zero-qa:cheap", "hermes:zero-review:gpt-5.5"],
  );
  assert.equal(heartbeatMetadata[0]?.metadata.hermesProfile, "zero-qa");
  assert.equal(heartbeatMetadata[0]?.metadata.hermesModel, "deepseek-v4-flash");

  const reconciled = reconcileRemoteRuntimesWithHeartbeat(runtimes, {
    daemon: {
      daemonKey: "build-box",
      status: "online",
      workspaceId: "workspace-1",
    },
    runtimes: [
      {
        id: "runtime-qa",
        provider: "hermes",
        runtimeKey: "hermes:zero-qa:cheap",
        status: "online",
        metadata: {
          providerHealth: { providerUsable: "usable" },
        },
      },
    ],
  });

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.id, "runtime-qa");
  assert.equal(reconciled[0]?.metadata.runtimeKey, "hermes:zero-qa:cheap");
  assert.equal(reconciled[0]?.metadata.hermesProfile, "zero-qa");
  assert.deepEqual(reconciled[0]?.metadata.providerHealth, { providerUsable: "usable" });
});
