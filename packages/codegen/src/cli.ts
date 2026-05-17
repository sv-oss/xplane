#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { writeOutput } from './generator/index.js';
import type { ResourceDefinition, ResourceSource } from './schema/index.js';
import { CrdSource } from './sources/crd.js';
import { KubernetesSource } from './sources/kubernetes.js';
import { OciSource } from './sources/oci.js';

const sharedGenerateArgs = {
  'output-dir': {
    type: 'string' as const,
    description: 'Output directory for generated types',
    required: true,
  },
  'no-barrel': {
    type: 'boolean' as const,
    description: 'Skip emitting the barrel index.ts',
    default: false,
  },
  readonly: {
    type: 'boolean' as const,
    description: 'Prefix all interface properties with readonly',
    default: false,
  },
  namespace: {
    type: 'boolean' as const,
    description: 'Wrap all exports in a namespace per group+version to avoid naming collisions',
    default: false,
  },
  'fully-qualified-class-names': {
    type: 'boolean' as const,
    description:
      'Prefix class names with namespace to avoid collisions (e.g. Route53AwsUpboundIoV1beta1Record)',
    default: false,
  },
};

interface GenerateArgs {
  'output-dir': string;
  'no-barrel'?: boolean;
  readonly?: boolean;
  namespace?: boolean;
  'fully-qualified-class-names'?: boolean;
}

async function runGeneration(source: ResourceSource, args: GenerateArgs) {
  console.log(`Loading from ${source.name}...`);
  const defs: ResourceDefinition[] = await source.load();
  console.log(`  Found ${defs.length} resource definitions`);

  if (defs.length === 0) {
    throw new Error('No resource definitions found');
  }

  const fullyQualified = args['fully-qualified-class-names'];
  writeOutput(defs, args['output-dir'], {
    noBarrel: args['no-barrel'],
    readonly: args.readonly,
    useNamespace: args.namespace,
    fullyQualifiedClassNames: fullyQualified,
  });
  console.log(`Generated types for ${defs.length} resources in ${args['output-dir']}`);
}

function requireArg(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required argument --${name}`);
  }
  return value;
}

const generateCrd = defineCommand({
  meta: { name: 'crd', description: 'Generate TypeScript types from CRD URIs' },
  args: {
    uri: {
      type: 'string',
      description: 'CRD source: local path, file:// URI, or https:// URL (comma-separated)',
      required: true,
    },
    ...sharedGenerateArgs,
  },
  async run({ args }) {
    const uri = requireArg('uri', args.uri);
    const outputDir = requireArg('output-dir', args['output-dir']);
    await runGeneration(new CrdSource(uri.split(',')), {
      'output-dir': outputDir,
      'no-barrel': args['no-barrel'],
      readonly: args.readonly,
      namespace: args.namespace,
      'fully-qualified-class-names': args['fully-qualified-class-names'],
    });
  },
});

const generateK8s = defineCommand({
  meta: { name: 'k8s', description: 'Generate TypeScript types from Kubernetes core schemas' },
  args: {
    'k8s-version': {
      type: 'string',
      description: 'Kubernetes version for core types (e.g. v1.31.0)',
      required: true,
    },
    ...sharedGenerateArgs,
  },
  async run({ args }) {
    const k8sVersion = requireArg('k8s-version', args['k8s-version']);
    const outputDir = requireArg('output-dir', args['output-dir']);
    await runGeneration(new KubernetesSource(k8sVersion), {
      'output-dir': outputDir,
      'no-barrel': args['no-barrel'],
      readonly: args.readonly,
      namespace: args.namespace,
      'fully-qualified-class-names': args['fully-qualified-class-names'],
    });
  },
});

const generateXpkg = defineCommand({
  meta: { name: 'xpkg', description: 'Generate TypeScript types from Crossplane OCI packages' },
  args: {
    oci: {
      type: 'string',
      description:
        'OCI provider package ref (e.g. xpkg.upbound.io/upbound/provider-aws-ec2:v2.5.0)',
      required: true,
    },
    groups: {
      type: 'string',
      description: 'Comma-separated API groups to include',
    },
    platform: {
      type: 'string',
      description: 'OCI platform to resolve (default: linux/arm64)',
    },
    ...sharedGenerateArgs,
  },
  async run({ args }) {
    const oci = requireArg('oci', args.oci);
    const outputDir = requireArg('output-dir', args['output-dir']);
    const groups = args.groups?.split(',');
    await runGeneration(new OciSource(oci, groups, args.platform), {
      'output-dir': outputDir,
      'no-barrel': args['no-barrel'],
      readonly: args.readonly,
      namespace: args.namespace,
      'fully-qualified-class-names': args['fully-qualified-class-names'],
    });
  },
});

const generate = defineCommand({
  meta: { name: 'generate', description: 'Generate TypeScript types from resource schemas' },
  subCommands: {
    crd: generateCrd,
    k8s: generateK8s,
    xpkg: generateXpkg,
  },
});

const main = defineCommand({
  meta: {
    name: 'xplane-codegen',
    description: 'Generate TypeScript types from Crossplane CRD schemas',
    version: '0.1.0',
  },
  subCommands: { generate },
});

runMain(main);
