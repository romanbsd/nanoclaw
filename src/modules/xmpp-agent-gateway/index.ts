import { GATEWAY_ACTIONS, type GatewayMailboxRequest } from '@agent-xmpp/protocol';

import { registerContainerContributor } from '../../container-contribution.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { getXmppContainerContribution } from './container-contribution.js';
import { XmppAgentGatewayService } from './service.js';

const service = new XmppAgentGatewayService();

registerContainerContributor('xmpp-agent-gateway', ({ agentGroupId }) => getXmppContainerContribution(agentGroupId));

for (const action of GATEWAY_ACTIONS) {
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
