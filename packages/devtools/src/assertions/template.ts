import {
  type Composition,
  type CompositionContext,
  compositionStorage,
  createTokenRegistry,
  DependencyGraph,
  EdgeCollector,
  getDesiredDocument,
  isExternal,
  type KubernetesResource,
  Pending,
  PendingTemplate,
  Resource,
  tokenRegistryStorage,
} from '@xplane/core';
import { deepPartialMatch } from './match.js';

/** Options for `Template.synthesize()`. */
export interface SynthesizeOptions {
  /** XR (composite resource) data to inject before instantiation. */
  xr?: Record<string, unknown>;
  /** Environment data to inject before instantiation. */
  environment?: Record<string, unknown>;
}

/**
 * A snapshot of rendered resources from a Composition, providing
 * assertion methods for unit testing.
 */
export class Template {
  private readonly _resources: KubernetesResource[];

  private constructor(resources: KubernetesResource[]) {
    this._resources = resources;
  }

  /**
   * Instantiate a Composition and run the full pipeline to produce a Template.
   *
   * Includes ALL declared resources (both emitted and blocked) — Pending
   * dependency values are stripped to `undefined`. Use `Simulator` if you
   * need to distinguish emitted vs blocked.
   */
  static synthesize<TSpec, TStatus, TContext extends object>(
    Ctor: new () => Composition<TSpec, TStatus, TContext>,
    options: SynthesizeOptions = {},
  ): Template {
    const xr: Record<string, unknown> = options.xr ?? { spec: {}, status: {} };
    const pipelineContext = new Map<string, unknown>();
    if (options.environment) {
      pipelineContext.set('apiextensions.crossplane.io/environment', options.environment);
    }

    const graph = new DependencyGraph();
    const collector = new EdgeCollector();
    const ctx: CompositionContext = {
      xr,
      pipelineContext,
      requiredResources: new Map(),
      observedComposed: new Map(),
      graph,
      collector,
    };

    const composition = compositionStorage.run(ctx, () =>
      tokenRegistryStorage.run(createTokenRegistry(), () => new Ctor()),
    ) as Composition;
    return Template.fromComposition(composition);
  }

  /**
   * Build a Template from an already-instantiated Composition.
   *
   * Extracts desired documents from ALL non-external resources. Unresolved
   * Pending markers are serialized as `PendingValue` objects — use
   * `Match.pending()` to assert them in tests.
   */
  static fromComposition(composition: Composition): Template {
    const resources = composition.node
      .findAll()
      .filter((c): c is Resource => c instanceof Resource && !isExternal(c as Resource));

    const docs = resources.map(
      (r) => serializePending(getDesiredDocument(r)) as KubernetesResource,
    );
    return new Template(docs);
  }

  /**
   * Build a Template from a pre-built array of resource documents.
   */
  static fromResources(resources: KubernetesResource[]): Template {
    return new Template(resources);
  }

  /** Get all resources matching apiVersion + kind. */
  private _filterByGVK(apiVersion: string, kind: string): KubernetesResource[] {
    return this._resources.filter((r) => r.apiVersion === apiVersion && r.kind === kind);
  }

  /**
   * Assert the number of resources with the given apiVersion and kind.
   */
  resourceCountIs(apiVersion: string, kind: string, count: number): void {
    const matched = this._filterByGVK(apiVersion, kind);
    if (matched.length !== count) {
      throw new Error(
        `Expected ${count} resource(s) of type ${apiVersion}/${kind}, found ${matched.length}`,
      );
    }
  }

  /**
   * Assert that at least one resource of the given type matches the expected properties.
   * Uses deep-partial matching by default (actual can be a superset of expected).
   */
  hasResource(apiVersion: string, kind: string, props?: object): void {
    const matched = this._filterByGVK(apiVersion, kind);
    if (matched.length === 0) {
      throw new Error(`No resources found with type ${apiVersion}/${kind}`);
    }

    if (!props) return; // Just checking existence

    const allFailures: string[] = [];
    for (const resource of matched) {
      const result = deepPartialMatch(resource, props);
      if (result.pass) return; // At least one matches
      allFailures.push(
        `  Resource: ${JSON.stringify(resource.metadata?.name ?? '(unnamed)')}\n    ${result.failures.join('\n    ')}`,
      );
    }
    throw new Error(
      `No resource of type ${apiVersion}/${kind} matches the expected properties:\n${allFailures.join('\n')}`,
    );
  }

  /**
   * Assert that at least one resource of the given type has a spec matching the expected properties.
   * Shorthand for matching against the `spec` field only.
   */
  hasResourceSpec(apiVersion: string, kind: string, specProps: object): void {
    const matched = this._filterByGVK(apiVersion, kind);
    if (matched.length === 0) {
      throw new Error(`No resources found with type ${apiVersion}/${kind}`);
    }

    const allFailures: string[] = [];
    for (const resource of matched) {
      const result = deepPartialMatch(resource.spec ?? {}, specProps);
      if (result.pass) return;
      allFailures.push(
        `  Resource: ${JSON.stringify(resource.metadata?.name ?? '(unnamed)')}\n    ${result.failures.join('\n    ')}`,
      );
    }
    throw new Error(
      `No resource of type ${apiVersion}/${kind} has spec matching the expected properties:\n${allFailures.join('\n')}`,
    );
  }

  /**
   * Assert that at least one resource of the given type has metadata matching the expected properties.
   */
  hasResourceMetadata(apiVersion: string, kind: string, metaProps: object): void {
    const matched = this._filterByGVK(apiVersion, kind);
    if (matched.length === 0) {
      throw new Error(`No resources found with type ${apiVersion}/${kind}`);
    }

    const allFailures: string[] = [];
    for (const resource of matched) {
      const result = deepPartialMatch(resource.metadata ?? {}, metaProps);
      if (result.pass) return;
      allFailures.push(
        `  Resource: ${JSON.stringify(resource.metadata?.name ?? '(unnamed)')}\n    ${result.failures.join('\n    ')}`,
      );
    }
    throw new Error(
      `No resource of type ${apiVersion}/${kind} has metadata matching the expected properties:\n${allFailures.join('\n')}`,
    );
  }

  /**
   * Assert that ALL resources of the given type match the expected properties.
   */
  allResources(apiVersion: string, kind: string, props: object): void {
    const matched = this._filterByGVK(apiVersion, kind);
    if (matched.length === 0) {
      throw new Error(`No resources found with type ${apiVersion}/${kind}`);
    }

    const failures: string[] = [];
    for (const resource of matched) {
      const result = deepPartialMatch(resource, props);
      if (!result.pass) {
        failures.push(
          `  Resource: ${JSON.stringify(resource.metadata?.name ?? '(unnamed)')}\n    ${result.failures.join('\n    ')}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Not all resources of type ${apiVersion}/${kind} match:\n${failures.join('\n')}`,
      );
    }
  }

  /**
   * Find all resources of the given type that match the expected properties.
   * Returns matches — never throws.
   */
  findResources(apiVersion: string, kind: string, props?: object): KubernetesResource[] {
    const matched = this._filterByGVK(apiVersion, kind);
    if (!props) return matched;

    return matched.filter((resource) => {
      const result = deepPartialMatch(resource, props);
      return result.pass;
    });
  }

  /**
   * Serialize all resources to a JSON-compatible array for snapshot testing.
   *
   * @example
   * ```ts
   * expect(template.toJSON()).toMatchSnapshot();
   * ```
   */
  toJSON(): KubernetesResource[] {
    return structuredClone(this._resources);
  }
}

// ─── Pending Serialization ────────────────────────────────────────────────────

/** Symbol tag used to identify serialized PendingValue objects. */
export const PENDING_VALUE = Symbol.for('xplane.devtools.pending');

/** Serialized form of a Pending marker in Template resource documents. */
export interface PendingValue {
  readonly [PENDING_VALUE]: true;
  /** The resource this value is waiting on. */
  readonly source: string;
  /** The path within that resource's observed data. */
  readonly path: string;
}

/** Type guard for PendingValue. */
export function isPendingValue(value: unknown): value is PendingValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[PENDING_VALUE] === true
  );
}

/**
 * Deep-clone a desired document, converting Pending instances into
 * serialized PendingValue objects that matchers can assert against.
 */
function serializePending(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = serializeValue(value);
  }
  return result;
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Pending.is(value)) {
    return {
      [PENDING_VALUE]: true,
      source: value.source.id,
      path: value.path,
    } satisfies PendingValue;
  }

  if (PendingTemplate.is(value)) {
    // Represent as a pending value with a compound source description
    return {
      [PENDING_VALUE]: true,
      source: value.slots.map((s) => s.source.id).join(','),
      path: value.slots.map((s) => s.path).join(','),
    } satisfies PendingValue;
  }

  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = serializeValue(val);
  }
  return result;
}
