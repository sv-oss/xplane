import { Composition, Resource } from "@xplane/core";
import { describe, expect, it } from "vitest";
import { Simulator } from "../index.js";

class VPCSubnetComposition extends Composition {
  constructor() {
    super();
    const vpc = new Resource(this, "vpc", {
      apiVersion: "ec2.aws.crossplane.io/v1beta1",
      kind: "VPC",
      metadata: { name: "my-vpc" },
      spec: { forProvider: { region: "us-east-1", cidrBlock: "10.0.0.0/16" } },
    });

    const subnet = new Resource(this, "subnet", {
      apiVersion: "ec2.aws.crossplane.io/v1beta1",
      kind: "Subnet",
      metadata: { name: "my-subnet" },
      spec: { forProvider: { region: "us-east-1", cidrBlock: "10.0.1.0/24" } },
    });

    // Create dependency: subnet depends on vpc's vpcId
    subnet.spec.forProvider.vpcId = vpc.status.atProvider.vpcId;
  }
}

describe("Simulator.synthesize", () => {
  it("creates a simulator instance", () => {
    const sim = Simulator.synthesize(VPCSubnetComposition);
    expect(sim).toBeInstanceOf(Simulator);
  });
});

describe("Simulator.run", () => {
  it("blocks resources with unresolved dependencies", () => {
    const result = Simulator.synthesize(VPCSubnetComposition)
      .withObserved([]) // No observed state
      .run();

    // VPC has no deps, subnet depends on VPC
    result.emitted.resourceCountIs("ec2.aws.crossplane.io/v1beta1", "VPC", 1);
    result.blocked.resourceCountIs("ec2.aws.crossplane.io/v1beta1", "Subnet", 1);
  });

  it("emits resources when dependencies are satisfied", () => {
    const result = Simulator.synthesize(VPCSubnetComposition)
      .withObserved([
        {
          apiVersion: "ec2.aws.crossplane.io/v1beta1",
          kind: "VPC",
          metadata: { name: "vpc" },
          status: { atProvider: { vpcId: "vpc-123" } },
        },
      ])
      .run();

    result.emitted.resourceCountIs("ec2.aws.crossplane.io/v1beta1", "VPC", 1);
    result.emitted.resourceCountIs("ec2.aws.crossplane.io/v1beta1", "Subnet", 1);

    // Verify the resolved value was injected
    result.emitted.hasResourceSpec("ec2.aws.crossplane.io/v1beta1", "Subnet", {
      forProvider: { vpcId: "vpc-123" },
    });
  });

  it("injects XR data via synthesize options", () => {
    class XRComposition extends Composition {
      constructor() {
        super();
        new Resource(this, "vpc", {
          apiVersion: "ec2.aws.crossplane.io/v1beta1",
          kind: "VPC",
          spec: { forProvider: { region: (this.xr as { spec: { region: string } }).spec.region } },
        });
      }
    }

    const result = Simulator.synthesize(XRComposition, {
      xr: { spec: { region: "eu-west-1" } },
    })
      .withObserved([])
      .run();

    result.emitted.hasResourceSpec("ec2.aws.crossplane.io/v1beta1", "VPC", {
      forProvider: { region: "eu-west-1" },
    });
  });
});

describe("Simulator.fromComposition", () => {
  it("accepts a pre-built composition instance", () => {
    Composition._pendingXR = undefined;
    const comp = new VPCSubnetComposition();
    const sim = Simulator.fromComposition(comp);
    const result = sim.withObserved([]).run();

    result.emitted.resourceCountIs("ec2.aws.crossplane.io/v1beta1", "VPC", 1);
    result.blocked.resourceCountIs("ec2.aws.crossplane.io/v1beta1", "Subnet", 1);
  });
});
