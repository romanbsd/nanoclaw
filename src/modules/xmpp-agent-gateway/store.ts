import { randomUUID } from 'crypto';

import {
  terminalTaskStates,
  type AgentApiManifest,
  type AgentTaskEvent,
  type AgentTaskRecord,
  type AgentTaskState,
  type RegisteredAgent,
  type RegisteredOperation,
  type VirtualMcpEndpoint,
} from '@agent-xmpp/protocol';

import { getDb } from '../../db/connection.js';
import { digestJson, validateManifest } from './schema.js';

interface ApiRow {
  jid: string;
  version: string;
  tenant_id: string;
  manifest_json: string;
  manifest_digest: string;
  availability: RegisteredAgent['availability'];
  registered_at: string;
}

interface TaskRow {
  task_id: string;
  root_task_id: string;
  parent_task_id: string | null;
  caller_jid: string;
  caller_session_id: string | null;
  target_jid: string;
  tenant_id: string;
  workspace_id: string | null;
  endpoint_id: string;
  operation: string;
  api_version: string;
  input_schema_digest: string;
  output_schema_digest: string | null;
  arguments_json: string;
  state: AgentTaskState;
  attempt: number;
  idempotency_key: string | null;
  correlation_id: string;
  deadline: string | null;
  result_json: string | null;
  error_json: string | null;
  summary: string | null;
  created_at: string;
  accepted_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export class XmppAgentGatewayStore {
  registerManifest(value: unknown, tenantId: string): RegisteredAgent {
    const manifest = validateManifest(value);
    const registeredAt = new Date().toISOString();
    const manifestDigest = digestJson(manifest);
    getDb()
      .prepare(
        `INSERT INTO xmpp_agent_apis
          (jid, version, tenant_id, manifest_json, manifest_digest, availability, registered_at)
         VALUES (?, ?, ?, ?, ?, 'dormant', ?)
         ON CONFLICT(jid, version) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           manifest_json = excluded.manifest_json,
           manifest_digest = excluded.manifest_digest,
           registered_at = excluded.registered_at`,
      )
      .run(
        manifest.agent.jid,
        manifest.agent.version,
        tenantId,
        JSON.stringify(manifest),
        manifestDigest,
        registeredAt,
      );
    return this.toRegisteredAgent({
      jid: manifest.agent.jid,
      version: manifest.agent.version,
      tenant_id: tenantId,
      manifest_json: JSON.stringify(manifest),
      manifest_digest: manifestDigest,
      availability: 'dormant',
      registered_at: registeredAt,
    });
  }

  getAgent(jid: string, version?: string): RegisteredAgent | null {
    const row = version
      ? (getDb().prepare('SELECT * FROM xmpp_agent_apis WHERE jid = ? AND version = ?').get(jid, version) as
          | ApiRow
          | undefined)
      : (getDb().prepare('SELECT * FROM xmpp_agent_apis WHERE jid = ? ORDER BY registered_at DESC LIMIT 1').get(jid) as
          | ApiRow
          | undefined);
    return row ? this.toRegisteredAgent(row) : null;
  }

  listAgents(tenantId: string): RegisteredAgent[] {
    const rows = getDb()
      .prepare(
        `SELECT a.* FROM xmpp_agent_apis a
         WHERE a.tenant_id = ? AND a.registered_at = (
           SELECT MAX(b.registered_at) FROM xmpp_agent_apis b WHERE b.jid = a.jid
         ) ORDER BY a.jid`,
      )
      .all(tenantId) as ApiRow[];
    return rows.map((row) => this.toRegisteredAgent(row));
  }

  discover(tenantId: string, query: string, limit = 10): VirtualMcpEndpoint[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.listAgents(tenantId)
      .map((agent) => ({ agent, score: searchScore(agent, words) }))
      .filter(({ score }) => words.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score || a.agent.manifest.agent.jid.localeCompare(b.agent.manifest.agent.jid))
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(({ agent }) => endpointDescriptor(agent));
  }

  createTask(task: AgentTaskRecord): AgentTaskRecord {
    if (task.idempotencyKey) {
      const existing = getDb()
        .prepare(
          `SELECT * FROM xmpp_agent_tasks
           WHERE caller_jid = ? AND endpoint_id = ? AND operation = ? AND api_version = ? AND idempotency_key = ?`,
        )
        .get(task.callerJid, task.endpointId, task.operation, task.apiVersion, task.idempotencyKey) as
        | TaskRow
        | undefined;
      if (existing) return fromTaskRow(existing);
    }
    getDb()
      .prepare(
        `INSERT INTO xmpp_agent_tasks (
          task_id, root_task_id, parent_task_id, caller_jid, caller_session_id, target_jid, tenant_id,
          workspace_id, endpoint_id, operation, api_version, input_schema_digest, output_schema_digest,
          arguments_json, state, attempt, idempotency_key, correlation_id, deadline, created_at, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.rootTaskId,
        task.parentTaskId ?? null,
        task.callerJid,
        task.callerSessionId ?? null,
        task.targetJid,
        task.tenantId,
        task.workspaceId ?? null,
        task.endpointId,
        task.operation,
        task.apiVersion,
        task.inputSchemaDigest,
        task.outputSchemaDigest ?? null,
        JSON.stringify(task.arguments),
        task.state,
        task.attempt,
        task.idempotencyKey ?? null,
        task.correlationId,
        task.deadline ?? null,
        task.createdAt,
        task.acceptedAt ?? null,
      );
    return task;
  }

  getTask(taskId: string): AgentTaskRecord | null {
    const row = getDb().prepare('SELECT * FROM xmpp_agent_tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined;
    return row ? fromTaskRow(row) : null;
  }

  transition(taskId: string, state: AgentTaskState, patch: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
    const current = this.getTask(taskId);
    if (!current) throw new Error(`unknown task: ${taskId}`);
    if (terminalTaskStates.has(current.state)) {
      if (current.state === state) return current;
      throw new Error(`task ${taskId} is terminal (${current.state})`);
    }
    const completedAt = terminalTaskStates.has(state) ? new Date().toISOString() : patch.completedAt;
    getDb()
      .prepare(
        `UPDATE xmpp_agent_tasks SET state = ?, result_json = ?, error_json = ?, summary = ?,
          started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at)
         WHERE task_id = ?`,
      )
      .run(
        state,
        patch.result === undefined ? null : JSON.stringify(patch.result),
        patch.error === undefined ? null : JSON.stringify(patch.error),
        patch.summary ?? null,
        patch.startedAt ?? null,
        completedAt ?? null,
        taskId,
      );
    return this.getTask(taskId)!;
  }

  appendEvent(event: AgentTaskEvent): void {
    const next = (
      getDb()
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM xmpp_agent_task_events WHERE task_id = ?')
        .get(event.taskId) as { n: number }
    ).n;
    getDb()
      .prepare(
        'INSERT INTO xmpp_agent_task_events (event_id, task_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(`event-${randomUUID()}`, event.taskId, next, event.type, JSON.stringify(event), new Date().toISOString());
  }

  getInputRequest(taskId: string, requestId: string): Extract<AgentTaskEvent, { type: 'input_required' }> | null {
    const rows = getDb()
      .prepare(
        "SELECT payload_json FROM xmpp_agent_task_events WHERE task_id = ? AND type = 'input_required' ORDER BY sequence DESC",
      )
      .all(taskId) as Array<{ payload_json: string }>;
    for (const row of rows) {
      const event = JSON.parse(row.payload_json) as Extract<AgentTaskEvent, { type: 'input_required' }>;
      if (event.requestId === requestId) return event;
    }
    return null;
  }

  private toRegisteredAgent(row: ApiRow): RegisteredAgent {
    const manifest = JSON.parse(row.manifest_json) as AgentApiManifest;
    const operations: RegisteredOperation[] = manifest.operations.map((operation) => ({
      ...operation,
      inputSchemaDigest: digestJson(operation.inputSchema),
      outputSchemaDigest: operation.outputSchema ? digestJson(operation.outputSchema) : undefined,
    }));
    return {
      manifest,
      manifestDigest: row.manifest_digest,
      operations,
      tenantId: row.tenant_id,
      availability: row.availability,
      registeredAt: row.registered_at,
    };
  }
}

function searchScore(agent: RegisteredAgent, words: string[]): number {
  const haystack = [
    agent.manifest.agent.jid,
    agent.manifest.agent.name,
    agent.manifest.agent.title,
    agent.manifest.agent.description,
    ...agent.operations.flatMap((op) => [op.name, op.title, op.description, ...(op.tags ?? [])]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}

export function endpointDescriptor(agent: RegisteredAgent): VirtualMcpEndpoint {
  const jid = agent.manifest.agent.jid;
  return {
    endpointId: `xmpp+mcp://${jid}`,
    transport: { kind: 'xmpp-gateway', gateway: jid.split('@')[1] ?? '' },
    server: {
      name: agent.manifest.agent.name,
      title: agent.manifest.agent.title,
      description: agent.manifest.agent.description,
      version: agent.manifest.agent.version,
    },
    capabilities: agent.manifest.capabilities,
    xmpp: {
      jid,
      endpointNode: 'urn:businessos:mcp-endpoint:1',
      toolsNode: 'urn:businessos:agent-api:1',
      features: ['urn:businessos:agent-task:1'],
    },
    authorization: {
      visible: true,
      invocable: true,
      approvalRequired: agent.operations.some((op) => op.authorization?.approvalRequired === true),
    },
    availability: { state: agent.availability, coldStartSupported: true },
    tools: agent.operations,
  };
}

function fromTaskRow(row: TaskRow): AgentTaskRecord {
  return {
    taskId: row.task_id,
    rootTaskId: row.root_task_id,
    parentTaskId: row.parent_task_id ?? undefined,
    callerJid: row.caller_jid,
    callerSessionId: row.caller_session_id ?? undefined,
    targetJid: row.target_jid,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? undefined,
    endpointId: row.endpoint_id,
    operation: row.operation,
    apiVersion: row.api_version,
    inputSchemaDigest: row.input_schema_digest,
    outputSchemaDigest: row.output_schema_digest ?? undefined,
    arguments: JSON.parse(row.arguments_json),
    state: row.state,
    attempt: row.attempt,
    idempotencyKey: row.idempotency_key ?? undefined,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    deadline: row.deadline ?? undefined,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    error: row.error_json ? JSON.parse(row.error_json) : undefined,
    summary: row.summary ?? undefined,
  };
}
