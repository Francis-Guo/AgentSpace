import { expect, test } from "@playwright/test";
import {
  bindEmployeeRuntimeSync,
  claimNextQueuedTaskForRuntimeSync,
  createStoredEmployeeSync,
  enqueueNativeTaskSync,
  readQueuedTaskSync,
  registerDaemonRuntimesSync,
} from "../../../packages/db/src/index.ts";
import { readWorkspaceStateSync, writeWorkspaceStateSync } from "../../../packages/services/src/index.ts";
import { openSeededWorkspacePage } from "./helpers";

test("keeps an employee task bound to its Hermes runtime variant", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/agents?mode=container");
  const suffix = Date.now().toString(36);
  const employeeName = `Runtime QA ${suffix}`;
  const intendedKey = `hermes-profile:e2e-intended-${suffix}`;
  const wrongKey = `hermes-profile:e2e-wrong-${suffix}`;

  const snapshot = registerDaemonRuntimesSync({
    daemonKey: `e2e-runtime-variants-${suffix}`,
    deviceName: "E2E Runtime Variants",
    workspaceId: session.workspaceId,
    runtimes: [
      {
        provider: "hermes",
        runtimeKey: intendedKey,
        name: "E2E Hermes Intended",
        version: "0.0.0-e2e",
        metadata: { hermesModel: "deepseek-v4-flash", hermesProfile: `e2e-intended-${suffix}`, runtimeKey: intendedKey },
      },
      {
        provider: "hermes",
        runtimeKey: wrongKey,
        name: "E2E Hermes Wrong",
        version: "0.0.0-e2e",
        metadata: { hermesModel: "gpt-5.5", hermesProfile: `e2e-wrong-${suffix}`, runtimeKey: wrongKey },
      },
    ],
  });
  const intendedRuntime = snapshot.runtimes.find((runtime) => runtime.runtimeKey === intendedKey);
  const wrongRuntime = snapshot.runtimes.find((runtime) => runtime.runtimeKey === wrongKey);
  expect(intendedRuntime?.id).toBeTruthy();
  expect(wrongRuntime?.id).toBeTruthy();

  const employee = {
    name: employeeName,
    role: "Runtime variant QA",
    remarkName: employeeName,
    channelMemberAccess: "enabled" as const,
    origin: "e2e-runtime-variant",
    summary: "E2E employee bound to a specific Hermes runtime variant.",
    traits: [],
    fit: "Verifies runtime variant task isolation.",
    skillIds: [],
    channels: [session.channelName],
    status: "active" as const,
    instructions: "Answer only with runtime variant smoke evidence.",
  };
  createStoredEmployeeSync(employee, session.workspaceId);
  const state = readWorkspaceStateSync(session.workspaceId);
  writeWorkspaceStateSync({
    ...state,
    activeEmployees: [...state.activeEmployees.filter((item) => item.name !== employeeName), employee],
    channels: state.channels.map((channel) => channel.name === session.channelName
      ? { ...channel, employeeNames: [...new Set([...channel.employeeNames, employeeName])] }
      : channel),
  }, session.workspaceId, { skipVersionCheck: true });
  bindEmployeeRuntimeSync({
    employeeName,
    runtimeId: intendedRuntime!.id,
    workspaceId: session.workspaceId,
  });

  await page.goto(`/w/${session.workspaceSlug}/agents?mode=container`);
  await expect(page.getByRole("heading", { name: /在线执行引擎|Online execution engines/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E Hermes Intended" })).toBeVisible();
  await expect(page.getByRole("button", { name: "E2E Hermes Wrong No remark" })).toBeVisible();

  await page.getByRole("link", { name: /员工管理|Agent Management/i }).click();
  await expect(page.getByRole("heading", { name: /全部 Agent|All agents/i })).toBeVisible();
  const closeOnboarding = page.getByRole("button", { name: /关闭新手引导|Close onboarding/i });
  if (await closeOnboarding.isVisible().catch(() => false)) {
    await closeOnboarding.click();
  }
  await expect(page.getByRole("button", { name: new RegExp(`${escapeRegExp(employeeName)}.*E2E Hermes Intended`) })).toBeVisible();

  const task = enqueueNativeTaskSync({
    assignee: employeeName,
    channel: session.channelName,
    priority: "high",
    requestedByDisplayName: session.userDisplayName,
    taskId: `runtime-e2e-${suffix}`,
    title: "Runtime variant isolation E2E",
    triggerType: "manual",
    workspaceId: session.workspaceId,
    metadata: {
      channelName: session.channelName,
      prompt: "Return RUNTIME_VARIANT_E2E_OK.",
      sourceType: "e2e",
    },
  });
  expect(task?.runtimeId).toBe(intendedRuntime!.id);

  const wrongClaim = claimNextQueuedTaskForRuntimeSync(wrongRuntime!.id, session.workspaceId);
  expect(wrongClaim).toBeNull();
  expect(readQueuedTaskSync(task!.id)?.runtimeId).toBe(intendedRuntime!.id);

  const intendedClaim = claimNextQueuedTaskForRuntimeSync(intendedRuntime!.id, session.workspaceId);
  expect(intendedClaim?.id).toBe(task!.id);
  expect(intendedClaim?.runtimeId).toBe(intendedRuntime!.id);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
