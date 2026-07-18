export const taskStates = [
  'created',
  'validating',
  'rejected',
  'accepted',
  'queued',
  'starting',
  'running',
  'input_required',
  'cancelling',
  'cancelled',
  'failed',
  'timed_out',
  'completed',
] as const;
export type AgentTaskState = (typeof taskStates)[number];

export const terminalTaskStates = new Set<AgentTaskState>([
  'rejected',
  'cancelled',
  'failed',
  'timed_out',
  'completed',
]);

export interface AgentTaskError {
  code: string;
  message: string;
  retryable: boolean;
  attempt?: number;
}

export interface AgentTaskRecord {
  taskId: string;
  rootTaskId: string;
  parentTaskId?: string;
  callerJid: string;
  targetJid: string;
  tenantId: string;
  workspaceId?: string;
  endpointId: string;
  operation: string;
  apiVersion: string;
  inputSchemaDigest: string;
  outputSchemaDigest?: string;
  arguments: unknown;
  state: AgentTaskState;
  attempt: number;
  idempotencyKey?: string;
  correlationId: string;
  callerSessionId?: string;
  createdAt: string;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  deadline?: string;
  result?: unknown;
  error?: AgentTaskError;
  summary?: string;
}

export interface StartAgentToolInput {
  endpointId: string;
  tool: string;
  arguments: Record<string, unknown>;
  apiVersion?: string;
  timeoutSeconds?: number;
  idempotencyKey?: string;
  parentTaskId?: string;
}

export type AgentTaskEvent =
  | { type: 'progress'; taskId: string; sequence?: number; percent?: number; stage?: string; message?: string }
  | { type: 'input_required'; taskId: string; requestId: string; question: string; inputSchema: Record<string, unknown> }
  | { type: 'input'; taskId: string; requestId: string; input: unknown }
  | { type: 'completed'; taskId: string; result: unknown; summary?: string }
  | { type: 'failed'; taskId: string; error: AgentTaskError }
  | { type: 'cancel_requested'; taskId: string; reason?: string }
  | { type: 'cancelled'; taskId: string };

export const GATEWAY_ACTIONS = [
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
] as const;

export type GatewayAction = (typeof GATEWAY_ACTIONS)[number];

export interface GatewayMailboxRequest {
  requestId: string;
  action: GatewayAction;
  payload: Record<string, unknown>;
}

export interface GatewayMailboxResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
