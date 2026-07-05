import { OpenfireClient, loadOpenfireConfigFromEnv, resolveAgentJid, usernameFromJid } from './openfire-client.js';
import { generatePassword } from './password.js';
import { buildIdentityVcard } from './vcard.js';

export interface ProvisionAgentIdentityRequest {
  tenantId: string;
  agentId: string;
  displayName: string;
  groups?: string[];
  avatarUrl?: string;
}

export interface ProvisionAgentIdentityResult {
  jid: string;
  password: string;
}

export interface ProvisionAgentIdentityOptions {
  client?: OpenfireClient;
  baseDomain?: string;
}

export async function provisionAgentIdentity(
  request: ProvisionAgentIdentityRequest,
  options: ProvisionAgentIdentityOptions = {},
): Promise<ProvisionAgentIdentityResult> {
  const jid = resolveAgentJid(request.tenantId, request.agentId, options.baseDomain);
  const password = generatePassword();

  if (process.env.ORCHESTRATOR_SKIP_OPENFIRE === '1') {
    // Dev/E2E shortcut: return JID+password without touching OpenFire (orchestrator still wires NanoClaw).
    return { jid, password };
  }

  const client = options.client ?? new OpenfireClient(loadOpenfireConfigFromEnv());
  const username = usernameFromJid(jid);
  const domain = jid.split('@')[1] ?? 'localhost';

  if (await client.getUser(username)) {
    throw new Error(`XMPP user already exists: ${username}`);
  }

  try {
    await client.createUser(username, password, request.displayName, `${username}@${domain}`);
    await client.setVcard(username, buildIdentityVcard(request.displayName, request.avatarUrl));

    for (const group of request.groups ?? []) {
      try {
        await client.ensureSharedGroup(group);
        await client.addUserToGroup(username, group);
      } catch (err) {
        // Shared-group REST is flaky on some OpenFire builds; discovery uses gateway descriptors, not groups.
        console.warn(`[provision-identity] skipping group ${group}: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    // Compensating delete — partial OpenFire state must not leak after a failed provision.
    await client.deleteUser(username).catch((err) => {
      console.warn(
        `[provision-identity] compensating delete failed for ${username}:`,
        err instanceof Error ? err.message : err,
      );
    });
    throw err;
  }

  return { jid, password };
}
