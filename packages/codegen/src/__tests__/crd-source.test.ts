import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CrdSource } from "../sources/crd.js";

function writeCrd(dir: string, filename: string, content: string): string {
  const path = join(dir, filename);
  writeFileSync(path, content, "utf-8");
  return path;
}

const crossplaneCrd = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: vpcs.ec2.aws.upbound.io
spec:
  group: ec2.aws.upbound.io
  names:
    kind: VPC
    plural: vpcs
  versions:
    - name: v1beta1
      served: true
      schema:
        openAPIV3Schema:
          description: A VPC resource.
          type: object
          properties:
            spec:
              type: object
              properties:
                forProvider:
                  type: object
                  required: [region]
                  properties:
                    region:
                      type: string
                      description: AWS region
                    cidrBlock:
                      type: string
                    tags:
                      type: object
                      additionalProperties:
                        type: string
            status:
              type: object
              properties:
                atProvider:
                  type: object
                  properties:
                    id:
                      type: string
                    arn:
                      type: string
`;

const standardCrd = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.example.com
spec:
  group: example.com
  names:
    kind: Widget
    plural: widgets
  versions:
    - name: v1
      served: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                size:
                  type: integer
                color:
                  type: string
                  enum: [red, green, blue]
            status:
              type: object
              properties:
                phase:
                  type: string
`;

describe("CrdSource", () => {
  it("parses a Crossplane CRD with forProvider/atProvider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-test-"));
    writeCrd(dir, "vpc.yaml", crossplaneCrd);

    const source = new CrdSource([dir]);
    const defs = await source.load();

    expect(defs).toHaveLength(1);
    const vpc = defs[0]!;
    expect(vpc.group).toBe("ec2.aws.upbound.io");
    expect(vpc.version).toBe("v1beta1");
    expect(vpc.kind).toBe("VPC");
    expect(vpc.plural).toBe("vpcs");
    expect(vpc.description).toBe("A VPC resource.");
    expect(vpc.specSchema?.properties?.region).toEqual({
      type: "string",
      description: "AWS region",
    });
    expect(vpc.statusSchema?.properties?.id).toEqual({ type: "string" });
  });

  it("parses a standard CRD without forProvider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-test-"));
    writeCrd(dir, "widget.yaml", standardCrd);

    const source = new CrdSource([dir]);
    const defs = await source.load();

    expect(defs).toHaveLength(1);
    const widget = defs[0]!;
    expect(widget.group).toBe("example.com");
    expect(widget.kind).toBe("Widget");
    expect(widget.specSchema?.properties?.color?.enum).toEqual(["red", "green", "blue"]);
  });

  it("handles multi-document YAML", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-test-"));
    writeCrd(dir, "multi.yaml", `${crossplaneCrd}\n---\n${standardCrd}`);

    const source = new CrdSource([dir]);
    const defs = await source.load();

    expect(defs).toHaveLength(2);
  });

  it("accepts individual file paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-test-"));
    const file = writeCrd(dir, "vpc.yaml", crossplaneCrd);

    const source = new CrdSource([file]);
    const defs = await source.load();

    expect(defs).toHaveLength(1);
  });

  it("skips non-CRD documents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-test-"));
    writeCrd(dir, "not-crd.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n");

    const source = new CrdSource([dir]);
    const defs = await source.load();

    expect(defs).toHaveLength(0);
  });

  it("loads CRDs from file:// URIs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-test-"));
    const file = writeCrd(dir, "vpc.yaml", crossplaneCrd);

    const source = new CrdSource([`file://${file}`]);
    const defs = await source.load();

    expect(defs).toHaveLength(1);
    expect(defs[0]!.kind).toBe("VPC");
  });
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("CrdSource URL loading", () => {
  it("fetches CRDs from https:// URLs", async () => {
    server.use(
      http.get("https://example.com/crds/external-secrets", () => {
        return HttpResponse.text(crossplaneCrd);
      }),
    );

    const source = new CrdSource(["https://example.com/crds/external-secrets"]);
    const defs = await source.load();

    expect(defs).toHaveLength(1);
    expect(defs[0]!.kind).toBe("VPC");
  });

  it("fetches multi-document YAML from URL", async () => {
    server.use(
      http.get("https://example.com/crds/multi", () => {
        return HttpResponse.text(`${crossplaneCrd}\n---\n${standardCrd}`);
      }),
    );

    const source = new CrdSource(["https://example.com/crds/multi"]);
    const defs = await source.load();

    expect(defs).toHaveLength(2);
  });

  it("throws on HTTP error", async () => {
    server.use(
      http.get("https://example.com/crds/missing", () => {
        return new HttpResponse(null, { status: 404, statusText: "Not Found" });
      }),
    );

    const source = new CrdSource(["https://example.com/crds/missing"]);
    await expect(source.load()).rejects.toThrow("Failed to fetch");
  });

  it("mixes local paths and URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-test-"));
    writeCrd(dir, "widget.yaml", standardCrd);

    server.use(
      http.get("https://example.com/crds/vpc", () => {
        return HttpResponse.text(crossplaneCrd);
      }),
    );

    const source = new CrdSource([dir, "https://example.com/crds/vpc"]);
    const defs = await source.load();

    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.kind).sort()).toEqual(["VPC", "Widget"]);
  });
});
