import type { GatewayMailboxRequest } from '@agent-xmpp/protocol';

import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { XmppAgentGatewayService } from './service.js';

const service = new XmppAgentGatewayService();

const actions: GatewayMailboxRequest['action'][] = [
  'agent_api.register',
  'agents.discover_endpoints',
  'agents.describe_endpoint',
  'agents.list_tools',
  'agents.start_tool',
  'agents.call_tool',
  'agents.get_task',
  'agents.get_result',
  'agents.cancel_task',
  'agents.answer_input',
  'task.report_progress',
  'task.request_input',
  'task.complete',
  'task.fail',
  'task.cancelled',
];

for (const action of actions) {
  registerDeliveryAction(
    action,
    async (content, session) => {
      const request: GatewayMailboxRequest = {
        requestId: String(content.requestId ?? ''),
        action,
        payload: (content.payload ?? {}) as Record<string, unknown>,
      };
      await service.handle(request, session);
    },
    unguarded('XMPP gateway service validates caller identity, schemas, authorization, and task state'),
  );
}
