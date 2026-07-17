import { randomUUID } from 'crypto';

import type Database from 'better-sqlite3';
import {
  type AgentApiManifest,
  type AgentTaskError,
  type AgentTaskRecord,
  type GatewayMailboxRequest,
  type GatewayMailboxResponse,
  type StartAgentToolInput,
  terminalTaskStates,
} from '@agent-xmpp/protocol';
import type { ParsedTaskInvocation, TaskWireEvent } from '@agent-xmpp/gateway';

import { deliverAgentInbound } from '../../agent-inbound/index.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getAgentGroupByXmppJid, getXmppAgentIdentity } from './identity.js';
import { getOrchestratorAgentByGroupId } from './orchestrator-store.js';
import { resolveTaskSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { validateJson } from './schema.js';
import { endpointDescriptor, XmppAgentGatewayStore } from './store.js';

const MAX_DELEGATION_DEPTH = 8;

export class XmppAgentGatewayService {
  constructor(private readonly store = new XmppAgentGatewayStore()) {}

  async handle(request: GatewayMailboxRequest, session: Session, inDb: Database.Database): Promise<void> {
    try {
      const result = await this.execute(request, session);
      if (result !== DEFERRED)
        this.respond(session, request.requestId, { requestId: request.requestId, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.respond(session, request.requestId, {
        requestId: request.requestId,
        ok: false,
        error: { code: classifyError(message), message },
      });
    }
    void inDb;
  }

  async acceptRemoteInvocation(input: ParsedTaskInvocation): Promise<void> {
    const target = getAgentGroupByXmppJid(input.toJid);
    if (!target) throw new Error('target agent is not provisioned');
    const tenantId = getOrchestratorAgentByGroupId(target.id)?.tenant_id ?? 'default';
    if (input.tenantId !== tenantId) throw new Error('cross-tenant task invocation rejected');
    const agent = this.store.getAgent(input.toJid, input.apiVersion);
    const operation = agent?.operations.find((item) => item.name === input.operation);
    if (!agent || !operation) throw new Error('operation not found');
    if (operation.inputSchemaDigest !== input.inputSchemaDigest) throw new Error('input schema digest mismatch');
    const errors = validateJson(operation.inputSchema, input.arguments);
    if (errors.length) throw new Error(`argument schema validation failed: ${errors.join('; ')}`);
    const now = new Date().toISOString();
    const task = this.store.createTask({
      taskId: input.taskId,
      rootTaskId: input.taskId,
      callerJid: input.callerJid,
      targetJid: input.toJid,
      tenantId,
      workspaceId: input.workspaceId,
      endpointId: `xmpp+mcp://${input.toJid}`,
      operation: input.operation,
      apiVersion: input.apiVersion,
      inputSchemaDigest: input.inputSchemaDigest,
      outputSchemaDigest: input.outputSchemaDigest,
      arguments: input.arguments,
      state: 'accepted',
      attempt: 1,
      correlationId: input.correlationId,
      createdAt: now,
      acceptedAt: now,
      deadline: input.deadline,
    });
    await this.deliverTaskMessage(task, 'task_invoke', { arguments: task.arguments });
    this.store.transition(task.taskId, 'running', { startedAt: new Date().toISOString() });
  }

  async acceptRemoteEvent(event: TaskWireEvent): Promise<void> {
    const task = this.store.getTask(event.taskId);
    if (!task) throw new Error('task not found');
    const sender = event.from.split('/')[0];
    if (event.type === 'cancel_requested' || event.type === 'input') {
      if (task.callerJid !== sender) throw new Error('task event sender mismatch');
      await this.deliverTaskMessage(task, event.type === 'input' ? 'task_input' : 'task_cancel', event.payload);
      if (event.type === 'input') this.store.transition(task.taskId, 'running');
      else this.store.transition(task.taskId, 'cancelling');
      return;
    }
    if (task.targetJid !== sender) throw new Error('task event sender mismatch');
    if (event.type === 'progress') {
      this.store.appendEvent({ type: 'progress', taskId: task.taskId, ...event.payload });
      return;
    }
    if (event.type === 'input_required') {
      const requestId = String(event.payload.requestId ?? `input-${randomUUID()}`);
      const inputSchema = (event.payload.inputSchema ?? {}) as Record<string, unknown>;
      this.store.appendEvent({
        type: 'input_required',
        taskId: task.taskId,
        requestId,
        question: String(event.payload.question ?? ''),
        inputSchema,
      });
      this.store.transition(task.taskId, 'input_required');
      this.respondToWaiters(task, {
        requestId: task.correlationId,
        ok: true,
        result: {
          taskId: task.taskId,
          status: 'input_required',
          requestId,
          question: event.payload.question,
          inputSchema,
        },
      });
      return;
    }
    if (event.type === 'completed') {
      const completed = this.store.transition(task.taskId, 'completed', {
        result: event.payload.result,
        summary: optionalString(event.payload.summary),
      });
      this.respondToWaiters(completed, { requestId: completed.correlationId, ok: true, result: taskResult(completed) });
      return;
    }
    if (event.type === 'failed') {
      const error = (event.payload.error ?? event.payload) as AgentTaskError;
      const failed = this.store.transition(task.taskId, 'failed', { error });
      this.respondToWaiters(failed, {
        requestId: failed.correlationId,
        ok: false,
        error: { code: error.code ?? 'execution-failed', message: error.message ?? 'Task failed' },
      });
      return;
    }
    const cancelled = this.store.transition(task.taskId, 'cancelled');
    this.respondToWaiters(cancelled, {
      requestId: cancelled.correlationId,
      ok: true,
      result: { taskId: cancelled.taskId, status: cancelled.state },
    });
  }

  private async execute(request: GatewayMailboxRequest, session: Session): Promise<unknown | typeof DEFERRED> {
    const principal = this.principal(session);
    switch (request.action) {
      case 'agent_api.register': {
        const manifest = request.payload.manifest as AgentApiManifest;
        if (manifest?.agent?.jid !== principal.jid) throw new Error('manifest JID must match the calling agent');
        return this.store.registerManifest(manifest, principal.tenantId);
      }
      case 'agents.discover_endpoints':
        return {
          endpoints: this.store.discover(
            principal.tenantId,
            String(request.payload.query ?? ''),
            Number(request.payload.limit ?? 10),
          ),
        };
      case 'agents.describe_endpoint': {
        const jid = endpointJid(String(request.payload.endpointId ?? ''));
        const agent = this.store.getAgent(jid, optionalString(request.payload.apiVersion));
        if (!agent || agent.tenantId !== principal.tenantId) throw new Error('endpoint not found');
        return endpointDescriptor(agent);
      }
      case 'agents.list_tools': {
        const jid = endpointJid(String(request.payload.endpointId ?? ''));
        const agent = this.store.getAgent(jid, optionalString(request.payload.apiVersion));
        if (!agent || agent.tenantId !== principal.tenantId) throw new Error('endpoint not found');
        return { tools: agent.operations };
      }
      case 'agents.start_tool':
        return this.startTask(request.payload as unknown as StartAgentToolInput, request.requestId, session, false);
      case 'agents.call_tool':
        return this.startTask(request.payload as unknown as StartAgentToolInput, request.requestId, session, true);
      case 'agents.get_task':
      case 'agents.get_result': {
        const task = this.authorizedTask(String(request.payload.taskId ?? ''), principal.tenantId);
        return request.action === 'agents.get_result'
          ? { taskId: task.taskId, status: task.state, result: task.result, error: task.error, summary: task.summary }
          : task;
      }
      case 'agents.cancel_task': {
        const task = this.authorizedTask(String(request.payload.taskId ?? ''), principal.tenantId);
        if (task.callerJid !== principal.jid) throw new Error('only the task caller may cancel it');
        this.store.appendEvent({
          type: 'cancel_requested',
          taskId: task.taskId,
          reason: optionalString(request.payload.reason),
        });
        const cancelling = this.store.transition(task.taskId, 'cancelling');
        await this.deliverTaskMessage(cancelling, 'task_cancel', { reason: request.payload.reason });
        return cancelling;
      }
      case 'agents.answer_input': {
        const task = this.authorizedTask(String(request.payload.taskId ?? ''), principal.tenantId);
        if (task.callerJid !== principal.jid) throw new Error('only the task caller may answer input');
        const requestId = String(request.payload.requestId ?? '');
        const pending = this.store.getInputRequest(task.taskId, requestId);
        if (!pending) throw new Error('input request not found');
        const errors = validateJson(pending.inputSchema, request.payload.input);
        if (errors.length) throw new Error(`input schema validation failed: ${errors.join('; ')}`);
        this.store.appendEvent({ type: 'input', taskId: task.taskId, requestId, input: request.payload.input });
        await this.deliverTaskMessage(task, 'task_input', { requestId, input: request.payload.input });
        return this.store.transition(task.taskId, 'running');
      }
      case 'task.report_progress': {
        const task = this.targetTask(request.payload, principal.jid);
        this.store.appendEvent({
          type: 'progress',
          taskId: task.taskId,
          percent: optionalNumber(request.payload.percent),
          stage: optionalString(request.payload.stage),
          message: optionalString(request.payload.message),
        });
        await this.emitRemoteEvent(task, 'progress', {
          percent: request.payload.percent,
          stage: request.payload.stage,
          message: request.payload.message,
        });
        return { taskId: task.taskId, status: task.state };
      }
      case 'task.request_input': {
        const task = this.targetTask(request.payload, principal.jid);
        const inputRequestId = String(request.payload.requestId ?? `input-${randomUUID()}`);
        const inputSchema = request.payload.inputSchema as Record<string, unknown>;
        this.store.appendEvent({
          type: 'input_required',
          taskId: task.taskId,
          requestId: inputRequestId,
          question: String(request.payload.question ?? ''),
          inputSchema,
        });
        this.store.transition(task.taskId, 'input_required');
        await this.settle(
          task,
          'input_required',
          {
            ok: true,
            result: {
              taskId: task.taskId,
              status: 'input_required',
              requestId: inputRequestId,
              question: request.payload.question,
              inputSchema,
            },
          },
          { requestId: inputRequestId, question: request.payload.question, inputSchema },
        );
        return { taskId: task.taskId, requestId: inputRequestId };
      }
      case 'task.complete': {
        const task = this.targetTask(request.payload, principal.jid);
        const agent = this.store.getAgent(task.targetJid, task.apiVersion)!;
        const operation = agent.operations.find((item) => item.name === task.operation)!;
        if (operation.outputSchema) {
          const errors = validateJson(operation.outputSchema, request.payload.result);
          if (errors.length) throw new Error(`result schema validation failed: ${errors.join('; ')}`);
        }
        this.store.appendEvent({
          type: 'completed',
          taskId: task.taskId,
          result: request.payload.result,
          summary: optionalString(request.payload.summary),
        });
        const completed = this.store.transition(task.taskId, 'completed', {
          result: request.payload.result,
          summary: optionalString(request.payload.summary),
        });
        await this.settle(
          completed,
          'completed',
          { ok: true, result: taskResult(completed) },
          { result: completed.result, summary: completed.summary },
        );
        return { taskId: completed.taskId, status: completed.state };
      }
      case 'task.fail': {
        const task = this.targetTask(request.payload, principal.jid);
        const error: AgentTaskError = {
          code: String(request.payload.code ?? 'execution-failed'),
          message: String(request.payload.message ?? 'Task failed'),
          retryable: request.payload.retryable === true,
          attempt: task.attempt,
        };
        this.store.appendEvent({ type: 'failed', taskId: task.taskId, error });
        const failed = this.store.transition(task.taskId, 'failed', { error });
        await this.settle(
          failed,
          'failed',
          { ok: false, error: { code: error.code, message: error.message } },
          {
            error,
          },
        );
        return { taskId: failed.taskId, status: failed.state };
      }
      case 'task.cancelled': {
        const task = this.targetTask(request.payload, principal.jid);
        this.store.appendEvent({ type: 'cancelled', taskId: task.taskId });
        const cancelled = this.store.transition(task.taskId, 'cancelled');
        await this.settle(
          cancelled,
          'cancelled',
          { ok: true, result: { taskId: cancelled.taskId, status: cancelled.state } },
          {},
        );
        return { taskId: cancelled.taskId, status: cancelled.state };
      }
    }
  }

  private async startTask(input: StartAgentToolInput, correlationId: string, session: Session, wait: boolean) {
    const principal = this.principal(session);
    const targetJid = endpointJid(input.endpointId);
    const agent = this.store.getAgent(targetJid, input.apiVersion);
    if (!agent || agent.tenantId !== principal.tenantId) throw new Error('endpoint not found');
    const operation = agent.operations.find((item) => item.name === input.tool);
    if (!operation) throw new Error('operation not found');
    if (operation.authorization?.approvalRequired) throw new Error('operation requires approval');
    if (operation.authorization?.requiredPermissions?.length)
      throw new Error('operation is not authorized for this caller');
    const errors = validateJson(operation.inputSchema, input.arguments);
    if (errors.length) throw new Error(`argument schema validation failed: ${errors.join('; ')}`);
    const parent = input.parentTaskId ? this.authorizedTask(input.parentTaskId, principal.tenantId) : null;
    const depth = parent ? this.taskDepth(parent) + 1 : 0;
    if (depth > MAX_DELEGATION_DEPTH) throw new Error(`maximum delegation depth ${MAX_DELEGATION_DEPTH} exceeded`);
    const now = new Date().toISOString();
    const taskId = `task-${randomUUID()}`;
    const task = this.store.createTask({
      taskId,
      rootTaskId: parent?.rootTaskId ?? taskId,
      parentTaskId: parent?.taskId,
      callerJid: principal.jid,
      callerSessionId: session.id,
      targetJid,
      tenantId: principal.tenantId,
      endpointId: input.endpointId,
      operation: operation.name,
      apiVersion: agent.manifest.agent.version,
      inputSchemaDigest: operation.inputSchemaDigest,
      outputSchemaDigest: operation.outputSchemaDigest,
      arguments: input.arguments,
      state: 'accepted',
      attempt: 1,
      idempotencyKey: input.idempotencyKey,
      correlationId,
      createdAt: now,
      acceptedAt: now,
      deadline: input.timeoutSeconds ? new Date(Date.now() + input.timeoutSeconds * 1000).toISOString() : undefined,
    });
    if (task.taskId !== taskId) {
      if (!wait) return task;
      if (task.state === 'completed') return taskResult(task);
      if (terminalTaskStates.has(task.state)) throw new Error(task.error?.message ?? `task ${task.state}`);
      this.store.addTaskWaiter(task.taskId, correlationId, session.agent_group_id, session.id);
      return DEFERRED;
    }
    if (wait) this.store.addTaskWaiter(task.taskId, correlationId, session.agent_group_id, session.id);
    await this.deliverTaskMessage(task, 'task_invoke', {
      operation: {
        name: operation.name,
        title: operation.title,
        description: operation.description,
        inputSchema: operation.inputSchema,
        outputSchema: operation.outputSchema,
      },
      arguments: task.arguments,
      caller: { jid: task.callerJid, kind: 'agent' },
    });
    this.store.transition(task.taskId, 'running', { startedAt: new Date().toISOString() });
    return wait
      ? DEFERRED
      : { taskId: task.taskId, status: 'accepted', endpointId: task.endpointId, tool: task.operation };
  }

  private async deliverTaskMessage(
    task: AgentTaskRecord,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const target = getAgentGroupByXmppJid(task.targetJid);
    if (!target) {
      const wireType = event === 'task_cancel' ? 'cancel_requested' : event === 'task_input' ? 'input' : null;
      await this.deliverWire(
        task.targetJid,
        task.callerJid,
        task.taskId,
        wireType ? 'agent-task-event' : 'agent-task',
        wireType
          ? {
              agentTaskEvent: {
                taskId: task.taskId,
                type: wireType,
                from: task.callerJid,
                to: task.targetJid,
                payload,
              },
            }
          : { agentTask: task },
      );
      return;
    }
    // Agent tasks are action-owned work, not channel conversations. Reuse the
    // generic task-session boundary so human chat and remote work can never be
    // co-batched or share provider continuation state.
    const { session } = resolveTaskSession(target.id, task.taskId);
    await deliverAgentInbound({
      session,
      wake: true,
      message: {
        id: `${event}-${randomUUID()}`,
        kind: 'agent-task',
        timestamp: new Date().toISOString(),
        platformId: task.callerJid,
        channelType: 'xmpp',
        threadId: task.taskId,
        content: JSON.stringify({
          prompt:
            event === 'task_invoke'
              ? `Execute registered operation ${task.operation} with the arguments in Task data. ` +
                `Return only to the calling agent: do not send a channel message or use a <message> block. ` +
                `Finish with task.complete, task.fail, task.report_progress, or task.request_input using taskId ${task.taskId}.`
              : `Task ${task.taskId} received ${event}.`,
          task: task,
          event,
          payload,
        }),
        trigger: 1,
      },
    });
  }

  private principal(session: Session): { jid: string; tenantId: string } {
    const identity = getXmppAgentIdentity(session.agent_group_id);
    if (!identity) throw new Error('calling agent has no XMPP identity');
    return {
      jid: identity.jid,
      tenantId: getOrchestratorAgentByGroupId(identity.agent_group_id)?.tenant_id ?? 'default',
    };
  }

  private targetTask(payload: Record<string, unknown>, targetJid: string): AgentTaskRecord {
    const task = this.store.getTask(String(payload.taskId ?? ''));
    if (!task || task.targetJid !== targetJid) throw new Error('task not found');
    return task;
  }

  private authorizedTask(taskId: string, tenantId: string): AgentTaskRecord {
    let task = this.store.getTask(taskId);
    if (!task || task.tenantId !== tenantId) throw new Error('task not found');
    if (task.deadline && Date.parse(task.deadline) <= Date.now() && !terminalTaskStates.has(task.state)) {
      task = this.store.transition(task.taskId, 'timed_out', {
        error: { code: 'deadline-exceeded', message: 'Task deadline exceeded', retryable: false },
      });
    }
    return task;
  }

  private taskDepth(task: AgentTaskRecord): number {
    let depth = 0;
    let current = task;
    while (current.parentTaskId) {
      depth++;
      if (depth > MAX_DELEGATION_DEPTH) break;
      const parent = this.store.getTask(current.parentTaskId);
      if (!parent) break;
      current = parent;
    }
    return depth;
  }

  private respond(session: Session, requestId: string, response: GatewayMailboxResponse): void {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `gateway-response-${randomUUID()}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ action: 'xmpp_agent_gateway_response', requestId, response }),
      trigger: 0,
    });
  }

  private respondToWaiters(task: AgentTaskRecord, response: GatewayMailboxResponse): boolean {
    const waiters = this.store.takeTaskWaiters(task.taskId);
    for (const waiter of waiters) {
      this.respond({ id: waiter.sessionId, agent_group_id: waiter.agentGroupId } as Session, waiter.requestId, {
        ...response,
        requestId: waiter.requestId,
      });
    }
    return waiters.length > 0;
  }

  /**
   * Settle a task lifecycle transition: hand the result to any local in-process
   * waiters, and only if there are none, forward it as a remote wire event to the
   * caller's XMPP JID. Shared by task.complete / fail / cancelled / request_input.
   */
  private async settle(
    task: AgentTaskRecord,
    wireType: TaskWireEvent['type'],
    localResult:
      | { ok: true; result: Record<string, unknown> }
      | { ok: false; error: { code: string; message: string } },
    remotePayload: Record<string, unknown>,
  ): Promise<void> {
    const notified = this.respondToWaiters(task, { requestId: task.correlationId, ...localResult });
    if (!notified) await this.emitRemoteEvent(task, wireType, remotePayload);
  }

  private async emitRemoteEvent(
    task: AgentTaskRecord,
    type: TaskWireEvent['type'],
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (getAgentGroupByXmppJid(task.callerJid)) return;
    await this.deliverWire(task.callerJid, task.targetJid, task.taskId, 'agent-task-event', {
      agentTaskEvent: { taskId: task.taskId, type, from: task.targetJid, to: task.callerJid, payload },
    });
  }

  /** Push a task invocation or lifecycle event onto the XMPP delivery adapter. */
  private async deliverWire(
    to: string,
    from: string,
    taskId: string,
    kind: 'agent-task' | 'agent-task-event',
    body: unknown,
  ): Promise<void> {
    const adapter = getDeliveryAdapter();
    if (!adapter) throw new Error('XMPP delivery adapter is unavailable');
    await adapter.deliver({
      channelType: 'xmpp',
      platformId: to,
      threadId: taskId,
      kind,
      content: JSON.stringify(body),
      instance: 'xmpp',
      senderIdentity: from,
    });
  }
}

const DEFERRED = Symbol('deferred');

function endpointJid(endpointId: string): string {
  const prefix = 'xmpp+mcp://';
  if (!endpointId.startsWith(prefix)) throw new Error('malformed endpoint ID');
  const jid = endpointId.slice(prefix.length);
  if (!jid.includes('@') || jid.includes('/')) throw new Error('malformed endpoint ID');
  return jid;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function classifyError(message: string): string {
  if (message.includes('schema validation')) return 'invalid-arguments';
  if (message.includes('not found')) return 'not-found';
  if (message.includes('maximum delegation')) return 'delegation-limit';
  return 'gateway-error';
}

function taskResult(task: AgentTaskRecord): Record<string, unknown> {
  return {
    taskId: task.taskId,
    status: task.state,
    structuredContent: task.result,
    summary: task.summary,
  };
}
