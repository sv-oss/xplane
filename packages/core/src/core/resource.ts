import { Construct } from "constructs";
import {
  createTrackedProxy,
  type DependencyCollector,
  type DependencyGraph,
  type ResourceRef,
} from "../tracking/index.js";
import { getTrackingMeta, isTracked, UNRESOLVED } from "../tracking/proxy.js";
import { CONTEXT_COLLECTOR, CONTEXT_GRAPH, CONTEXT_XR_META } from "./construct.js";

/**
 * Recursive type that allows arbitrary deep property access without undefined.
 * Uses a known-key mapped type to bypass noUncheckedIndexedAccess.
 * Used as the default for untyped Resource spec/status so that
 * `resource.spec.forProvider.vpcId` compiles without casts.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional for ergonomic deep access
export type AnyFields = Record<string, any>;

/** Minimal Kubernetes resource shape. */
export interface KubernetesResource {
  apiVersion: string;
  kind: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Props for constructing a Resource. */
export interface ResourceProps {
  apiVersion: string;
  kind: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  /** Top-level extra fields for resources that don't use spec (e.g. Secret's data/stringData/type). */
  [key: string]: unknown;
}

/** Configuration options for a resource. */
export interface ResourceOptions {
  /** Whether auto-ready detection is enabled for this resource. Default: true. */
  autoReady?: boolean;
}

/**
 * A Construct that represents a single Crossplane managed/composed resource.
 *
 * The `spec` and `status` properties are proxy-wrapped for automatic
 * dependency tracking. Assigning a value from another resource's status
 * to this resource's spec automatically records a dependency edge.
 */
export class Resource<
  TSpec extends object = AnyFields,
  TStatus extends object = AnyFields,
> extends Construct {
  readonly apiVersion: string;
  readonly kind: string;
  readonly resourceRef: ResourceRef;

  /** Proxy-wrapped desired spec — writes are tracked. */
  readonly spec: TSpec;
  /** Proxy-wrapped observed status — reads create dependency tracking. */
  readonly status: TStatus;
  /** Proxy-wrapped desired metadata. */
  readonly metadata: NonNullable<KubernetesResource["metadata"]>;

  /** Whether auto-ready is enabled for this resource. */
  autoReady: boolean;

  /** Extra top-level fields (e.g. data/stringData for Secret). Not proxy-tracked. */
  private readonly _extra: Record<string, unknown>;

  /** Observed state populated by the bridge before construction. */
  private _observed: KubernetesResource | undefined;

  /** Backing object for the status proxy — populated by setObserved(). */
  private readonly _statusTarget: Record<string, unknown>;

  /** Backing object for the metadata proxy — populated by setObserved(). */
  private readonly _metaTarget: Record<string, unknown>;

  /** Keys the user explicitly declared in constructor metadata props. */
  private readonly _desiredMetaKeys: Set<string>;

  /** Explicit dependency refs. */
  private readonly _explicitDeps: ResourceRef[] = [];

  /** @internal */
  private readonly _graph: DependencyGraph;

  constructor(scope: Construct, id: string, props: ResourceProps, options?: ResourceOptions) {
    super(scope, id);

    this.apiVersion = props.apiVersion;
    this.kind = props.kind;
    this.autoReady = options?.autoReady ?? true;

    const collector = this.node.tryGetContext(CONTEXT_COLLECTOR) as DependencyCollector | undefined;
    const graph = this.node.tryGetContext(CONTEXT_GRAPH) as DependencyGraph | undefined;

    if (!collector || !graph) {
      throw new Error("Resource must be created within a Composition tree");
    }

    this.resourceRef = { id: this.node.path };
    graph.addResource(this.resourceRef);

    // Collect extra top-level fields (anything beyond the known keys)
    const KNOWN_KEYS = new Set(["apiVersion", "kind", "metadata", "spec"]);
    this._extra = {};
    for (const [k, v] of Object.entries(props)) {
      if (!KNOWN_KEYS.has(k)) this._extra[k] = v;
    }

    // Desired spec — tracks writes
    const specTarget = (props.spec ?? {}) as TSpec;
    // Deep-scan initial props for tracked proxy values from other resources.
    // Object literals in constructor args bypass the proxy set trap, so we
    // must find and process them before wrapping.
    resolveTrackedRefs(specTarget as Record<string, unknown>, this.resourceRef, "spec", collector);
    this.spec = createTrackedProxy(specTarget, {
      owner: this.resourceRef,
      path: "spec",
      observed: false,
      collector,
    });

    // Desired metadata — observed mode so that reading unset fields
    // (e.g. resource.metadata.name on a resource whose name is assigned
    // by Crossplane) creates a dependency edge that resolves from observed state.
    this._metaTarget = props.metadata ?? {};
    this._desiredMetaKeys = new Set(Object.keys(this._metaTarget));
    this.metadata = createTrackedProxy(this._metaTarget, {
      owner: this.resourceRef,
      path: "metadata",
      observed: true,
      collector,
    }) as NonNullable<KubernetesResource["metadata"]>;

    // Observed status — reads return tracked proxies for dependency detection.
    // We keep a reference to the backing object so setObserved() can populate
    // it, making resource.status work correctly after observed state arrives.
    this._statusTarget = {} as Record<string, unknown>;
    this.status = createTrackedProxy(this._statusTarget, {
      owner: this.resourceRef,
      path: "status",
      observed: true,
      collector,
    }) as TStatus;

    this._graph = graph;
  }

  /** Fully qualified path in the construct tree. */
  get path(): string {
    return this.node.path;
  }

  /** Add an explicit dependency on another resource. */
  addDependency(other: Resource): void {
    this._explicitDeps.push(other.resourceRef);
    this._graph.addExplicitDependency(this.resourceRef, other.resourceRef);
  }

  /** Get explicit dependency refs. */
  get explicitDependencies(): ReadonlyArray<ResourceRef> {
    return this._explicitDeps;
  }

  /** Set observed state (called by the bridge before compose). */
  setObserved(observed: KubernetesResource): void {
    this._observed = observed;

    // Snapshot any metadata keys written between construction and now
    // (e.g. via proxy writes like resource.metadata.annotations = {...}).
    for (const key of Object.keys(this._metaTarget)) {
      this._desiredMetaKeys.add(key);
    }

    // Populate backing objects so proxy reads (resource.metadata.name,
    // resource.status.vpcId) return real values for dependency resolution.
    // These observed keys are NOT tracked in _desiredMetaKeys, so they
    // won't appear in toDesired() output.
    if (observed.metadata && typeof observed.metadata === "object") {
      Object.assign(this._metaTarget, observed.metadata);
    }
    if (observed.status && typeof observed.status === "object") {
      Object.assign(this._statusTarget, observed.status);
    }
  }

  /** Get observed state. */
  get observed(): KubernetesResource | undefined {
    return this._observed;
  }

  /**
   * Compute a unique name for a resource based on its construct node path,
   * similar to `cdk.Names.uniqueResourceName`.
   *
   * The name is structured as:
   *   `[namespace-]claimName-PathSegments[-extra]-hash8`
   *
   * - XR namespace (if present) and XR name are always prepended.
   * - Path segments (construct tree, root skipped) are appended next.
   * - An optional `extra` string is appended after the path.
   * - An 8-char hash of the full untruncated string is always appended for uniqueness.
   * - Whitespace in each segment is stripped (CDK convention).
   * - Disallowed characters are replaced by the separator; consecutive separators are collapsed.
   * - The result is truncated to `maxLength` while keeping the hash suffix.
   *
   * @param scope    - The construct whose node path is used.
   * @param options  - Optional tuning.
   */
  static uniqueName(
    scope: Construct,
    options: {
      /** Maximum length of the resulting name. Default: 63. */
      maxLength?: number;
      /** Separator inserted between path segments (also replaces disallowed chars). Default: "-". */
      separator?: string;
      /** Regex of characters to keep. Anything else is replaced by the separator. Default: /[^a-zA-Z0-9]/g */
      allowedPattern?: RegExp;
      /** Extra string appended after the path segments and before the hash. */
      extra?: string;
    } = {},
  ): string {
    const maxLength = options.maxLength ?? 63;
    const separator = options.separator ?? "-";
    const allowedPattern = options.allowedPattern ?? /[^a-zA-Z0-9]/g;
    const escapedSep = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const collapseRe = new RegExp(`${escapedSep}+`, "g");

    const clean = (s: string) =>
      s
        .replace(/\s+/g, "") // strip whitespace (CDK convention)
        .replace(allowedPattern, separator)
        .replace(collapseRe, separator)
        .replace(new RegExp(`^${escapedSep}|${escapedSep}$`, "g"), ""); // trim leading/trailing sep

    // Retrieve XR name/namespace stored by Composition in context
    const xrMeta = scope.node.tryGetContext(CONTEXT_XR_META) as
      | { name?: string; namespace?: string }
      | undefined;
    const xrName = xrMeta?.name;
    const xrNamespace = xrMeta?.namespace;

    // Build ordered parts: [namespace, claimName, ...pathSegments, extra]
    const parts: string[] = [];
    if (xrNamespace) parts.push(clean(xrNamespace));
    if (xrName) parts.push(clean(xrName));

    // node.scopes[0] is the root Composition — skip it
    for (const s of scope.node.scopes.slice(1)) {
      const c = clean(s.node.id);
      if (c) parts.push(c);
    }

    if (options.extra) {
      const c = clean(options.extra);
      if (c) parts.push(c);
    }

    const full = parts.join(separator);
    const hash = shortHash(full);

    // Always append hash
    const withHash = `${full}${separator}${hash}`;

    if (withHash.length <= maxLength) return withHash;

    // Truncate prefix, keep separator + hash (8 chars)
    const prefix = full.slice(0, maxLength - hash.length - separator.length);
    return `${prefix}${separator}${hash}`;
  }

  /**
   * Serialize to a plain Kubernetes resource object for the desired state.
   * Strips proxy wrappers, UNRESOLVED sentinels, and server-managed metadata
   * fields (uid, resourceVersion, etc.) that must not appear in desired state.
   */
  toDesired(): KubernetesResource {
    // Only emit metadata keys the user explicitly declared or wrote via proxy.
    // Observed state (uid, resourceVersion, server-set labels, etc.) is used
    // for dependency resolution reads but must NOT flow back as desired state —
    // a function should only return its intent.
    const fullMeta = JSON.parse(JSON.stringify(this.metadata)) as Record<string, unknown>;
    const desiredMeta: Record<string, unknown> = {};
    for (const key of this._desiredMetaKeys) {
      if (key in fullMeta) {
        desiredMeta[key] = fullMeta[key];
      }
    }
    const cleanMeta = stripUnresolved(desiredMeta) as KubernetesResource["metadata"];

    const desired: KubernetesResource = {
      // Spread extra top-level fields first so spec/metadata take precedence
      ...this._extra,
      apiVersion: this.apiVersion,
      kind: this.kind,
      metadata: cleanMeta,
      spec: stripUnresolved(JSON.parse(JSON.stringify(this.spec))) as Record<string, unknown>,
    };
    // Drop spec entirely if it's empty and there were no spec props in the schema
    if (
      desired.spec &&
      typeof desired.spec === "object" &&
      Object.keys(desired.spec).length === 0
    ) {
      delete desired.spec;
    }
    return desired;
  }
}

/**
 * Produce an 8-character hex hash of a string using a simple djb2-style
 * algorithm — no crypto dependency required.
 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(16).padStart(8, "0");
}

/** Recursively remove UNRESOLVED sentinel values from an object. */
function stripUnresolved(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "symbol" && obj === UNRESOLVED) return undefined;

  if (Array.isArray(obj)) {
    return obj.map(stripUnresolved);
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const cleaned = stripUnresolved(value);
      if (cleaned !== undefined) {
        result[key] = cleaned;
      }
    }
    return result;
  }

  return obj;
}

/**
 * Recursively scan an object for tracked proxy values from other resources.
 * For each one found, record a dependency edge and replace the value with
 * the UNRESOLVED sentinel. This handles values passed via object literals
 * in constructor props, which bypass the proxy's set trap.
 */
function resolveTrackedRefs(
  obj: Record<string, unknown>,
  owner: ResourceRef,
  basePath: string,
  collector: DependencyCollector,
): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = basePath ? `${basePath}.${key}` : key;

    if (isTracked(value)) {
      const sourceMeta = getTrackingMeta(value);
      if (sourceMeta && sourceMeta.owner.id !== owner.id) {
        collector.addEdge({
          from: sourceMeta.owner,
          fromPath: sourceMeta.path,
          to: owner,
          toPath: path,
        });
        obj[key] = UNRESOLVED;
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (isTracked(item)) {
          const sourceMeta = getTrackingMeta(item);
          if (sourceMeta && sourceMeta.owner.id !== owner.id) {
            collector.addEdge({
              from: sourceMeta.owner,
              fromPath: sourceMeta.path,
              to: owner,
              toPath: `${path}[${i}]`,
            });
            value[i] = UNRESOLVED;
          }
        } else if (typeof item === "object" && item !== null) {
          resolveTrackedRefs(item as Record<string, unknown>, owner, `${path}[${i}]`, collector);
        }
      }
      continue;
    }

    if (typeof value === "object" && value !== null) {
      resolveTrackedRefs(value as Record<string, unknown>, owner, path, collector);
    }
  }
}
