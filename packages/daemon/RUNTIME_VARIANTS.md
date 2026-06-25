# Runtime Variants

AgentSpace daemons can register multiple execution variants for the same provider. This is intended for Hermes profiles/models, but the identity model is generic.

## Configuration

If `AGENT_SPACE_RUNTIME_VARIANTS_JSON` is unset, daemon startup keeps the legacy behavior: one detected runtime per provider with `runtimeKey = provider`.

When the env var is set, it must be a JSON array. Each configured variant must have a stable `runtimeKey`.

```json
[
  {
    "provider": "hermes",
    "runtimeKey": "hermes:zero-qa:cheap",
    "name": "Hermes QA Cheap",
    "profile": "zero-qa",
    "model": "deepseek-v4-flash",
    "purpose": "qa/batch",
    "costTier": "cheap",
    "maxConcurrentTasks": 1
  },
  {
    "provider": "hermes",
    "runtimeKey": "hermes:zero-review:gpt-5.5",
    "name": "Hermes Review Premium",
    "profile": "zero-review",
    "model": "cliproxy/gpt-5.5",
    "purpose": "review",
    "costTier": "premium"
  }
]
```

Rules:

- Duplicate `runtimeKey` values fail startup or API registration.
- Invalid JSON fails startup.
- Unknown providers are skipped with a warning while at least one valid runnable variant remains.
- Missing CLIs are skipped with a warning unless every configured variant is unrunnable.
- Blank `runtimeKey` is allowed only in legacy no-config mode, where it defaults to `provider`.

Hermes launch uses metadata in this order:

- `hermesProfile` from variant `profile` becomes `--profile <profile>`.
- `hermesModel` from variant `model` becomes `--model <model>`.
- If `hermesModel` is absent, the daemon falls back to `HERMES_MODEL` and then `HERMES_INFERENCE_MODEL`.

## Concurrency

Variant config may include `maxConcurrentTasks`, and AgentSpace preserves it in runtime metadata for display, routing policy, and future schedulers.

The current remote daemon task poller is still single-flight per runtime process record: while one runtime ID is active, that same runtime is skipped by the poll loop until the task or runtime-app operation finishes. Separate runtime variants have separate runtime IDs, so two Hermes variants can claim and run independent tasks at the same time, while each individual variant remains single-flight.

## Database Migration

Schema version `19` adds `agent_runtime.runtime_key`.

Schema delta:

```sql
ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS runtime_key TEXT;

UPDATE agent_runtime
SET runtime_key = provider
WHERE runtime_key IS NULL OR btrim(runtime_key) = '';

DROP INDEX IF EXISTS idx_agent_runtime_workspace_daemon_provider;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtime_workspace_daemon_runtime_key
  ON agent_runtime(workspace_id, daemon_connection_id, runtime_key);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_workspace_daemon_provider
  ON agent_runtime(workspace_id, daemon_connection_id, provider);
```

Rollback before the new unique index is created:

```sql
DROP INDEX IF EXISTS idx_agent_runtime_workspace_daemon_runtime_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtime_workspace_daemon_provider
  ON agent_runtime(workspace_id, daemon_connection_id, provider);
```

Rollback after multiple variants have been registered requires deleting or merging duplicate-provider rows first, because the old provider-unique index cannot represent more than one Hermes runtime per daemon.

Verification query:

```sql
SELECT workspace_id, daemon_connection_id, runtime_key, COUNT(*)
FROM agent_runtime
GROUP BY workspace_id, daemon_connection_id, runtime_key
HAVING COUNT(*) > 1;
```

Expected result: zero rows.
