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
  tenantId: string;
  workspaceId?: string;
  arguments: unknown;
  deadline?: string;
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
