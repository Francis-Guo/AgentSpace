import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_AGENT_TEMPLATE_PRESETS, getSystemAgentTemplatePreset } from "./agent-templates.ts";

test("Zero team templates are available across worker categories", () => {
  const zeroTemplates = SYSTEM_AGENT_TEMPLATE_PRESETS.filter((template) => template.id.startsWith("zero-"));
  const categories = new Set(zeroTemplates.map((template) => template.category));

  assert.equal(zeroTemplates.length, 11);
  assert.equal(Boolean(getSystemAgentTemplatePreset("zero-frontend-engineer")), true);
  assert.equal(Boolean(getSystemAgentTemplatePreset("zero-qa-engineer")), true);
  assert.equal(Boolean(getSystemAgentTemplatePreset("zero-security-reviewer")), true);
  assert.equal(Boolean(getSystemAgentTemplatePreset("zero-docs-writer")), true);
  assert.equal(categories.has("engineering"), true);
  assert.equal(categories.has("quality"), true);
  assert.equal(categories.has("security"), true);
  assert.equal(categories.has("documentation"), true);
});

test("Zero templates include verification-oriented instructions without hard runtime IDs", () => {
  const template = getSystemAgentTemplatePreset("zero-code-reviewer");

  assert.equal(template?.preferredProvider, "hermes");
  assert.equal(template?.preferredRuntimePurpose, "review");
  assert.match(template?.instructions ?? "", /Evidence \/ Verification Requirements/);
  assert.match(template?.instructions ?? "", /Do not hard-bind this template to Fei-specific runtime IDs/);
});
