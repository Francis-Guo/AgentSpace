import { accessSync, constants } from "node:fs";
import { isDaemonProvider, formatDaemonProviderLabel, type DaemonProvider } from "@agent-space/domain";
import type { RuntimeRegistrationInput } from "@agent-space/db";
import { buildProviderRuntimeMetadata, type DetectedProvider, type ProviderRuntimeRecord } from "./provider-runtime.ts";

export interface RuntimeVariantConfig {
  provider: DaemonProvider;
  runtimeKey: string;
  name?: string;
  profile?: string;
  model?: string;
  executablePath?: string;
  purpose?: string;
  costTier?: "premium" | "standard" | "cheap";
  maxConcurrentTasks?: number;
  metadata?: Record<string, unknown>;
}

export function parseRuntimeVariantConfigFromEnv(env: NodeJS.ProcessEnv): RuntimeVariantConfig[] | null {
  const raw = env.AGENT_SPACE_RUNTIME_VARIANTS_JSON?.trim();
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`AGENT_SPACE_RUNTIME_VARIANTS_JSON is invalid JSON: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("AGENT_SPACE_RUNTIME_VARIANTS_JSON must be a JSON array.");
  }

  const variants: RuntimeVariantConfig[] = [];
  const seenRuntimeKeys = new Set<string>();
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      console.warn(`Skipping runtime variant at index ${index}: expected an object.`);
      continue;
    }
    const record = item as Record<string, unknown>;
    const provider = readString(record.provider);
    if (!provider || !isDaemonProvider(provider)) {
      console.warn(`Skipping runtime variant at index ${index}: unsupported provider "${provider ?? ""}".`);
      continue;
    }

    const runtimeKey = readString(record.runtimeKey);
    if (!runtimeKey) {
      throw new Error(`Runtime variant at index ${index} is missing runtimeKey.`);
    }
    if (seenRuntimeKeys.has(runtimeKey)) {
      throw new Error(`Duplicate runtimeKey "${runtimeKey}" in AGENT_SPACE_RUNTIME_VARIANTS_JSON.`);
    }
    seenRuntimeKeys.add(runtimeKey);

    variants.push({
      provider,
      runtimeKey,
      name: readString(record.name),
      profile: readString(record.profile),
      model: readString(record.model),
      executablePath: readString(record.executablePath),
      purpose: readString(record.purpose),
      costTier: readCostTier(record.costTier),
      maxConcurrentTasks: readPositiveInteger(record.maxConcurrentTasks),
      metadata: readRecord(record.metadata),
    });
  }

  if (variants.length === 0) {
    throw new Error("AGENT_SPACE_RUNTIME_VARIANTS_JSON did not contain any valid runtime variants.");
  }
  return variants;
}

export function buildRuntimeRegistrations(input: {
  detected: DetectedProvider[];
  runtimeName: string;
  deviceName: string;
  mode: "local" | "remote";
  env: NodeJS.ProcessEnv;
}): RuntimeRegistrationInput[] {
  const variants = parseRuntimeVariantConfigFromEnv(input.env);
  if (!variants) {
    return input.detected.map((provider) => ({
      provider: provider.provider,
      runtimeKey: provider.provider,
      name: `${input.runtimeName} · ${provider.label}`,
      version: provider.version,
      deviceInfo: input.deviceName,
      metadata: buildProviderRuntimeMetadata({
        provider: provider.provider,
        metadata: {
          executablePath: provider.executablePath,
          mode: input.mode,
          runtimeKey: provider.provider,
        },
      }),
    }));
  }

  const detectedByProvider = new Map(input.detected.map((provider) => [provider.provider, provider]));
  const registrations: RuntimeRegistrationInput[] = [];
  for (const variant of variants) {
    const detected = detectedByProvider.get(variant.provider);
    const executablePath = variant.executablePath ?? detected?.executablePath;
    if (!executablePath || !isExecutable(executablePath)) {
      console.warn(`Skipping runtime variant "${variant.runtimeKey}": CLI for provider "${variant.provider}" was not found.`);
      continue;
    }

    const name = variant.name?.trim() || `${input.runtimeName} · ${formatDaemonProviderLabel(variant.provider)} · ${variant.runtimeKey}`;
    const metadata: Record<string, unknown> = {
      ...(variant.metadata ?? {}),
      executablePath,
      mode: input.mode,
      runtimeKey: variant.runtimeKey,
      variantLabel: name,
    };
    if (variant.provider === "hermes") {
      if (variant.profile) {
        metadata.hermesProfile = variant.profile;
      }
      if (variant.model) {
        metadata.hermesModel = variant.model;
      }
    }
    if (variant.purpose) {
      metadata.purpose = variant.purpose;
    }
    if (variant.costTier) {
      metadata.costTier = variant.costTier;
    }
    if (variant.maxConcurrentTasks) {
      metadata.maxConcurrentTasks = variant.maxConcurrentTasks;
    }

    registrations.push({
      provider: variant.provider,
      runtimeKey: variant.runtimeKey,
      name,
      version: detected?.version ?? "",
      deviceInfo: input.deviceName,
      metadata: buildProviderRuntimeMetadata({
        provider: variant.provider,
        metadata: metadata as ProviderRuntimeRecord["metadata"],
      }),
    });
  }

  if (registrations.length === 0) {
    throw new Error("No configured runtime variants are runnable; check provider CLIs and executablePath values.");
  }
  return registrations;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readCostTier(value: unknown): RuntimeVariantConfig["costTier"] | undefined {
  return value === "premium" || value === "standard" || value === "cheap" ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
