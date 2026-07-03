/**
 * XMPP channel flow for setup:auto (minimal MVP).
 */
import crypto from 'crypto';

import * as p from '@clack/prompts';
import k from 'kleur';

import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { fail, runQuietChild } from '../lib/runner.js';
import { note } from '../lib/theme.js';

export async function runXmppChannel(displayName: string): Promise<ChannelFlowResult> {
  note(
    [
      'XMPP uses an external component gateway (Openfire/ejabberd/Prosody).',
      '',
      'You need:',
      '  1. Component JID + secret registered on your XMPP server',
      '  2. Agent bare JID (e.g. assistant@agents.example)',
      '',
      k.dim('See docs/xmpp-setup.md for server configuration.'),
    ].join('\n'),
    'XMPP setup',
  );

  const componentJid = (await p.text({
    message: 'Component JID',
    placeholder: 'gateway.agents.example',
    validate: (v) => (v?.includes('@') ? undefined : 'Enter a full JID'),
  })) as string;
  if (p.isCancel(componentJid)) return BACK_TO_CHANNEL_SELECTION;

  const secret = (await p.password({ message: 'Component secret' })) as string;
  if (p.isCancel(secret)) return BACK_TO_CHANNEL_SELECTION;

  const agentJid = (await p.text({
    message: 'Default agent JID',
    placeholder: 'assistant@agents.example',
    validate: (v) => (v?.includes('@') ? undefined : 'Enter a full JID'),
  })) as string;
  if (p.isCancel(agentJid)) return BACK_TO_CHANNEL_SELECTION;

  const install = await runQuietChild(
    'xmpp-install',
    'bash',
    ['setup/add-xmpp.sh'],
    { running: 'Building XMPP gateway…', done: 'XMPP gateway installed.' },
    {
      env: {
        XMPP_COMPONENT_JID: componentJid,
        XMPP_COMPONENT_SECRET: secret,
        XMPP_DEFAULT_AGENT_JID: agentJid,
        XMPP_AGENT_DOMAIN: agentJid.split('@')[1] || '',
        XMPP_COMPONENT_SERVICE: 'xmpp://127.0.0.1:5275',
        XMPP_GATEWAY_URL: 'http://127.0.0.1:9220',
        XMPP_BRIDGE_WEBHOOK_SECRET: crypto.randomUUID(),
        XMPP_BRIDGE_WEBHOOK_URL: 'http://127.0.0.1:9221/internal/xmpp/inbound',
        XMPP_BRIDGE_WEBHOOK_PORT: '9221',
      },
      extraFields: { AGENT_JID: agentJid, DISPLAY_NAME: displayName },
    },
  );

  if (!install.ok) {
    await fail('xmpp-install', 'XMPP install failed.', 'See logs/setup-steps/');
  }

  note(
    [
      `Start the gateway: pnpm --filter @agent-xmpp/gateway start`,
      `Send an XMPP message to ${agentJid} and wire via /manage-channels.`,
    ].join('\n'),
    'Next steps',
  );
}
