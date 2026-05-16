import { Construct } from "constructs";
import { createTrackedProxy, DependencyCollector, DependencyGraph } from "../tracking/index.js";
import { CONTEXT_COLLECTOR, CONTEXT_GRAPH, CONTEXT_XR_META } from "./construct.js";
import type { AnyFields, Resource } from "./resource.js";

/**
 * A Composition is the root Construct for a Crossplane composition function.
 * Like CDK's `App` or cdk8s's `Chart`, it is the root of the construct tree.
 * Resources and constructs are created in the constructor.
 *
 * Usage:
 * ```ts
 * class MyComposition extends Composition {
 *   constructor() {
 *     super();
 *     const vpc = new aws.ec2.VPC(this, 'vpc', { ... });
 *     const subnet = new aws.ec2.Subnet(this, 'subnet', {
 *       spec: { forProvider: { vpcId: vpc.status.atProvider.vpcId } }
 *     });
 *   }
 * }
 * ```
 */
export class Composition extends Construct {
	/**
	 * Pending XR data, set by the framework before instantiation.
	 * @internal
	 */
	static _pendingXR: Record<string, unknown> | undefined;

	/**
	 * Pending environment data, set by the framework before instantiation.
	 * Populated from the Crossplane context key `apiextensions.crossplane.io/environment`.
	 * @internal
	 */
	static _pendingEnvironment: Record<string, unknown> | undefined;

	/** The composite resource (XR) — proxy-wrapped for tracking. */
	readonly xr: AnyFields;

	/** Environment data from function-environment-configs or other pipeline steps. */
	readonly environment: AnyFields;

	/** Raw name from the XR metadata (not proxy-tracked). */
	readonly xrName: string | undefined;

	/** Raw namespace from the XR metadata (not proxy-tracked). */
	readonly xrNamespace: string | undefined;

	/** Dependency collector shared across all resources. */
	readonly collector: DependencyCollector;

	/** Dependency graph built during compose(). */
	readonly graph: DependencyGraph;

	/** Registered status output function. @internal */
	private _statusFn?: () => Record<string, unknown>;

	constructor() {
		super(undefined as unknown as Construct, "");

		this.collector = new DependencyCollector();
		this.graph = new DependencyGraph();

		// Set context before children are added (subclass constructor body runs after this)
		this.node.setContext(CONTEXT_COLLECTOR, this.collector);
		this.node.setContext(CONTEXT_GRAPH, this.graph);

		// Consume pending XR data (set by handler before construction)
		const xrData = Composition._pendingXR ?? {};
		Composition._pendingXR = undefined;

		// Consume pending environment data (set by handler before construction)
		const envData = Composition._pendingEnvironment ?? {};
		Composition._pendingEnvironment = undefined;

		// Store raw XR name/namespace for use by Resource.uniqueName (untracked)
		const xrMeta = (xrData.metadata ?? {}) as Record<string, unknown>;
		this.xrName = typeof xrMeta.name === "string" ? xrMeta.name : undefined;
		this.xrNamespace = typeof xrMeta.namespace === "string" ? xrMeta.namespace : undefined;
		this.node.setContext(CONTEXT_XR_META, { name: this.xrName, namespace: this.xrNamespace });

		// XR is observed state — reads track dependencies
		this.xr = createTrackedProxy(xrData as AnyFields, {
			owner: { id: "__xr__" },
			path: "",
			observed: true,
			collector: this.collector,
		});

		// Environment is read-only observed state (no dependency tracking needed)
		this.environment = envData as AnyFields;
	}

	/**
	 * Register a function that computes the desired XR status output.
	 *
	 * The function is called by the framework **after** observed state has been
	 * fed into all resources, so `resource.observed` contains real data.
	 *
	 * @example
	 * ```ts
	 * this.setStatusOutput(() => ({
	 *   config: {
	 *     projectHostedZoneId: hostedZone.observed?.status?.atProvider?.id,
	 *   },
	 * }));
	 * ```
	 */
	setStatusOutput(fn: () => Record<string, unknown>): void {
		this._statusFn = fn;
	}

	/**
	 * Compute and return the desired status output.
	 * Returns an empty object if no status function was registered.
	 * @internal
	 */
	computeStatusOutput(): Record<string, unknown> {
		return this._statusFn?.() ?? {};
	}

	/**
	 * Walk up the construct tree and return the root Composition.
	 * Throws if the scope is not within a Composition.
	 */
	static of(scope: Construct): Composition {
		let current: Construct | undefined = scope;
		while (current !== undefined) {
			if (current instanceof Composition) return current;
			current = current.node.scope;
		}
		throw new Error(
			"No Composition found in the scope chain. Ensure constructs are created within a Composition.",
		);
	}

	/** Get all registered resources keyed by construct path. */
	get resources(): ReadonlyMap<string, Resource> {
		// Lazy import to avoid circular dependency
		const map = new Map<string, Resource>();
		for (const construct of this.node.findAll()) {
			if (isResource(construct)) {
				map.set(construct.node.path, construct);
			}
		}
		return map;
	}
}

/**
 * Type guard for Resource — avoids circular import by checking for
 * characteristic properties rather than instanceof.
 */
function isResource(construct: unknown): construct is Resource {
	return (
		construct !== null &&
		typeof construct === "object" &&
		"apiVersion" in construct &&
		"kind" in construct &&
		"resourceRef" in construct
	);
}
