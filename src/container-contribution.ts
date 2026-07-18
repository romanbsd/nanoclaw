/** Host-side additions applied while spawning an agent container. */
export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ContainerContribution {
  mounts?: VolumeMount[];
  env?: Record<string, string>;
  blockedHosts?: string[];
  /** Additional trusted instructions composed into the runtime system prompt. */
  promptAddendum?: string;
}

export interface ContainerContributorContext {
  agentGroupId: string;
}

export type ContainerContributor = (context: ContainerContributorContext) => ContainerContribution | undefined;

const contributors = new Map<string, ContainerContributor>();

/** Register an optional spawn-time extension without coupling the runner to its subsystem. */
export function registerContainerContributor(name: string, contributor: ContainerContributor): void {
  if (contributors.has(name)) throw new Error(`Container contributor already registered: ${name}`);
  contributors.set(name, contributor);
}

export function resolveContainerContributions(context: ContainerContributorContext): ContainerContribution[] {
  return [...contributors.values()].flatMap((contributor) => contributor(context) ?? []);
}

/**
 * Merge an explicitly ordered contribution list. Later env values win. Mount
 * target collisions are rejected because Docker's last-one-wins behavior is
 * too easy to change accidentally as extensions are added.
 */
export function combineContainerContributions(contributions: ContainerContribution[]): ContainerContribution {
  const env = Object.assign({}, ...contributions.map((contribution) => contribution.env ?? {}));
  const blockedHosts = [...new Set(contributions.flatMap((contribution) => contribution.blockedHosts ?? []))];
  const promptAddendum = contributions
    .map((contribution) => contribution.promptAddendum?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n\n');
  const mountsByTarget = new Map<string, VolumeMount>();
  for (const mount of contributions.flatMap((contribution) => contribution.mounts ?? [])) {
    const existing = mountsByTarget.get(mount.containerPath);
    if (existing && (existing.hostPath !== mount.hostPath || existing.readonly !== mount.readonly)) {
      throw new Error(`Conflicting container mount contribution: ${mount.containerPath}`);
    }
    mountsByTarget.set(mount.containerPath, mount);
  }

  return {
    mounts: [...mountsByTarget.values()],
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(blockedHosts.length > 0 ? { blockedHosts } : {}),
    ...(promptAddendum ? { promptAddendum } : {}),
  };
}
