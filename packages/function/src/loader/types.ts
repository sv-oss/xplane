import type { Composition } from "@xplane/core";

/** Constructor type for a Composition class. */
export type CompositionClass = new () => Composition;

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
  load(input: Record<string, unknown>): CompositionClass;
}
