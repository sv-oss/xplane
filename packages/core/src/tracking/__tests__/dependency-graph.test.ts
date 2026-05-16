import { describe, expect, it } from "vitest";
import { DependencyGraph } from "../dependency-graph.js";

describe("DependencyGraph", () => {
  it("topologically sorts independent resources", () => {
    const graph = new DependencyGraph();
    graph.addResource({ id: "a" });
    graph.addResource({ id: "b" });
    graph.addResource({ id: "c" });

    const sorted = graph.topologicalSort();
    expect(sorted).toHaveLength(3);
    expect(sorted).toContain("a");
    expect(sorted).toContain("b");
    expect(sorted).toContain("c");
  });

  it("sorts dependencies before dependents", () => {
    const graph = new DependencyGraph();
    graph.addResource({ id: "vpc" });
    graph.addResource({ id: "subnet" });
    graph.addExplicitDependency({ id: "subnet" }, { id: "vpc" });

    const sorted = graph.topologicalSort();
    expect(sorted.indexOf("vpc")).toBeLessThan(sorted.indexOf("subnet"));
  });

  it("handles diamond dependencies", () => {
    const graph = new DependencyGraph();
    graph.addResource({ id: "a" });
    graph.addResource({ id: "b" });
    graph.addResource({ id: "c" });
    graph.addResource({ id: "d" });

    // d depends on b and c, both depend on a
    graph.addExplicitDependency({ id: "b" }, { id: "a" });
    graph.addExplicitDependency({ id: "c" }, { id: "a" });
    graph.addExplicitDependency({ id: "d" }, { id: "b" });
    graph.addExplicitDependency({ id: "d" }, { id: "c" });

    const sorted = graph.topologicalSort();
    expect(sorted.indexOf("a")).toBeLessThan(sorted.indexOf("b"));
    expect(sorted.indexOf("a")).toBeLessThan(sorted.indexOf("c"));
    expect(sorted.indexOf("b")).toBeLessThan(sorted.indexOf("d"));
    expect(sorted.indexOf("c")).toBeLessThan(sorted.indexOf("d"));
  });

  it("detects cycles", () => {
    const graph = new DependencyGraph();
    graph.addResource({ id: "a" });
    graph.addResource({ id: "b" });
    graph.addExplicitDependency({ id: "a" }, { id: "b" });
    graph.addExplicitDependency({ id: "b" }, { id: "a" });

    expect(() => graph.topologicalSort()).toThrow(/cycle/i);
  });

  it("adds edges from collector format", () => {
    const graph = new DependencyGraph();
    graph.addEdges([
      {
        from: { id: "vpc" },
        fromPath: "status.atProvider.vpcId",
        to: { id: "subnet" },
        toPath: "spec.forProvider.vpcId",
      },
    ]);

    const deps = graph.getDependencies("subnet");
    expect(deps.has("vpc")).toBe(true);

    const sorted = graph.topologicalSort();
    expect(sorted.indexOf("vpc")).toBeLessThan(sorted.indexOf("subnet"));
  });
});
