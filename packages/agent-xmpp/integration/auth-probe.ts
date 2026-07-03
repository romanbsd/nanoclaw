/**
 * Quick SASL connectivity probe (run while KEEP_E2E=1 leaves Openfire up).
 */
import { client } from '@xmpp/client';

const domain = process.env.XMPP_DOMAIN || 'example.org';
const service = process.env.XMPP_SERVICE || `xmpp://127.0.0.1:${process.env.E2E_XMPP_PORT || '15222'}`;
const username = process.env.XMPP_PINGER_USER || 'john';
const password = process.env.XMPP_PINGER_PASS || 'secret';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const xmpp = client({ service, domain, username, password });

xmpp.on('status', (status) => console.log('[auth-probe] status:', status));
xmpp.on('error', (err) => console.error('[auth-probe] error:', err));

try {
  await xmpp.start();
  console.log('[auth-probe] online as', xmpp.jid?.toString());
  await xmpp.stop();
} catch (err) {
  console.error('[auth-probe] failed:', err);
  process.exit(1);
}
