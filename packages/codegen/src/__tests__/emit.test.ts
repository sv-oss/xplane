import { describe, expect, it } from "vitest";
import { generateGroupFile } from "../generator/emit.js";
import type { ResourceDefinition } from "../schema/index.js";

const vpcDef: ResourceDefinition = {
  group: "ec2.aws.upbound.io",
  version: "v1beta1",
  kind: "VPC",
  plural: "vpcs",
  description: "A VPC resource.",
  specSchema: {
    type: "object",
    required: ["region"],
    properties: {
      region: { type: "string", description: "AWS region" },
      cidrBlock: { type: "string" },
      tags: { type: "object", additionalProperties: { type: "string" } },
      enableDnsSupport: { type: "boolean" },
      ipv4NetmaskLength: { type: "integer" },
    },
  },
  statusSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      arn: { type: "string" },
    },
  },
};

describe("generateGroupFile", () => {
  it("produces valid TypeScript with interfaces and class", () => {
    const output = generateGroupFile("ec2.aws.upbound.io", [vpcDef]);

    expect(output).toContain("export interface VPCSpec");
    expect(output).toContain("export interface VPCStatus");
    expect(output).toContain("export interface VPCProps");
    expect(output).toContain("export class VPC extends Resource<VPCSpec, VPCStatus>");
    expect(output).toContain('apiVersion: "ec2.aws.upbound.io/v1beta1"');
    expect(output).toContain('kind: "VPC"');
  });

  it("marks required fields without ?", () => {
    const output = generateGroupFile("ec2.aws.upbound.io", [vpcDef]);
    expect(output).toMatch(/\tregion: string;/);
  });

  it("marks optional fields with ?", () => {
    const output = generateGroupFile("ec2.aws.upbound.io", [vpcDef]);
    expect(output).toMatch(/\tcidrBlock\?: string;/);
  });

  it("maps integer to number", () => {
    const output = generateGroupFile("ec2.aws.upbound.io", [vpcDef]);
    expect(output).toMatch(/ipv4NetmaskLength\?: number;/);
  });

  it("maps additionalProperties to Record type", () => {
    const output = generateGroupFile("ec2.aws.upbound.io", [vpcDef]);
    expect(output).toMatch(/tags\?: Record<string, string>;/);
  });

  it("includes JSDoc description", () => {
    const output = generateGroupFile("ec2.aws.upbound.io", [vpcDef]);
    expect(output).toContain("/** A VPC resource. */");
    expect(output).toContain("/** AWS region */");
  });

  it("handles defs with no schema properties", () => {
    const emptyDef: ResourceDefinition = {
      group: "test.io",
      version: "v1",
      kind: "Empty",
      plural: "empties",
    };
    const output = generateGroupFile("test.io", [emptyDef]);
    expect(output).toContain("[key: string]: unknown;");
  });

  it("preserves all properties including Ref and Selector fields", () => {
    const def: ResourceDefinition = {
      group: "test.io",
      version: "v1",
      kind: "Thing",
      plural: "things",
      specSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          vpcIdRef: { type: "object" },
          vpcIdSelector: { type: "object" },
          providerConfigRef: { type: "object" },
          namespaceSelector: {
            type: "object",
            properties: {
              matchLabels: { type: "object", additionalProperties: { type: "string" } },
            },
          },
        },
      },
    };
    const output = generateGroupFile("test.io", [def]);
    expect(output).toContain("name?:");
    expect(output).toContain("vpcIdRef?:");
    expect(output).toContain("vpcIdSelector?:");
    expect(output).toContain("providerConfigRef?:");
    expect(output).toContain("namespaceSelector?:");
  });

  it("generates enum types", () => {
    const def: ResourceDefinition = {
      group: "test.io",
      version: "v1",
      kind: "Color",
      plural: "colors",
      specSchema: {
        type: "object",
        properties: {
          color: { type: "string", enum: ["red", "green", "blue"] },
        },
      },
    };
    const output = generateGroupFile("test.io", [def]);
    expect(output).toMatch(/color\?: "red" \| "green" \| "blue"/);
  });
});
