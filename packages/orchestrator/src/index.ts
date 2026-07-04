export { provisionAgentIdentity } from './provision-identity.js';
export type { ProvisionAgentIdentityRequest, ProvisionAgentIdentityResult } from './provision-identity.js';
export { provisionNanoclawAgent, REPO_ROOT } from './provision-nanoclaw-agent.js';
export type { ProvisionNanoclawAgentRequest, ProvisionNanoclawAgentResult, McpServerSpec } from './provision-nanoclaw-agent.js';
export { deleteNanoclawAgent } from './delete-agent.js';
export { createOrchestratorServer, startOrchestratorServer } from './http-server.js';
export {
  OpenfireClient,
  OpenfireRestError,
  loadOpenfireConfigFromEnv,
  resolveAgentJid,
  usernameFromJid,
} from './openfire-client.js';
export type { OpenfireClientConfig } from './openfire-client.js';
export { generatePassword } from './password.js';
export { buildIdentityVcard } from './vcard.js';
