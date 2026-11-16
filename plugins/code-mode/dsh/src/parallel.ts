/**
 * Optional outside classifier for concurrency safety. Another deployment plugin (mcp-ui, for
 * example) may provide the `mcpParallel` service to mark tools that may overlap. Code Mode works
 * without it. @module
 */

/** Service name the executor looks up on each classification. */
export const PARALLEL_SERVICE = 'mcpParallel';

/** Answers whether a tool may run concurrently with other calls. */
export interface ParallelClassifier {
  isParallel(name: string): boolean;
}

/** The part of a Cordis context this lookup reads. */
interface ServiceLookup {
  get(name: string): unknown;
}

/**
 * The classifier when a provider is present in the context at call time.
 * @param ctx - the executor's context. Services are read lazily, so a provider loaded after the executor still applies.
 * @returns the classifier, or undefined when no provider is present.
 */
export function findParallelClassifier(ctx: unknown): ParallelClassifier | undefined {
  return (ctx as ServiceLookup).get(PARALLEL_SERVICE) as ParallelClassifier | undefined;
}
