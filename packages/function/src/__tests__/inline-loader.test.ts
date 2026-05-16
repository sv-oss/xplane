import { Composition } from "@xplane/core";
import { describe, expect, it } from "vitest";
import { InlineLoader } from "../loader/inline.js";

describe("InlineLoader", () => {
  const loader = new InlineLoader();

  it("throws if input.composite is missing", () => {
    expect(() => loader.load({})).toThrow("input.composite must be a string");
  });

  it("throws if input.composite is not a string", () => {
    expect(() => loader.load({ composite: 42 })).toThrow("input.composite must be a string");
  });

  it("throws if input.composite is empty", () => {
    expect(() => loader.load({ composite: "  " })).toThrow("input.composite is empty");
  });

  it("throws if no 'composition' export is present", () => {
    expect(() => loader.load({ composite: "const x = 1;" })).toThrow(
      "must export a class named 'composition'",
    );
  });

  it("throws on syntax errors in user code", () => {
    expect(() => loader.load({ composite: "class { broken" })).toThrow(
      "failed to evaluate composition code",
    );
  });

  it("loads a valid composition class", () => {
    const code = `
			class MyComposition extends Composition {
				constructor() {
					super();
					new Resource(this, 'vpc', {
						apiVersion: 'ec2.aws.upbound.io/v1beta1',
						kind: 'VPC',
						spec: { forProvider: { cidrBlock: '10.0.0.0/16' } },
					});
				}
			}
			exports.composition = MyComposition;
		`;

    const CompositionClass = loader.load({ composite: code });
    expect(CompositionClass).toBeDefined();
    expect(typeof CompositionClass).toBe("function");

    // Actually instantiate — resources created in constructor
    const instance = new CompositionClass();
    expect(instance.resources.size).toBe(1);
    expect(instance.resources.has("vpc")).toBe(true);
  });

  it("provides standard globals to user code", () => {
    const code = `
			class TestGlobals extends Composition {
				constructor() {
					super();
					const encoded = btoa("hello");
					const decoded = atob(encoded);
					const url = new URL("https://example.com");
					const map = new Map();
					const set = new Set();

					new Resource(this, 'test', {
						apiVersion: 'v1',
						kind: 'ConfigMap',
						spec: { data: { encoded, decoded, host: url.host } },
					});
				}
			}
			exports.composition = TestGlobals;
		`;

    const C = loader.load({ composite: code });
    const inst = new C();
    expect(inst.resources.size).toBe(1);
  });

  it("supports cross-resource dependency detection", () => {
    const code = `
			class CrossDep extends Composition {
				constructor() {
					super();
					const vpc = new Resource(this, 'vpc', {
						apiVersion: 'ec2.aws.upbound.io/v1beta1',
						kind: 'VPC',
					});
					const subnet = new Resource(this, 'subnet', {
						apiVersion: 'ec2.aws.upbound.io/v1beta1',
						kind: 'Subnet',
						spec: { forProvider: {} },
					});
					subnet.spec.forProvider.vpcId = vpc.status.atProvider.vpcId;
				}
			}
			exports.composition = CrossDep;
		`;

    const C = loader.load({ composite: code });
    const inst = new C();

    // Should have recorded a dependency edge: vpc (read) → subnet (write)
    expect(inst.collector.edges.length).toBeGreaterThanOrEqual(1);
    const edge = inst.collector.edges[0];
    expect(edge?.from.id).toBe("vpc");
    expect(edge?.to.id).toBe("subnet");
  });

  it("supports reading XR values", () => {
    const code = `
			class XrRead extends Composition {
				constructor() {
					super();
					new Resource(this, 'vpc', {
						apiVersion: 'ec2.aws.upbound.io/v1beta1',
						kind: 'VPC',
						spec: { forProvider: { cidrBlock: this.xr.spec?.cidrBlock } },
					});
				}
			}
			exports.composition = XrRead;
		`;

    const C = loader.load({ composite: code });
    Composition._pendingXR = { spec: { cidrBlock: "10.0.0.0/16" } };
    const inst = new C();

    const vpc = inst.resources.get("vpc");
    expect(vpc).toBeDefined();
    if (!vpc) {
      throw new Error("Expected vpc resource to be defined");
    }
    const desired = vpc.toDesired();
    expect(desired.spec?.forProvider).toEqual({ cidrBlock: "10.0.0.0/16" });
  });
});
