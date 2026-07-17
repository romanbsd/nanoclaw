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

/**
 * Resolve provider and extension contributions into one spawn-time object.
 * Extension env overlays provider env, while provider mounts remain last to
 * preserve the existing Docker mount precedence.
 */
export function combineContainerContributions(
  provider: ContainerContribution,
  extensions: ContainerContribution[],
): ContainerContribution {
  const all = [provider, ...extensions];
  const env = Object.assign({}, provider.env, ...extensions.map((contribution) => contribution.env ?? {}));
  const blockedHosts = [...new Set(all.flatMap((contribution) => contribution.blockedHosts ?? []))];
  const promptAddendum = all
    .map((contribution) => contribution.promptAddendum?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n\n');

  return {
    mounts: [...extensions.flatMap((contribution) => contribution.mounts ?? []), ...(provider.mounts ?? [])],
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(blockedHosts.length > 0 ? { blockedHosts } : {}),
    ...(promptAddendum ? { promptAddendum } : {}),
  };
}
