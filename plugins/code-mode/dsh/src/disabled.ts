/**
 * Optional outside provider of the tools the user disabled (mcp-ui, for example, through the
 * `mcpDisabled` service). Code Mode only hides those tools from the model. Refusing a call is the
 * host's job, done by its `tools/pre-execute` listener. Code Mode works without the provider. @module
 */

/** Service name the executor looks up each time it builds a tool list. */
export const DISABLED_SERVICE = 'mcpDisabled';

/** Answers whether the user disabled a tool, by its model-facing name. */
export interface DisabledProvider {
  isDisabled(name: string): boolean;
}

/** The part of a Cordis context this lookup reads. */
interface ServiceLookup {
  get(name: string): unknown;
}

const NOTHING_HIDDEN = (): boolean => false;

/**
 * Reads the provider from the context. A missing service, a service without `isDisabled`, or a
 * `get` that throws all mean no provider.
 */
function readProvider(ctx: unknown): DisabledProvider | undefined {
  try {
    const found: unknown = (ctx as ServiceLookup).get(DISABLED_SERVICE);
    return typeof found === 'object' && found !== null && 'isDisabled' in found ? found as DisabledProvider : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the hidden-tool test for one tool list. The provider is read here, so each list built
 * sees the current state. A provider that throws hides nothing.
 * @param ctx - the executor's context. Services are read lazily, so a provider loaded later still applies.
 * @returns a predicate that is true for a tool name the user disabled.
 */
export function hiddenToolPredicate(ctx: unknown): (name: string) => boolean {
  const provider = readProvider(ctx);
  if (provider === undefined) return NOTHING_HIDDEN;
  return (name) => {
    try {
      return provider.isDisabled(name) === true;
    } catch {
      return false;
    }
  };
}
