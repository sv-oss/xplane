import { describe, expect, it } from "vitest";
import {
  createTrackedProxy,
  DependencyCollector,
  getTrackingMeta,
  isTracked,
  UNRESOLVED,
} from "../index.js";

describe("createTrackedProxy", () => {
  it("wraps an object and marks it as tracked", () => {
    const collector = new DependencyCollector();
    const target = { foo: "bar" };
    const proxy = createTrackedProxy(target, {
      owner: { id: "res-1" },
      path: "spec",
      observed: false,
      collector,
    });

    expect(isTracked(proxy)).toBe(true);
    expect(proxy.foo).toBe("bar");
  });

  it("records tracking metadata", () => {
    const collector = new DependencyCollector();
    const proxy = createTrackedProxy(
      {},
      {
        owner: { id: "res-1" },
        path: "spec",
        observed: false,
        collector,
      },
    );

    const meta = getTrackingMeta(proxy);
    expect(meta).toEqual({
      owner: { id: "res-1" },
      path: "spec",
      observed: false,
    });
  });

  it("wraps nested objects in tracked proxies", () => {
    const collector = new DependencyCollector();
    const target = { nested: { deep: "value" } };
    const proxy = createTrackedProxy(target, {
      owner: { id: "res-1" },
      path: "spec",
      observed: false,
      collector,
    });

    expect(isTracked(proxy.nested)).toBe(true);
    const meta = getTrackingMeta(proxy.nested);
    expect(meta?.path).toBe("spec.nested");
    expect(proxy.nested.deep).toBe("value");
  });

  it("returns nested proxy for missing keys on observed values", () => {
    const collector = new DependencyCollector();
    const proxy = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "vpc" },
      path: "status",
      observed: true,
      collector,
    });

    // Accessing a non-existent path on observed returns a tracked proxy
    const vpcId = (proxy as Record<string, { vpcId?: unknown }>)?.atProvider?.vpcId;
    expect(isTracked(vpcId)).toBe(true);

    const meta = getTrackingMeta(vpcId);
    expect(meta?.path).toBe("status.atProvider.vpcId");
    expect(meta?.owner.id).toBe("vpc");
    expect(meta?.observed).toBe(true);
  });

  it("records dependency edge on cross-resource assignment", () => {
    const collector = new DependencyCollector();

    // Source: observed VPC status
    const vpcStatus = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "vpc" },
      path: "status",
      observed: true,
      collector,
    });

    // Target: desired subnet spec
    const subnetSpec = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "subnet" },
      path: "spec",
      observed: false,
      collector,
    });

    // Assign VPC ID from vpc status to subnet spec
    const vpcId = (vpcStatus as Record<string, { vpcId?: unknown }>)?.atProvider?.vpcId;
    const subnetSpecRecord = subnetSpec as Record<string, unknown>;
    const existingForProvider = subnetSpecRecord.forProvider;
    const forProvider: Record<string, unknown> =
      typeof existingForProvider === "object" && existingForProvider !== null
        ? (existingForProvider as Record<string, unknown>)
        : {};
    subnetSpecRecord.forProvider = forProvider;
    forProvider.vpcId = vpcId;

    expect(collector.edges).toHaveLength(1);
    expect(collector.edges[0]).toEqual({
      from: { id: "vpc" },
      fromPath: "status.atProvider.vpcId",
      to: { id: "subnet" },
      toPath: "spec.forProvider.vpcId",
    });
  });

  it("resolves to UNRESOLVED for unresolved observed paths", () => {
    const collector = new DependencyCollector();

    const vpcStatus = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "vpc" },
      path: "status",
      observed: true,
      collector,
    });

    const subnetSpec = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "subnet" },
      path: "spec",
      observed: false,
      collector,
    });

    // Assign unresolved value
    const vpcId = (vpcStatus as Record<string, { vpcId?: unknown }>)?.atProvider?.vpcId;
    (subnetSpec as Record<string, unknown>).vpcId = vpcId;

    // The stored value should be UNRESOLVED
    expect((subnetSpec as Record<string, unknown>).vpcId).toBe(UNRESOLVED);
  });

  it("does not record edge for same-resource assignment", () => {
    const collector = new DependencyCollector();

    const spec = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "res-1" },
      path: "spec",
      observed: false,
      collector,
    });

    const status = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "res-1" },
      path: "status",
      observed: true,
      collector,
    });

    (spec as Record<string, unknown>).foo = (status as Record<string, unknown>).bar;

    expect(collector.edges).toHaveLength(0);
  });

  it("deduplicates edges", () => {
    const collector = new DependencyCollector();

    const vpcStatus = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "vpc" },
      path: "status",
      observed: true,
      collector,
    });

    const subnetSpec = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "subnet" },
      path: "spec",
      observed: false,
      collector,
    });

    const vpcId = (vpcStatus as Record<string, { vpcId?: unknown }>)?.atProvider?.vpcId;
    (subnetSpec as Record<string, unknown>).field1 = vpcId;

    // Assign the exact same source → target again
    const vpcId2 = (vpcStatus as Record<string, { vpcId?: unknown }>)?.atProvider?.vpcId;
    (subnetSpec as Record<string, unknown>).field1 = vpcId2;

    // Same edge (same from/to paths) should only be recorded once
    expect(collector.edges).toHaveLength(1);
  });

  it("records separate edges for different target paths", () => {
    const collector = new DependencyCollector();

    const vpcStatus = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "vpc" },
      path: "status",
      observed: true,
      collector,
    });

    const subnetSpec = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "subnet" },
      path: "spec",
      observed: false,
      collector,
    });

    const vpcId = (vpcStatus as Record<string, { vpcId?: unknown }>)?.atProvider?.vpcId;
    (subnetSpec as Record<string, unknown>).field1 = vpcId;
    (subnetSpec as Record<string, unknown>).field2 = vpcId;

    // Different target paths → different edges
    expect(collector.edges).toHaveLength(2);
  });

  it("resolves XR values immediately without creating edges", () => {
    const collector = new DependencyCollector();

    // Simulate XR proxy (owner id "__xr__")
    const xr = createTrackedProxy(
      { spec: { aws: { accountId: "12345" } } } as Record<string, unknown>,
      {
        owner: { id: "__xr__" },
        path: "",
        observed: true,
        collector,
      },
    );

    // Target resource
    const resSpec = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "res-1" },
      path: "spec",
      observed: false,
      collector,
    });

    // Assign XR value to resource
    const accountId = (xr as Record<string, { aws?: { accountId?: unknown } }>)?.spec?.aws
      ?.accountId;
    (resSpec as Record<string, unknown>).accountId = accountId;

    // Should NOT create a dependency edge for XR values
    expect(collector.edges).toHaveLength(0);

    // Should store the actual value, not UNRESOLVED
    expect((resSpec as Record<string, unknown>).accountId).toBe("12345");
  });

  it("resolves missing XR paths to undefined instead of UNRESOLVED", () => {
    const collector = new DependencyCollector();

    const xr = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "__xr__" },
      path: "",
      observed: true,
      collector,
    });

    const resSpec = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "res-1" },
      path: "spec",
      observed: false,
      collector,
    });

    // Access a non-existent XR path
    const missing = (xr as Record<string, { claimRef?: unknown }>)?.spec?.claimRef;
    (resSpec as Record<string, unknown>).name = missing;

    // Should NOT create a dependency edge
    expect(collector.edges).toHaveLength(0);

    // Should store undefined, not UNRESOLVED
    expect((resSpec as Record<string, unknown>).name).toBeUndefined();
  });

  it("throws clear error when XR placeholder is used in template literal", () => {
    const collector = new DependencyCollector();

    const xr = createTrackedProxy({} as Record<string, unknown>, {
      owner: { id: "__xr__" },
      path: "",
      observed: true,
      collector,
    });

    const missing = (xr as Record<string, { claimRef?: unknown }>)?.spec?.claimRef;

    expect(() => `${missing as unknown as string}`).toThrow(
      /Cannot coerce XR path.*the field does not exist/,
    );
  });
});
