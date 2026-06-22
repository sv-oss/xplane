import type { Logger } from '@crossplane-org/function-sdk-typescript';
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

/** Input shape for the OciLoader. */
export interface OciInput extends FunctionInput {
  readonly kind?: 'Oci';
  readonly spec?: {
    readonly registry?: unknown;
    readonly repository?: unknown;
    readonly tag?: unknown;
    readonly digest?: unknown;
    readonly entryPoint?: unknown;
    readonly auth?: unknown;
    readonly tagPullPolicy?: unknown;
  };
}

/**
 * Auth configuration for the OciLoader. All token material is read from files
 * (typically Kubernetes secret mounts) — never from the spec itself.
 */
export type OciAuthConfig =
  | { readonly type: 'basic'; readonly usernamePath: string; readonly passwordPath: string }
  | { readonly type: 'token'; readonly tokenPath: string }
  | { readonly type: 'dockerConfig'; readonly configPath: string };

/**
 * Tag resolution policy, mirroring Kubernetes `imagePullPolicy`:
 * - `Always`: re-resolve the manifest on every load (picks up moving tags).
 * - `IfNotPresent`: if the tag has been resolved before and the extracted
 *   layer is still cached, skip the registry round-trip entirely.
 *
 * Ignored when `digest` is set (digests are immutable, so the cache is
 * always trusted on hit).
 */
export type OciTagPullPolicy = 'Always' | 'IfNotPresent';

/** Validated OCI loader configuration. */
export interface OciLoaderConfig {
  readonly registry: string;
  readonly repository: string;
  /** Either `tag` or `digest` must be set; if both are present, `digest` wins. */
  readonly tag?: string;
  readonly digest?: string;
  /** Entry file inside an extracted tarball layer. Defaults to `index.js`. */
  readonly entryPoint: string;
  readonly auth?: OciAuthConfig;
  /** Defaults to `Always`. Only consulted when `tag` is used. */
  readonly tagPullPolicy: OciTagPullPolicy;
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
   * @param logger - Optional logger for debug/info diagnostics. Loaders should
   *                create a child logger scoped to their own context.
   * @returns A module with a `run(input) => CompositionResult` function
   * @throws If the input is invalid or the composition cannot be loaded
   */
  load(input: FunctionInput, logger?: Logger): Promise<CompositionModule>;
}
