import { registerProvider } from './provider-registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[mock-provider] ${msg}`);
}

function shouldDelegateMail(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return lower.includes('invoice') || lower.includes('new mail') || lower.includes('accounting review');
}

async function* scenarioEvents(scenario: string, prompt: string): AsyncGenerator<ProviderEvent> {
  yield { type: 'activity' };
  yield { type: 'init', continuation: `mock-session-${Date.now()}` };
  yield { type: 'activity' };

  if (scenario === 'secretary' && shouldDelegateMail(prompt)) {
    yield { type: 'result', text: 'Mock scenarios no longer bypass the mailbox-backed MCP tool path.' };
    return;
  }

  if (scenario === 'accountant') {
    yield {
      type: 'result',
      text: `Acknowledged accounting task: ${prompt.slice(0, 300)}`,
    };
    return;
  }

  yield { type: 'result', text: `Mock response to: ${prompt.slice(0, 100)}` };
}

/**
 * Mock provider for testing. Returns canned responses or scenario-driven tool calls.
 */
export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private responseFactory: (prompt: string) => string;
  private scenario: string | undefined;

  constructor(_options: ProviderOptions = {}, responseFactory?: (prompt: string) => string) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
    this.scenario = process.env.MOCK_SCENARIO;
    if (this.scenario) {
      log(`Using scenario: ${this.scenario}`);
    }
  }

  registerMemorySessionHook(_hook: MemorySessionHookRegistration): void {}

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    if (this.scenario) {
      return this.scenarioQuery(input, this.scenario);
    }
    return this.basicQuery(input);
  }

  private scenarioQuery(input: QueryInput, scenario: string): AgentQuery {
    let aborted = false;
    const events = {
      async *[Symbol.asyncIterator]() {
        for await (const event of scenarioEvents(scenario, input.prompt)) {
          if (aborted) return;
          yield event;
        }
      },
    };

    return {
      push() {},
      end() {},
      events,
      abort() {
        aborted = true;
      },
    };
  }

  private basicQuery(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const responseFactory = this.responseFactory;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        // Process initial prompt
        yield { type: 'activity' };
        yield { type: 'result', text: responseFactory(input.prompt) };

        // Process any pushed follow-ups
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            yield { type: 'result', text: responseFactory(msg) };
            continue;
          }
          // Wait for push() or end()
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining
        while (pending.length > 0) {
          const msg = pending.shift()!;
          yield { type: 'result', text: responseFactory(msg) };
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('mock', (opts) => new MockProvider(opts));
