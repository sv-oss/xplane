import type { Composition } from '@xplane/core';
import type { GitProvider } from './git.js';

/** Constructor type for a Composition class. */
export type CompositionClass = new () => Composition;

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
 * Implementations receive the function input and return a Composition class.
 */
export interface CompositionLoader {
  /** Unique name for this loader (used in logs). */
  readonly name: string;

  /**
   * Load and return a Composition class from the given input.
   * @param input - The `input` field from the RunFunctionRequest
   * @returns A class constructor extending Composition
   * @throws If the input is invalid or the composition cannot be loaded
   */
  load(input: FunctionInput): Promise<CompositionClass>;
}
