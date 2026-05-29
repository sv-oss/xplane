import { describe, expect, it } from 'vitest';
import { generateGroupFile } from '../generator/emit.js';
import type { ResourceDefinition } from '../schema/index.js';

const vpcDef: ResourceDefinition = {
  group: 'ec2.aws.upbound.io',
  version: 'v1beta1',
  kind: 'VPC',
  plural: 'vpcs',
  description: 'A VPC resource.',
  specSchema: {
    type: 'object',
    required: ['region'],
    properties: {
      region: { type: 'string', description: 'AWS region' },
      cidrBlock: { type: 'string' },
      tags: { type: 'object', additionalProperties: { type: 'string' } },
      enableDnsSupport: { type: 'boolean' },
      ipv4NetmaskLength: { type: 'integer' },
    },
  },
  statusSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      arn: { type: 'string' },
    },
  },
};

describe('generateGroupFile', () => {
  it('produces valid TypeScript with interfaces and class', () => {
    const output = generateGroupFile('ec2.aws.upbound.io', [vpcDef]);

    expect(output).toContain('interface Ec2AwsUpboundIoV1beta1VPCSpec');
    expect(output).toContain('interface Ec2AwsUpboundIoV1beta1VPCStatus');
    expect(output).toContain('interface Ec2AwsUpboundIoV1beta1VPCProps');
    expect(output).toContain('class Ec2AwsUpboundIoV1beta1VPC extends Resource {');
    expect(output).toContain('declare spec: Ec2AwsUpboundIoV1beta1VPCSpec;');
    expect(output).toContain('declare status: Ec2AwsUpboundIoV1beta1VPCStatus;');
    expect(output).toContain('apiVersion: "ec2.aws.upbound.io/v1beta1"');
    expect(output).toContain('kind: "VPC"');
    expect(output).toContain(
      'static manifest(props?: Ec2AwsUpboundIoV1beta1VPCProps): Record<string, unknown>',
    );
    // Export block remaps to short names
    expect(output).toContain('export type {');
    expect(output).toContain('Ec2AwsUpboundIoV1beta1VPCSpec as VPCSpec');
    expect(output).toContain('Ec2AwsUpboundIoV1beta1VPC as VPC');
  });

  it('marks required fields without ?', () => {
    const output = generateGroupFile('ec2.aws.upbound.io', [vpcDef]);
    expect(output).toMatch(/\tregion: string;/);
  });

  it('marks optional fields with ?', () => {
    const output = generateGroupFile('ec2.aws.upbound.io', [vpcDef]);
    expect(output).toMatch(/\tcidrBlock\?: string;/);
  });

  it('maps integer to number', () => {
    const output = generateGroupFile('ec2.aws.upbound.io', [vpcDef]);
    expect(output).toMatch(/ipv4NetmaskLength\?: number;/);
  });

  it('maps additionalProperties to Record type', () => {
    const output = generateGroupFile('ec2.aws.upbound.io', [vpcDef]);
    expect(output).toMatch(/tags\?: Record<string, string>;/);
  });

  it('emits static manifest with apiVersion, kind, metadata and spec wiring', () => {
    const output = generateGroupFile('ec2.aws.upbound.io', [vpcDef]);

    expect(output).toContain('static manifest(props?: Ec2AwsUpboundIoV1beta1VPCProps)');
    expect(output).toContain('apiVersion: "ec2.aws.upbound.io/v1beta1"');
    expect(output).toContain('kind: "VPC"');
    expect(output).toContain('...props');
    expect(output).toContain('spec?: Ec2AwsUpboundIoV1beta1VPCSpec;');
    expect(output).toContain('metadata?: {');
  });

  it('includes JSDoc description', () => {
    const output = generateGroupFile('ec2.aws.upbound.io', [vpcDef]);
    expect(output).toContain('/** A VPC resource. */');
    expect(output).toContain('/** AWS region */');
  });

  it('handles defs with no schema properties', () => {
    const emptyDef: ResourceDefinition = {
      group: 'test.io',
      version: 'v1',
      kind: 'Empty',
      plural: 'empties',
    };
    const output = generateGroupFile('test.io', [emptyDef]);
    expect(output).toContain('[key: string]: unknown;');
  });

  it('preserves all properties including Ref and Selector fields', () => {
    const def: ResourceDefinition = {
      group: 'test.io',
      version: 'v1',
      kind: 'Thing',
      plural: 'things',
      specSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          vpcIdRef: { type: 'object' },
          vpcIdSelector: { type: 'object' },
          providerConfigRef: { type: 'object' },
          namespaceSelector: {
            type: 'object',
            properties: {
              matchLabels: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
        },
      },
    };
    const output = generateGroupFile('test.io', [def]);
    expect(output).toContain('name?:');
    expect(output).toContain('vpcIdRef?:');
    expect(output).toContain('vpcIdSelector?:');
    expect(output).toContain('providerConfigRef?:');
    expect(output).toContain('namespaceSelector?:');
  });

  it('generates enum types', () => {
    const def: ResourceDefinition = {
      group: 'test.io',
      version: 'v1',
      kind: 'Color',
      plural: 'colors',
      specSchema: {
        type: 'object',
        properties: {
          color: { type: 'string', enum: ['red', 'green', 'blue'] },
        },
      },
    };
    const output = generateGroupFile('test.io', [def]);
    expect(output).toMatch(/color\?: "red" \| "green" \| "blue"/);
  });

  it('emits JSDoc for nested inline object properties', () => {
    const def: ResourceDefinition = {
      group: 'test.io',
      version: 'v1',
      kind: 'Server',
      plural: 'servers',
      specSchema: {
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: {
              host: { type: 'string', description: 'The hostname to connect to' },
              port: { type: 'integer', description: 'The port number' },
              tls: { type: 'boolean' },
            },
          },
        },
      },
    };
    const output = generateGroupFile('test.io', [def]);
    expect(output).toContain('/** The hostname to connect to */');
    expect(output).toContain('/** The port number */');
    // property without description should not have JSDoc
    expect(output).not.toMatch(/\/\*\*.*\*\/\s*\n\s*tls/);
  });

  it('emits JSDoc on the Resource class', () => {
    const output = generateGroupFile('ec2.aws.upbound.io', [vpcDef]);
    // Class should have JSDoc before it
    expect(output).toMatch(/\/\*\* A VPC resource\. \*\/\nclass Ec2AwsUpboundIoV1beta1VPC/);
  });

  it('does not emit class JSDoc when no description', () => {
    const def: ResourceDefinition = {
      group: 'test.io',
      version: 'v1',
      kind: 'Empty',
      plural: 'empties',
    };
    const output = generateGroupFile('test.io', [def]);
    expect(output).not.toMatch(/\/\*\*.*\*\/\nexport class Empty/);
  });

  it('treats fields with a default as optional even if in required list', () => {
    const def: ResourceDefinition = {
      group: 'test.io',
      version: 'v1',
      kind: 'Store',
      plural: 'stores',
      specSchema: {
        type: 'object',
        required: ['name', 'conversionStrategy'],
        properties: {
          name: { type: 'string' },
          conversionStrategy: { type: 'string', default: 'Default' },
        },
      },
    };
    const output = generateGroupFile('test.io', [def]);
    // name is required with no default → required
    expect(output).toMatch(/\tname: string;/);
    // conversionStrategy is in required list but has a default → optional
    expect(output).toMatch(/\tconversionStrategy\?: string;/);
  });

  it('declares extraSchema fields on the class body', () => {
    const def: ResourceDefinition = {
      group: 'core',
      version: 'v1',
      kind: 'Secret',
      plural: 'secrets',
      extraSchema: {
        data: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Secret data (base64)',
        },
        stringData: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Secret string data',
        },
        immutable: { type: 'boolean', description: 'Immutable flag' },
        type: { type: 'string', description: 'Secret type' },
      },
    };
    const output = generateGroupFile('core', [def]);
    // Extra fields must appear as `declare` on the class, not just in Props
    expect(output).toMatch(/declare data\?: Record<string, string>;/);
    expect(output).toMatch(/declare immutable\?: boolean;/);
    expect(output).toMatch(/declare stringData\?: Record<string, string>;/);
    expect(output).toMatch(/declare type\?: string;/);
    // They must also still appear in the Props interface
    expect(output).toMatch(/data\?: Record<string, string>;/);
    expect(output).toMatch(/stringData\?: Record<string, string>;/);
  });
});
