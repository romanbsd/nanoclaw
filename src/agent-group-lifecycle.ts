import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { createAgentGroup, deleteAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { deleteContainerConfig } from './db/container-configs.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import type { AgentGroup } from './types.js';

export interface AgentGroupDeleteCounts {
  sessions: number;
  pending_questions: number;
  pending_approvals: number;
  agent_destinations_owned: number;
  agent_destinations_pointing: number;
  pending_sender_approvals: number;
  pending_channel_approvals: number;
  messaging_group_agents: number;
  agent_group_members: number;
  user_roles: number;
  container_configs: number;
}

/** Create the central row and all filesystem/container-config state required to spawn it. */
export function provisionAgentGroup(
  group: AgentGroup,
  options?: { instructions?: string; provider?: string | null },
): AgentGroup {
  createAgentGroup(group);
  try {
    initGroupFilesystem(group, options);
    return group;
  } catch (err) {
    deleteContainerConfig(group.id);
    deleteAgentGroup(group.id);
    removeAgentGroupFiles(group);
    throw err;
  }
}

/** Allocate a globally unique folder from an already-sanitized base name. */
export function allocateAgentGroupFolder(baseName: string, fallback = 'agent'): string {
  const base = baseName || fallback;
  let folder = base;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) folder = `${base}-${suffix++}`;
  return folder;
}

/** FK-ordered deletion shared by CLI and integration-owned agent lifecycles. */
export function deleteAgentGroupCascade(groupId: string): AgentGroupDeleteCounts {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(groupId);
  if (!exists) throw new Error(`group not found: ${groupId}`);

  const hasAgentDestinations = hasTable(db, 'agent_destinations');
  const hasPendingApprovals = hasTable(db, 'pending_approvals');
  return db.transaction((id: string): AgentGroupDeleteCounts => {
    const counts: AgentGroupDeleteCounts = {
      sessions: 0,
      pending_questions: 0,
      pending_approvals: 0,
      agent_destinations_owned: 0,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 0,
      pending_channel_approvals: 0,
      messaging_group_agents: 0,
      agent_group_members: 0,
      user_roles: 0,
      container_configs: 0,
    };

    if (hasAgentDestinations) {
      counts.agent_destinations_owned = db
        .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
        .run(id).changes;
      counts.agent_destinations_pointing = db
        .prepare('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?')
        .run('agent', id).changes;
    }
    counts.pending_questions = db
      .prepare('DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)')
      .run(id).changes;
    if (hasPendingApprovals) {
      counts.pending_approvals = db
        .prepare(
          'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
        )
        .run(id, id).changes;
    }
    counts.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(id).changes;
    counts.pending_sender_approvals = db
      .prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?')
      .run(id).changes;
    counts.pending_channel_approvals = db
      .prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?')
      .run(id).changes;
    counts.messaging_group_agents = db
      .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
      .run(id).changes;
    counts.agent_group_members = db.prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?').run(id).changes;
    counts.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(id).changes;
    counts.container_configs = db.prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(id).changes;
    db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
    return counts;
  })(groupId);
}

/** Remove the workspace and all per-session state for an already-deleted group. */
export function removeAgentGroupFiles(group: Pick<AgentGroup, 'id' | 'folder'>): void {
  fs.rmSync(path.join(GROUPS_DIR, group.folder), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'v2-sessions', group.id), { recursive: true, force: true });
}
