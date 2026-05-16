import { Composition, Resource } from "@xplane/core";
import { describe, expect, it } from "vitest";
import { Match, Template } from "../index.js";

class SimpleComposition extends Composition {
  constructor() {
    super();
    new Resource(this, "vpc", {
      apiVersion: "ec2.aws.crossplane.io/v1beta1",
      kind: "VPC",
      metadata: { name: "my-vpc" },
      spec: { forProvider: { region: "us-east-1", cidrBlock: "10.0.0.0/16" } },
    });

    new Resource(this, "subnet", {
      apiVersion: "ec2.aws.crossplane.io/v1beta1",
      kind: "Subnet",
      metadata: { name: "my-subnet" },
      spec: { forProvider: { region: "us-east-1", cidrBlock: "10.0.1.0/24" } },
    });
  }
}

class CompositionWithConfigMap extends Composition {
  constructor() {
    super();
    new Resource(this, "config", {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "app-config", namespace: "default", labels: { app: "myapp" } },
      spec: { data: { key: "value" } },
    });
  }
}

describe("Template.synthesize", () => {
  it("creates a template from a composition class", () => {
    const template = Template.synthesize(SimpleComposition);
    expect(template.toJSON()).toHaveLength(2);
  });

  it("injects XR data", () => {
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

    const template = Template.synthesize(XRComposition, {
      xr: { spec: { region: "eu-west-1" } },
    });
    template.hasResourceSpec("ec2.aws.crossplane.io/v1beta1", "VPC", {
      forProvider: { region: "eu-west-1" },
    });
  });
});

describe("Template.fromComposition", () => {
  it("creates a template from an existing instance", () => {
    Composition._pendingXR = undefined;
    const comp = new SimpleComposition();
    const template = Template.fromComposition(comp);
    expect(template.toJSON()).toHaveLength(2);
  });
});

describe("Template.resourceCountIs", () => {
  it("passes when count matches", () => {
    const template = Template.synthesize(SimpleComposition);
    template.resourceCountIs("ec2.aws.crossplane.io/v1beta1", "VPC", 1);
    template.resourceCountIs("ec2.aws.crossplane.io/v1beta1", "Subnet", 1);
  });

  it("throws when count does not match", () => {
    const template = Template.synthesize(SimpleComposition);
    expect(() => {
      template.resourceCountIs("ec2.aws.crossplane.io/v1beta1", "VPC", 2);
    }).toThrow("Expected 2 resource(s)");
  });

  it("returns 0 for non-existent types", () => {
    const template = Template.synthesize(SimpleComposition);
    template.resourceCountIs("v1", "Secret", 0);
  });
});

describe("Template.hasResource", () => {
  it("passes when resource exists", () => {
    const template = Template.synthesize(SimpleComposition);
    template.hasResource("ec2.aws.crossplane.io/v1beta1", "VPC");
  });

  it("passes with matching props (deep-partial)", () => {
    const template = Template.synthesize(SimpleComposition);
    template.hasResource("ec2.aws.crossplane.io/v1beta1", "VPC", {
      metadata: { name: "my-vpc" },
    });
  });

  it("throws when no resource of that type exists", () => {
    const template = Template.synthesize(SimpleComposition);
    expect(() => {
      template.hasResource("v1", "Secret");
    }).toThrow("No resources found");
  });

  it("throws when props don't match", () => {
    const template = Template.synthesize(SimpleComposition);
    expect(() => {
      template.hasResource("ec2.aws.crossplane.io/v1beta1", "VPC", {
        metadata: { name: "nonexistent" },
      });
    }).toThrow("No resource of type");
  });
});

describe("Template.hasResourceSpec", () => {
  it("passes with matching spec props", () => {
    const template = Template.synthesize(SimpleComposition);
    template.hasResourceSpec("ec2.aws.crossplane.io/v1beta1", "VPC", {
      forProvider: { region: "us-east-1" },
    });
  });

  it("uses deep-partial matching", () => {
    const template = Template.synthesize(SimpleComposition);
    // Only check region, ignore cidrBlock
    template.hasResourceSpec("ec2.aws.crossplane.io/v1beta1", "VPC", {
      forProvider: { region: "us-east-1" },
    });
  });

  it("throws when spec doesn't match", () => {
    const template = Template.synthesize(SimpleComposition);
    expect(() => {
      template.hasResourceSpec("ec2.aws.crossplane.io/v1beta1", "VPC", {
        forProvider: { region: "ap-southeast-1" },
      });
    }).toThrow("No resource of type");
  });
});

describe("Template.hasResourceMetadata", () => {
  it("passes with matching metadata", () => {
    const template = Template.synthesize(CompositionWithConfigMap);
    template.hasResourceMetadata("v1", "ConfigMap", {
      labels: { app: "myapp" },
    });
  });

  it("throws when metadata doesn't match", () => {
    const template = Template.synthesize(CompositionWithConfigMap);
    expect(() => {
      template.hasResourceMetadata("v1", "ConfigMap", {
        labels: { app: "other" },
      });
    }).toThrow("No resource of type");
  });
});

describe("Template.allResources", () => {
  it("passes when all resources match", () => {
    const template = Template.synthesize(SimpleComposition);
    template.allResources("ec2.aws.crossplane.io/v1beta1", "VPC", {
      spec: { forProvider: { region: "us-east-1" } },
    });
  });

  it("throws when some resources don't match", () => {
    class MultiVPC extends Composition {
      constructor() {
        super();
        new Resource(this, "vpc1", {
          apiVersion: "ec2.aws.crossplane.io/v1beta1",
          kind: "VPC",
          spec: { forProvider: { region: "us-east-1" } },
        });
        new Resource(this, "vpc2", {
          apiVersion: "ec2.aws.crossplane.io/v1beta1",
          kind: "VPC",
          spec: { forProvider: { region: "eu-west-1" } },
        });
      }
    }

    const template = Template.synthesize(MultiVPC);
    expect(() => {
      template.allResources("ec2.aws.crossplane.io/v1beta1", "VPC", {
        spec: { forProvider: { region: "us-east-1" } },
      });
    }).toThrow("Not all resources");
  });
});

describe("Template.findResources", () => {
  it("returns matching resources", () => {
    const template = Template.synthesize(SimpleComposition);
    const found = template.findResources("ec2.aws.crossplane.io/v1beta1", "VPC");
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("VPC");
  });

  it("returns empty array for no matches", () => {
    const template = Template.synthesize(SimpleComposition);
    const found = template.findResources("v1", "Secret");
    expect(found).toHaveLength(0);
  });

  it("filters by props", () => {
    const template = Template.synthesize(SimpleComposition);
    const found = template.findResources("ec2.aws.crossplane.io/v1beta1", "Subnet", {
      spec: { forProvider: { cidrBlock: "10.0.1.0/24" } },
    });
    expect(found).toHaveLength(1);
  });
});

describe("Template.toJSON", () => {
  it("returns a snapshot-safe array", () => {
    const template = Template.synthesize(SimpleComposition);
    const json = template.toJSON();
    expect(json).toHaveLength(2);
    expect(json[0]).toHaveProperty("apiVersion");
    expect(json[0]).toHaveProperty("kind");
  });

  it("returns a deep clone (mutations don't affect template)", () => {
    const template = Template.synthesize(SimpleComposition);
    const json = template.toJSON();
    (json[0] as Record<string, unknown>).apiVersion = "mutated";
    const json2 = template.toJSON();
    expect(json2[0]!.apiVersion).toBe("ec2.aws.crossplane.io/v1beta1");
  });
});

describe("Template with Match matchers", () => {
  it("uses Match.objectLike in hasResourceSpec", () => {
    const template = Template.synthesize(SimpleComposition);
    template.hasResourceSpec("ec2.aws.crossplane.io/v1beta1", "VPC", {
      forProvider: Match.objectLike({ region: "us-east-1" }),
    });
  });

  it("uses Match.stringLikeRegexp in hasResource", () => {
    const template = Template.synthesize(SimpleComposition);
    template.hasResource("ec2.aws.crossplane.io/v1beta1", "VPC", {
      metadata: { name: Match.stringLikeRegexp("my-.*") },
    });
  });

  it("uses Match.anyValue", () => {
    const template = Template.synthesize(SimpleComposition);
    template.hasResourceSpec("ec2.aws.crossplane.io/v1beta1", "VPC", {
      forProvider: { region: Match.anyValue() },
    });
  });
});
