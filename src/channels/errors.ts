/**
 * Delivery could not be attempted because the owning channel adapter is
 * offline. Unlike a send failure, this is a host lifecycle condition: the
 * outbound row must remain pending without consuming its retry budget.
 */
export class ChannelUnavailableError extends Error {
  constructor(
    public readonly channelType: string,
    public readonly instance: string = channelType,
  ) {
    super(`Channel adapter is unavailable: ${instance}`);
    this.name = 'ChannelUnavailableError';
  }
}
