import { Composition } from "@xplane/core";
import { describe, expect, it } from "vitest";
import { InlineLoader } from "../loader/inline.js";

describe("InlineLoader", () => {
  const loader = new InlineLoader();

  it("throws if input.spec is missing", async () => {
    await expect(loader.load({})).rejects.toThrow("input.spec must be an object");
  });

  it("throws if input.spec.code is not a string", async () => {
    await expect(loader.load({ spec: { code: 42 } })).rejects.toThrow(
      "input.spec.code must be a string",
    );
  });

  it("throws if input.spec.code is empty", async () => {
    await expect(loader.load({ spec: { code: "  " } })).rejects.toThrow("input.spec.code is empty");
  });

  it("throws if no 'composition' export is present", async () => {
    await expect(loader.load({ spec: { code: "const x = 1;" } })).rejects.toThrow(
      "must export a class named 'composition'",
    );
  });

  it("throws on syntax errors in user code", async () => {
    await expect(loader.load({ spec: { code: "class { broken" } })).rejects.toThrow(
      "Failed to evaluate composition code",
    );
  });

  it("loads a valid composition class", async () => {
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

    const CompositionClass = await loader.load({ spec: { code } });
    expect(CompositionClass).toBeDefined();
    expect(typeof CompositionClass).toBe("function");

    // Actually instantiate — resources created in constructor
    const instance = new CompositionClass();
    expect(instance.resources.size).toBe(1);
    expect(instance.resources.has("vpc")).toBe(true);
  });

  it("provides standard globals to user code", async () => {
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

    const C = await loader.load({ spec: { code } });
    const inst = new C();
    expect(inst.resources.size).toBe(1);
  });

  it("supports cross-resource dependency detection", async () => {
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

    const C = await loader.load({ spec: { code } });
    const inst = new C();

    // Should have recorded a dependency edge: vpc (read) → subnet (write)
    expect(inst.collector.edges.length).toBeGreaterThanOrEqual(1);
    const edge = inst.collector.edges[0];
    expect(edge?.from.id).toBe("vpc");
    expect(edge?.to.id).toBe("subnet");
  });

  it("supports reading XR values", async () => {
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

    const C = await loader.load({ spec: { code } });
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
