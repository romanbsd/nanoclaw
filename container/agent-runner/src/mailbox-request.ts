export interface MailboxResponseRow {
  id: string;
  content: string;
}

export interface MailboxRequestOptions<T> {
  send: () => void | Promise<void>;
  findResponse: () => MailboxResponseRow | undefined;
  complete: (responseId: string) => void;
  parse: (content: string) => T;
  timeoutMs: number;
  pollIntervalMs?: number;
  timeoutMessage: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Send one mailbox request, consume its matching response, or fail on timeout. */
export async function requestThroughMailbox<T>(options: MailboxRequestOptions<T>): Promise<T> {
  await options.send();
  const deadline = Date.now() + options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  while (Date.now() < deadline) {
    const response = options.findResponse();
    if (response) {
      options.complete(response.id);
      return options.parse(response.content);
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error(options.timeoutMessage);
}
