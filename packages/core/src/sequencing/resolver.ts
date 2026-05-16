import type { KubernetesResource, Resource } from "../core/resource.js";
import type { DependencyGraph } from "../tracking/index.js";
import { UNRESOLVED } from "../tracking/proxy.js";

/** Result of dependency resolution for a single resource. */
export interface ResolutionResult {
	/** The resource. */
	resource: Resource;
	/** Whether all dependencies are satisfied and the resource can be emitted. */
	ready: boolean;
	/** Paths that are still unresolved (waiting on upstream). */
	unresolvedPaths: string[];
}

/** Result of resolving all resources in a composition. */
export interface SequencingResult {
	/** Resources in dependency order that are ready to emit. */
	emit: Resource[];
	/** Resources blocked on unresolved dependencies. */
	blocked: Resource[];
	/** Topologically sorted resource IDs. */
	order: string[];
}

/**
 * Resolves resource dependencies and determines which resources can be
 * emitted in the current pass.
 *
 * Algorithm:
 * 1. Topologically sort resources using the dependency graph.
 * 2. For each resource (in order), check if upstream dependencies have
 *    resolved values in observed state.
 * 3. If all deps resolved → emit. If any dep unresolved → block.
 */
export function resolveSequencing(
	resources: ReadonlyMap<string, Resource>,
	graph: DependencyGraph,
	observedResources: ReadonlyMap<string, KubernetesResource>,
): SequencingResult {
	const order = graph.topologicalSort();
	const emit: Resource[] = [];
	const blocked: Resource[] = [];

	for (const resourceId of order) {
		const resource = findResourceByRef(resources, resourceId);
		if (!resource) continue;

		const deps = graph.getDependencies(resourceId);
		let allDepsReady = true;

		for (const depId of deps) {
			// Check if the dependency resource has been observed
			const depResource = findResourceByRef(resources, depId);
			if (!depResource) {
				allDepsReady = false;
				continue;
			}

			const observed = observedResources.get(depResource.path);
			if (!observed) {
				allDepsReady = false;
			}
		}

		// Even if all deps are observed, check that this resource's
		// desired state has no UNRESOLVED sentinels
		if (allDepsReady && hasUnresolvedFields(resource)) {
			allDepsReady = false;
		}

		if (allDepsReady) {
			emit.push(resource);
		} else {
			blocked.push(resource);
		}
	}

	return { emit, blocked, order };
}

/**
 * Check if a resource's desired state contains any UNRESOLVED sentinels.
 * Uses the raw spec/metadata before stripping, so UNRESOLVED symbols are visible.
 */
function hasUnresolvedFields(resource: Resource): boolean {
	// Serialize via JSON — UNRESOLVED symbols become undefined/disappear,
	// but we need to check the raw proxy values. Use the toDesired output
	// which preserves UNRESOLVED before stripUnresolved runs.
	// Actually, walk the spec proxy directly.
	return containsUnresolved(resource.spec) || containsUnresolved(resource.metadata);
}

/** Recursively check if an object contains UNRESOLVED sentinels. */
function containsUnresolved(obj: unknown): boolean {
	if (obj === UNRESOLVED) return true;
	if (obj === null || obj === undefined) return false;

	if (Array.isArray(obj)) {
		return obj.some(containsUnresolved);
	}

	if (typeof obj === "object") {
		return Object.values(obj as Record<string, unknown>).some(containsUnresolved);
	}

	return false;
}

/** Find a resource by its ref ID (which is the path). */
function findResourceByRef(
	resources: ReadonlyMap<string, Resource>,
	refId: string,
): Resource | undefined {
	return resources.get(refId);
}
