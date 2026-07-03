import { createRequire } from 'node:module';
import { defineCommand } from 'citty';
import { writeHelmCharts, writeOutput } from './generator/index.js';
import type { ResourceDefinition, ResourceSource } from './schema/index.js';
import { CrdSource } from './sources/crd.js';
import { KubernetesSource } from './sources/kubernetes.js';
import { OciSource } from './sources/oci.js';
import { resolveOciAuth } from './sources/oci-auth.js';
import { XrdSource } from './sources/xrd.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const sharedGenerateArgs = {
  'output-dir': {
    type: 'string' as const,
    description: 'Output directory for generated types',
    required: true,
  },
  // Defined as a positive boolean defaulting to true so citty's built-in
  // `--no-<flag>` negation correctly disables it via `--no-barrel`.
  barrel: {
    type: 'boolean' as const,
    description: 'Emit the barrel index.ts (pass --no-barrel to skip)',
    default: true,
  },
  readonly: {
    type: 'boolean' as const,
    description: 'Prefix all interface properties with readonly',
    default: false,
  },
};

interface GenerateArgs {
  'output-dir': string;
  barrel?: boolean;
  readonly?: boolean;
}

async function runGeneration(source: ResourceSource, args: GenerateArgs) {
  console.log(`Loading from ${source.name}...`);
  const defs: ResourceDefinition[] = await source.load();
  console.log(`  Found ${defs.length} resource definitions`);

  if (defs.length === 0) {
    throw new Error('No resource definitions found');
  }

  writeOutput(defs, args['output-dir'], {
    noBarrel: args.barrel === false,
    readonly: args.readonly,
  });
  console.log(`Generated types for ${defs.length} resources in ${args['output-dir']}`);
}

function requireArg(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required argument --${name}`);
  }
  return value;
}

const ociAuthArgs = {
  username: {
    type: 'string' as const,
    description: 'Registry username for basic auth (requires --password)',
  },
  password: {
    type: 'string' as const,
    description: 'Registry password for basic auth (requires --username)',
  },
  token: {
    type: 'string' as const,
    description: 'Bearer token for the registry',
  },
  'docker-config': {
    type: 'string' as const,
    description:
      'Path to a Docker config.json. If omitted, falls back to $DOCKER_CONFIG/config.json then ~/.docker/config.json when present',
  },
};

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
      barrel: args.barrel,
      readonly: args.readonly,
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
      barrel: args.barrel,
      readonly: args.readonly,
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
      description:
        'Comma-separated API groups/patterns to include (supports * wildcards, e.g. "*.m.*")',
    },
    platform: {
      type: 'string',
      description: 'OCI platform to resolve (default: linux/arm64)',
    },
    ...ociAuthArgs,
    ...sharedGenerateArgs,
  },
  async run({ args }) {
    const oci = requireArg('oci', args.oci);
    const outputDir = requireArg('output-dir', args['output-dir']);
    const groups = args.groups
      ?.split(',')
      .map((group) => group.trim())
      .filter((group) => group.length > 0);
    const auth = resolveOciAuth(args);
    await runGeneration(new OciSource(oci, groups, args.platform, auth), {
      'output-dir': outputDir,
      barrel: args.barrel,
      readonly: args.readonly,
    });
  },
});

const generateXrd = defineCommand({
  meta: {
    name: 'xrd',
    description: 'Generate TypeScript types from CompositeResourceDefinition URIs',
  },
  args: {
    uri: {
      type: 'string',
      description: 'XRD source: local path, file:// URI, or https:// URL (comma-separated)',
      required: true,
    },
    ...sharedGenerateArgs,
  },
  async run({ args }) {
    const uri = requireArg('uri', args.uri);
    const outputDir = requireArg('output-dir', args['output-dir']);
    await runGeneration(new XrdSource(uri.split(',')), {
      'output-dir': outputDir,
      barrel: args.barrel,
      readonly: args.readonly,
    });
  },
});

const generateTypesFrom = defineCommand({
  meta: {
    name: 'generate-types-from',
    description: 'Generate TypeScript types from resource schemas',
  },
  subCommands: {
    crd: generateCrd,
    xrd: generateXrd,
    k8s: generateK8s,
    xpkg: generateXpkg,
  },
});

const generateHelmFromXrd = defineCommand({
  meta: {
    name: 'xrd',
    description: 'Generate a Helm chart per CompositeResourceDefinition',
  },
  args: {
    uri: {
      type: 'string',
      description: 'XRD source: local path, file:// URI, or https:// URL (comma-separated)',
      required: true,
    },
    'output-dir': {
      type: 'string',
      description: 'Output directory for generated Helm charts',
      required: true,
    },
    'chart-name': {
      type: 'string',
      description:
        'Chart name written to Chart.yaml (default: plural form of the resource kind, e.g. "foos" for kind "Foo")',
    },
    'chart-version': {
      type: 'string',
      description: 'Chart version written to Chart.yaml (default: "0.1.0")',
    },
    'allow-extra-objects': {
      type: 'boolean',
      description:
        'Adds an extraObjects section to the Helm chart to allow arbitrary Kubernetes objects to be included in the chart (default: false)',
      default: false,
    },
  },
  async run({ args }) {
    const uri = requireArg('uri', args.uri);
    const outputDir = requireArg('output-dir', args['output-dir']);
    const source = new XrdSource(uri.split(','));
    console.log(`Loading from ${source.name}...`);
    const defs: ResourceDefinition[] = await source.load();
    console.log(`  Found ${defs.length} resource definitions`);
    if (defs.length === 0) {
      throw new Error('No resource definitions found');
    }
    writeHelmCharts(defs, outputDir, {
      chartVersion: args['chart-version'],
      chartName: args['chart-name'],
      allowExtraObjects: args['allow-extra-objects'],
    });
    console.log(`Generated ${defs.length} Helm chart(s) in ${outputDir}`);
  },
});

const generateHelmFrom = defineCommand({
  meta: { name: 'generate-helm-from', description: 'Generate Helm charts from resource schemas' },
  subCommands: {
    xrd: generateHelmFromXrd,
  },
});

export const main = defineCommand({
  meta: {
    name: 'xplane-codegen',
    description: 'Generate TypeScript types from Crossplane CRD schemas',
    version,
  },
  subCommands: {
    'generate-types-from': generateTypesFrom,
    'generate-helm-from': generateHelmFrom,
  },
});
