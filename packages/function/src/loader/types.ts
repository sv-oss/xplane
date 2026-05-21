import type { CompositionModule } from '@xplane/core';
import type { GitProvider } from './git.js';

/** Constructor type for a Composition class (used internally by sandbox). */
export type CompositionClass = new () => import('@xplane/core').Composition;

/** Base shape of a Crossplane function input with apiVersion, kind, and spec. */
export interface FunctionInput {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly spec?: unknown;
}

/** Input shape for the InlineLoader. */
export interface InlineInput extends FunctionInput {
  readonly kind?: 'Inline';
  readonly spec?: {
    readonly code?: unknown;
  };
}

/** Input shape for the GitLoader. */
export interface GitInput extends FunctionInput {
  readonly kind?: 'Git';
  readonly spec?: {
    readonly url?: unknown;
    readonly path?: unknown;
    readonly ref?: unknown;
    readonly entryPoint?: unknown;
    readonly tokenPath?: unknown;
    readonly provider?: unknown;
  };
}

/** Validated Git loader configuration. */
export interface GitLoaderConfig {
  readonly url: string;
  readonly path: string;
  readonly ref?: string;
  readonly entryPoint?: string;
  readonly tokenPath?: string;
  readonly provider: GitProvider;
}

/**
 * Plugin interface for loading composition code from various sources.
 * Implementations return a CompositionModule with a `run` function.
 */
export interface CompositionLoader {
  /** Unique name for this loader (used in logs). */
  readonly name: string;

  /**
   * Load and return a CompositionModule from the given input.
   * @param input - The `input` field from the RunFunctionRequest
   * @returns A module with a `run(input) => CompositionResult` function
   * @throws If the input is invalid or the composition cannot be loaded
   */
  load(input: FunctionInput): Promise<CompositionModule>;
}
