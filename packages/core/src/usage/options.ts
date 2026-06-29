/**
 * Options that configure Usage / ClusterUsage emission for a Composition.
 *
 * When `emitUsageEdges` is true, the framework synthesizes one Crossplane
 * `Usage` (namespaced dependent) or `ClusterUsage` (cluster-scoped dependent)
 * per collapsed `(by, of)` dependency pair tracked by the dependency graph.
 *
 * Synthesized docs carry a `metadata.annotations` marker keyed by
 * {@link SYNTHETIC_ANNOTATION_KEY} so downstream layers can identify them
 * without contract-shape changes.
 */
export interface UsageEdgeOptions {
  /**
   * When `true`, set `spec.replayDeletion: true` on every synthesized doc.
   * Defaults to `false` (Crossplane's own default).
   */
  replayDeletion?: boolean;
  /**
   * When `true`, also synthesize Usage entries where the dependency (`of`)
   * is an external (observed-only) resource that xplane does not emit itself.
   * Defaults to `false`.
   */
  includeExternal?: boolean;
  /**
   * When `false`, synthesized Usage/ClusterUsage docs are still emitted as
   * desired composed resources but are filtered out of
   * `status.xplane.emittedResources` to keep the XR status focused on
   * author-emitted resources. Defaults to `true`.
   */
  includeInXplaneStatus?: boolean;
}

/** Options accepted by the `Composition` constructor. */
export interface CompositionOptions {
  /** Enables synthesized Usage / ClusterUsage emission. Defaults to `false`. */
  emitUsageEdges?: boolean;
  /** Fine-grained Usage emission options. */
  usageOptions?: UsageEdgeOptions;
  /**
   * Mirror of the `Composition.emitXplaneStatus` field; setting it via
   * options is equivalent to assigning the field in the constructor body.
   */
  emitXplaneStatus?: boolean;
}

/** Fully-resolved options with defaults applied. */
export interface ResolvedCompositionOptions {
  readonly emitUsageEdges: boolean;
  readonly emitXplaneStatus: boolean;
  readonly usageOptions: Required<UsageEdgeOptions>;
}

/** Apply defaults to user-supplied composition options. */
export function resolveCompositionOptions(
  input: CompositionOptions | undefined,
): ResolvedCompositionOptions {
  const usage = input?.usageOptions ?? {};
  return {
    emitUsageEdges: input?.emitUsageEdges === true,
    emitXplaneStatus: input?.emitXplaneStatus === true,
    usageOptions: {
      replayDeletion: usage.replayDeletion === true,
      includeExternal: usage.includeExternal === true,
      includeInXplaneStatus: usage.includeInXplaneStatus !== false,
    },
  };
}

/** Annotation key stamped on every framework-synthesized resource document. */
export const SYNTHETIC_ANNOTATION_KEY = 'xplane.crossplane.io/synthetic';

/** Annotation value used for synthesized Usage / ClusterUsage docs. */
export const SYNTHETIC_USAGE_VALUE = 'usage';

/** Crossplane v2 API group/version used for emitted Usage / ClusterUsage docs. */
export const USAGE_API_VERSION = 'protection.crossplane.io/v1beta1';
