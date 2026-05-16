import type { Composition, KubernetesResource } from "@xplane/core";
import { deepPartialMatch } from "./match.js";

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
 *
 * @example
 * ```ts
 * const template = Template.synthesize(MyComposition, {
 *   xr: { spec: { region: 'us-east-1' } },
 * });
 * template.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'VPC', {
 *   forProvider: { region: 'us-east-1' },
 * });
 * ```
 */
export class Template {
  private readonly _resources: KubernetesResource[];

  private constructor(resources: KubernetesResource[]) {
    this._resources = resources;
  }

  /**
   * Ergonomic factory: injects XR/environment data and instantiates
   * the Composition class, then builds a Template from the rendered resources.
   *
   * Users never need to touch `Composition._pendingXR` directly.
   */
  static synthesize(Ctor: new () => Composition, options: SynthesizeOptions = {}): Template {
    // Walk up prototype chain to find the base Composition class with _pendingXR
    let base = Ctor as unknown as Record<string, unknown>;
    while (base && !Object.hasOwn(base, "_pendingXR")) {
      base = Object.getPrototypeOf(base) as Record<string, unknown>;
    }
    if (!base) {
      throw new Error("Could not find Composition base class with _pendingXR");
    }

    const BaseComposition = base as unknown as {
      _pendingXR: Record<string, unknown> | undefined;
      _pendingEnvironment: Record<string, unknown> | undefined;
    };

    BaseComposition._pendingXR = options.xr;
    BaseComposition._pendingEnvironment = options.environment;
    try {
      const instance = new Ctor();
      return Template.fromComposition(instance);
    } finally {
      BaseComposition._pendingXR = undefined;
      BaseComposition._pendingEnvironment = undefined;
    }
  }

  /**
   * Build a Template from an already-instantiated Composition.
   */
  static fromComposition(composition: Composition): Template {
    const resources = [
      ...(
        composition as unknown as {
          resources: ReadonlyMap<string, { toDesired(): KubernetesResource }>;
        }
      ).resources.values(),
    ].map((r) => r.toDesired());
    return new Template(resources);
  }

  /**
   * Build a Template from a pre-built array of KubernetesResource objects.
   * Used internally by Simulator.
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
        `  Resource: ${JSON.stringify(resource.metadata?.name ?? "(unnamed)")}\n    ${result.failures.join("\n    ")}`,
      );
    }
    throw new Error(
      `No resource of type ${apiVersion}/${kind} matches the expected properties:\n${allFailures.join("\n")}`,
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
        `  Resource: ${JSON.stringify(resource.metadata?.name ?? "(unnamed)")}\n    ${result.failures.join("\n    ")}`,
      );
    }
    throw new Error(
      `No resource of type ${apiVersion}/${kind} has spec matching the expected properties:\n${allFailures.join("\n")}`,
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
        `  Resource: ${JSON.stringify(resource.metadata?.name ?? "(unnamed)")}\n    ${result.failures.join("\n    ")}`,
      );
    }
    throw new Error(
      `No resource of type ${apiVersion}/${kind} has metadata matching the expected properties:\n${allFailures.join("\n")}`,
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
          `  Resource: ${JSON.stringify(resource.metadata?.name ?? "(unnamed)")}\n    ${result.failures.join("\n    ")}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Not all resources of type ${apiVersion}/${kind} match:\n${failures.join("\n")}`,
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
