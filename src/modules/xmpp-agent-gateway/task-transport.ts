import { randomUUID } from 'crypto';

import type { AgentTaskRecord } from '@agent-xmpp/protocol';
import type { TaskWireEvent } from '@agent-xmpp/gateway';

import { deliverAgentInbound } from '../../agent-inbound/index.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { resolveTaskSession } from '../../session-manager.js';
import { getAgentGroupByXmppJid } from './identity.js';

export type TaskMailboxEvent = 'task_invoke' | 'task_cancel' | 'task_input';

export interface AgentTaskTransport {
  deliver(task: AgentTaskRecord, event: TaskMailboxEvent, payload: Record<string, unknown>): Promise<void>;
  emit(task: AgentTaskRecord, type: TaskWireEvent['type'], payload: Record<string, unknown>): Promise<void>;
}

/** NanoClaw mailbox transport with XMPP wire fallback for remote agents. */
export class XmppAgentTaskTransport implements AgentTaskTransport {
  async deliver(task: AgentTaskRecord, event: TaskMailboxEvent, payload: Record<string, unknown>): Promise<void> {
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
    // task-session boundary so human chat and remote work never share provider state.
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
          task,
          event,
          payload,
        }),
        trigger: 1,
      },
    });
  }

  async emit(task: AgentTaskRecord, type: TaskWireEvent['type'], payload: Record<string, unknown>): Promise<void> {
    if (getAgentGroupByXmppJid(task.callerJid)) return;
    await this.deliverWire(task.callerJid, task.targetJid, task.taskId, 'agent-task-event', {
      agentTaskEvent: { taskId: task.taskId, type, from: task.targetJid, to: task.callerJid, payload },
    });
  }

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
