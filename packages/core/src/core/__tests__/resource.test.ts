import { Construct } from "constructs";
import { describe, expect, it } from "vitest";
import { Composition, Resource } from "../index.js";

describe("Resource", () => {
	it("creates a resource with apiVersion and kind", () => {
		const comp = new Composition();
		const resource = new Resource(comp, "my-vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
			spec: { forProvider: { region: "us-east-1", cidrBlock: "10.0.0.0/16" } },
		});

		expect(resource.apiVersion).toBe("ec2.aws.upbound.io/v1beta1");
		expect(resource.kind).toBe("VPC");
		expect(resource.path).toBe("my-vpc");
	});

	it("serializes to desired state", () => {
		const comp = new Composition();
		const resource = new Resource(comp, "my-vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
			spec: { forProvider: { region: "us-east-1" } },
		});

		const desired = resource.toDesired();
		expect(desired.apiVersion).toBe("ec2.aws.upbound.io/v1beta1");
		expect(desired.kind).toBe("VPC");
		expect(desired.spec).toEqual({ forProvider: { region: "us-east-1" } });
	});

	it("tracks cross-resource dependencies via proxy assignment", () => {
		const comp = new Composition();

		const vpc = new Resource(comp, "vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
			spec: { forProvider: { cidrBlock: "10.0.0.0/16" } },
		});

		const subnet = new Resource(comp, "subnet", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "Subnet",
			spec: { forProvider: {} },
		});

		// Assign VPC ID from vpc status → subnet spec (tracked via proxy)
		const vpcId = (vpc.status as Record<string, Record<string, unknown>>).atProvider!.vpcId;
		(subnet.spec as Record<string, Record<string, unknown>>).forProvider!.vpcId = vpcId;

		// Should have recorded a dependency edge
		expect(comp.collector.edges).toHaveLength(1);
		expect(comp.collector.edges[0]?.from.id).toBe("vpc");
		expect(comp.collector.edges[0]?.to.id).toBe("subnet");
	});

	it("supports explicit dependencies", () => {
		const comp = new Composition();

		const vpc = new Resource(comp, "vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});

		const subnet = new Resource(comp, "subnet", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "Subnet",
		});

		subnet.addDependency(vpc);

		const deps = comp.graph.getDependencies("subnet");
		expect(deps.has("vpc")).toBe(true);
	});

	it("only emits user-declared metadata in desired output, not observed state", () => {
		const comp = new Composition();
		const resource = new Resource(comp, "my-vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
			metadata: { name: "my-vpc", labels: { app: "test" } },
			spec: { forProvider: { region: "us-east-1" } },
		});

		// Simulate observed state with many extra fields
		resource.setObserved({
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
			metadata: {
				name: "my-vpc",
				uid: "abc-123-def",
				resourceVersion: "12345",
				generation: 3,
				creationTimestamp: "2026-05-15T00:00:00Z",
				managedFields: [{ manager: "crossplane" }],
				ownerReferences: [{ uid: "owner-uid" }],
				labels: { app: "test", extra: "from-observed" },
				annotations: { "crossplane.io/external-name": "my-vpc" },
			},
			spec: { forProvider: { region: "us-east-1" } },
		});

		const desired = resource.toDesired();

		// Should only emit the keys the user declared: name and labels
		expect(desired.metadata?.name).toBe("my-vpc");
		// labels value reflects what's in the backing object (observed merged in),
		// but the key itself was user-declared so it's emitted
		expect(desired.metadata?.labels).toBeDefined();

		// Should NOT emit observed-only fields — function must only return its intent
		const meta = desired.metadata as Record<string, unknown>;
		expect(meta.uid).toBeUndefined();
		expect(meta.resourceVersion).toBeUndefined();
		expect(meta.generation).toBeUndefined();
		expect(meta.creationTimestamp).toBeUndefined();
		expect(meta.managedFields).toBeUndefined();
		expect(meta.ownerReferences).toBeUndefined();
		expect(meta.annotations).toBeUndefined();
	});

	it("emits no metadata when none was declared by user", () => {
		const comp = new Composition();
		const resource = new Resource(comp, "my-vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
			spec: { forProvider: { region: "us-east-1" } },
		});

		resource.setObserved({
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
			metadata: {
				name: "my-vpc",
				uid: "abc-123",
				labels: { "crossplane.io/composite": "my-xr" },
			},
		});

		const desired = resource.toDesired();
		// No metadata keys were declared by user, so metadata should be empty
		expect(desired.metadata).toEqual({});
	});
});

describe("Resource.uniqueName", () => {
	it("always appends an 8-char hash suffix", () => {
		const comp = new Composition();
		const child = new Resource(comp, "VPCOrigin", {
			apiVersion: "cloudfront.aws.upbound.io/v1beta1",
			kind: "OriginAccessControl",
		});
		expect(Resource.uniqueName(child)).toMatch(/^VPCOrigin-[0-9a-f]{8}$/);
	});

	it("prepends XR name from pending XR metadata", () => {
		Composition._pendingXR = { metadata: { name: "example" } };
		const comp = new Composition();
		const child = new Resource(comp, "VPCOrigin", {
			apiVersion: "cloudfront.aws.upbound.io/v1beta1",
			kind: "OriginAccessControl",
		});
		expect(Resource.uniqueName(child)).toMatch(/^example-VPCOrigin-[0-9a-f]{8}$/);
	});

	it("prepends namespace and XR name when both present", () => {
		Composition._pendingXR = { metadata: { name: "example", namespace: "my-ns" } };
		const comp = new Composition();
		const child = new Resource(comp, "VPC", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});
		expect(Resource.uniqueName(child)).toMatch(/^my-ns-example-VPC-[0-9a-f]{8}$/);
	});

	it("strips whitespace from each segment (CDK convention)", () => {
		const comp = new Composition();
		const child = new Resource(comp, "VPC Origin", {
			apiVersion: "cloudfront.aws.upbound.io/v1beta1",
			kind: "OriginAccessControl",
		});
		// "VPC Origin" → "VPCOrigin" (whitespace stripped per segment)
		expect(Resource.uniqueName(child)).toMatch(/^VPCOrigin-[0-9a-f]{8}$/);
	});

	it("joins nested construct path, stripping whitespace per segment", () => {
		const comp = new Composition();
		const parent = new Construct(comp, "VPC Origin Sharing");
		const child = new Resource(parent, "Share", {
			apiVersion: "ram.aws.upbound.io/v1beta1",
			kind: "ResourceShare",
		});
		expect(Resource.uniqueName(child)).toMatch(/^VPCOriginSharing-Share-[0-9a-f]{8}$/);
	});

	it("appends extra option before the hash", () => {
		const comp = new Composition();
		const child = new Resource(comp, "VPC", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});
		const name = Resource.uniqueName(child, { extra: "shared" });
		expect(name).toMatch(/^VPC-shared-[0-9a-f]{8}$/);
	});

	it("replaces disallowed chars with separator and collapses consecutive separators", () => {
		const comp = new Composition();
		const child = new Resource(comp, "my_resource_name", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});
		expect(Resource.uniqueName(child, { allowedPattern: /[^a-zA-Z0-9-]/g })).toMatch(
			/^my-resource-name-[0-9a-f]{8}$/,
		);
	});

	it("truncates long names while preserving hash suffix", () => {
		const comp = new Composition();
		const longId = "a".repeat(80);
		const child = new Resource(comp, longId, {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});
		const name = Resource.uniqueName(child, { maxLength: 20 });
		expect(name.length).toBeLessThanOrEqual(20);
		expect(name).toMatch(/-[0-9a-f]{8}$/);
	});

	it("two-character determinism: same path → same hash", () => {
		const comp1 = new Composition();
		const child1 = new Resource(comp1, "vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});
		const comp2 = new Composition();
		const child2 = new Resource(comp2, "vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});
		expect(Resource.uniqueName(child1)).toBe(Resource.uniqueName(child2));
	});
});

describe("Composition.of", () => {
	it("returns the root Composition from a direct child", () => {
		const comp = new Composition();
		const child = new Resource(comp, "vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});
		expect(Composition.of(child)).toBe(comp);
	});

	it("returns the root Composition from a deeply nested construct", () => {
		const comp = new Composition();
		const mid = new Construct(comp, "mid");
		const child = new Resource(mid, "vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});
		expect(Composition.of(child)).toBe(comp);
	});

	it("throws when no Composition is in scope chain", () => {
		const orphan = new Construct(undefined as unknown as Construct, "orphan");
		expect(() => Composition.of(orphan)).toThrow(/No Composition found/);
	});
});

describe("Composition", () => {
	it("provides proxy-wrapped XR", () => {
		Composition._pendingXR = { spec: { region: "us-east-1", clusterName: "test" } };
		const comp = new Composition();

		expect((comp.xr as Record<string, Record<string, unknown>>).spec!.region).toBe("us-east-1");
	});

	it("prevents duplicate construct IDs under same scope", () => {
		const comp = new Composition();
		new Resource(comp, "vpc", {
			apiVersion: "ec2.aws.upbound.io/v1beta1",
			kind: "VPC",
		});

		expect(
			() =>
				new Resource(comp, "vpc", {
					apiVersion: "ec2.aws.upbound.io/v1beta1",
					kind: "VPC",
				}),
		).toThrow(/There is already a Construct with name/);
	});
});
