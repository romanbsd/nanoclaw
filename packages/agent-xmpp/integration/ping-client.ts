/**
 * XMPP ping client: sends "ping" to the gateway component, waits for "pong" reply.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { client } from '@xmpp/client';
import { xml } from '@xmpp/xml';

const TIMEOUT_MS = Number(process.env.XMPP_PING_TIMEOUT_MS || '30000');

function config() {
  const domain = process.env.XMPP_DOMAIN || 'example.org';
  return {
    service:
      process.env.XMPP_SERVICE ||
      `xmpp://127.0.0.1:${process.env.E2E_XMPP_PORT || '15222'}`,
    domain,
    pingerJid: process.env.XMPP_PINGER_JID || `john@${domain}`,
    pingerPass: process.env.XMPP_PINGER_PASS || 'secret',
    gatewayJid:
      process.env.XMPP_GATEWAY_JID || `gateway.${domain}`,
  };
}

export async function runPingTest(): Promise<void> {
  const { service, domain, pingerJid, pingerPass, gatewayJid } = config();
  const [username] = [pingerJid.split('@')[0]];
  const xmpp = client({
    service,
    domain,
    username,
    password: pingerPass,
    tls: {
      rejectUnauthorized: process.env.XMPP_TLS_REJECT_UNAUTHORIZED === '1',
    },
  });

  const pongPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for pong')), TIMEOUT_MS);
    xmpp.on('stanza', (stanza) => {
      if (stanza.is('message')) {
        const body = stanza.getChildText('body');
        if (body?.trim() === 'pong') {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });

  xmpp.on('error', (err) => console.error('[ping-client] xmpp error:', err.message));

  await xmpp.start();
  await xmpp.send(xml('presence'));
  console.log('[ping-client] connected as', pingerJid);

  const id = `ping-${Date.now()}`;
  await xmpp.send(
    xml('message', { type: 'chat', to: gatewayJid, id }, xml('body', {}, 'ping')),
  );
  console.log('[ping-client] sent ping to', gatewayJid);

  await pongPromise;
  console.log('[ping-client] received pong');
  await xmpp.stop();
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runPingTest().catch((err) => {
    console.error('[ping-client] failed:', err);
    process.exit(1);
  });
}
