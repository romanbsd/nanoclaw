/**
 * Gateway-private agent-task extension transported in normal message stanzas.
 * XEP-0359 supplies correlation IDs and XEP-0184 requests wire delivery receipts;
 * the urn:businessos:agent-task:1 payload itself is not an XEP.
 *
 * @see https://xmpp.org/extensions/xep-0359.html
 * @see https://xmpp.org/extensions/xep-0184.html
 */
import { AGENT_TASK_NS, type AgentTaskRecord } from '@agent-xmpp/protocol';
import { xml, type Element } from '@xmpp/xml';

export interface ParsedTaskInvocation {
  taskId: string;
  correlationId: string;
  operation: string;
  apiVersion: string;
  inputSchemaDigest: string;
  outputSchemaDigest?: string;
  callerJid: string;
  toJid: string;
  tenantId: string;
  workspaceId?: string;
  arguments: unknown;
  deadline?: string;
}

export interface TaskWireEvent {
  taskId: string;
  type: 'progress' | 'input_required' | 'input' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled';
  from: string;
  to: string;
  payload: Record<string, unknown>;
}

export function parseTaskEvent(stanza: Element): TaskWireEvent | null {
  if (stanza.name !== 'message') return null;
  const event = stanza.getChild('event', AGENT_TASK_NS);
  if (!event?.attrs['task-id'] || !event.attrs.type) return null;
  const type = String(event.attrs.type) as TaskWireEvent['type'];
  if (!['progress', 'input_required', 'input', 'cancel_requested', 'completed', 'failed', 'cancelled'].includes(type)) return null;
  try {
    return {
      taskId: String(event.attrs['task-id']),
      type,
      from: String(stanza.attrs.from ?? ''),
      to: String(stanza.attrs.to ?? ''),
      payload: JSON.parse(event.getText() || '{}') as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export function buildTaskEvent(event: TaskWireEvent): Element {
  return xml(
    'message',
    { from: event.from, to: event.to, type: 'normal', id: `${event.type}-${event.taskId}` },
    xml('event', { xmlns: AGENT_TASK_NS, 'task-id': event.taskId, type: event.type }, JSON.stringify(event.payload)),
  );
}

export function parseTaskInvocation(stanza: Element): ParsedTaskInvocation | null {
  if (stanza.name !== 'message') return null;
  const invoke = stanza.getChild('invoke', AGENT_TASK_NS);
  if (!invoke) return null;
  const caller = invoke.getChild('caller');
  const context = invoke.getChild('context');
  const argumentsElement = invoke.getChild('arguments');
  if (!invoke.attrs['task-id'] || !invoke.attrs.operation || !invoke.attrs['api-version'] || !argumentsElement) return null;
  let args: unknown;
  try {
    args = JSON.parse(argumentsElement.getText());
  } catch {
    return null;
  }
  return {
    taskId: String(invoke.attrs['task-id']),
    correlationId: String(invoke.attrs['correlation-id'] ?? ''),
    operation: String(invoke.attrs.operation),
    apiVersion: String(invoke.attrs['api-version']),
    inputSchemaDigest: String(invoke.attrs['input-schema-digest'] ?? ''),
    outputSchemaDigest: invoke.attrs['output-schema-digest'] ? String(invoke.attrs['output-schema-digest']) : undefined,
    callerJid: String(caller?.attrs.jid ?? stanza.attrs.from ?? ''),
    toJid: String(stanza.attrs.to ?? '').split('/')[0],
    tenantId: String(context?.attrs['tenant-id'] ?? 'default'),
    workspaceId: context?.attrs['workspace-id'] ? String(context.attrs['workspace-id']) : undefined,
    arguments: args,
    deadline: invoke.getChildText('deadline') ?? undefined,
  };
}

export function buildTaskInvocation(task: AgentTaskRecord): Element {
  const invokeChildren: Element[] = [
    xml('caller', { jid: task.callerJid, kind: 'agent' }),
    xml('context', {
      'tenant-id': task.tenantId,
      ...(task.workspaceId ? { 'workspace-id': task.workspaceId } : {}),
    }),
    xml('arguments', { 'media-type': 'application/json' }, JSON.stringify(task.arguments)),
  ];
  if (task.deadline) invokeChildren.push(xml('deadline', {}, task.deadline));
  return xml(
    'message',
    { from: task.callerJid, to: task.targetJid, type: 'normal', id: `invoke-${task.taskId}` },
    xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: task.correlationId }),
    xml(
      'invoke',
      {
        xmlns: AGENT_TASK_NS,
        'task-id': task.taskId,
        'correlation-id': task.correlationId,
        operation: task.operation,
        'api-version': task.apiVersion,
        'input-schema-digest': task.inputSchemaDigest,
        ...(task.outputSchemaDigest ? { 'output-schema-digest': task.outputSchemaDigest } : {}),
        'response-mode': 'deferred',
      },
      ...invokeChildren,
    ),
    xml('request', { xmlns: 'urn:xmpp:receipts' }),
  );
}
