import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { writeHelmCharts } from '../generator/helm.js';
import type { ResourceDefinition } from '../schema/index.js';

const namespacedDef: ResourceDefinition = {
  group: 'sdp.platform.vic.gov.au',
  version: 'v1alpha1',
  kind: 'TideApp',
  plural: 'tideapps',
  description: 'A tide-app composite resource.',
  scope: 'Namespaced',
  specSchema: {
    type: 'object',
    required: ['environmentName', 'projectRef'],
    properties: {
      environmentName: { type: 'string' },
      projectRef: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      cms: {
        type: 'object',
        properties: {
          image: { type: 'string' },
          minReplicas: { type: 'integer', default: 1 },
          maxReplicas: { type: 'integer' },
        },
      },
    },
  },
};

const clusterDef: ResourceDefinition = {
  group: 'sdp.platform.vic.gov.au',
  version: 'v1alpha1',
  kind: 'Project',
  plural: 'projects',
  scope: 'Cluster',
  specSchema: {
    type: 'object',
    properties: {
      aws: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          region: { type: 'string', default: 'ap-southeast-2' },
        },
      },
    },
  },
};

const defWithKubernetesExtension: ResourceDefinition = {
  group: 'example.io',
  version: 'v1',
  kind: 'Thing',
  plural: 'things',
  specSchema: {
    type: 'object',
    properties: {
      raw: {
        type: 'object',
        'x-kubernetes-preserve-unknown-fields': true,
      },
      list: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
      free: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
    },
  },
};

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'xplane-helm-'));
}

describe('writeHelmCharts', () => {
  it('emits Chart.yaml, values.yaml, values.schema.json and templates/xr.yaml per definition', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef, clusterDef], out);

    expect(readdirSync(out).sort()).toEqual(['projects-v1alpha1', 'tideapps-v1alpha1']);

    for (const dir of ['tideapps-v1alpha1', 'projects-v1alpha1']) {
      const base = join(out, dir);
      expect(statSync(base).isDirectory()).toBe(true);
      expect(statSync(join(base, 'Chart.yaml')).isFile()).toBe(true);
      expect(statSync(join(base, 'values.yaml')).isFile()).toBe(true);
      expect(statSync(join(base, 'values.schema.json')).isFile()).toBe(true);
      expect(statSync(join(base, 'templates', 'xr.yaml')).isFile()).toBe(true);
    }
  });

  it('emits templates/extra-objects.yaml per definition when allowExtraObjects is true', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef, clusterDef], out, { allowExtraObjects: true });

    expect(readdirSync(out).sort()).toEqual(['projects-v1alpha1', 'tideapps-v1alpha1']);

    for (const dir of ['tideapps-v1alpha1', 'projects-v1alpha1']) {
      const base = join(out, dir);
      expect(statSync(base).isDirectory()).toBe(true);
      expect(statSync(join(base, 'templates', 'extra-objects.yaml')).isFile()).toBe(true);
    }
  });

  it('doesnt emit templates/extra-objects.yaml per definition when allowExtraObjects is false', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef, clusterDef], out, { allowExtraObjects: false });

    expect(readdirSync(out).sort()).toEqual(['projects-v1alpha1', 'tideapps-v1alpha1']);

    for (const dir of ['tideapps-v1alpha1', 'projects-v1alpha1']) {
      const base = join(out, dir);
      expect(statSync(base).isDirectory()).toBe(true);
      const files = readdirSync(base);
      expect(files).not.toContain('templates/extra-objects.yaml');
    }
  });

  it('renders Chart.yaml with name, version, appVersion, and description', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef], out);
    const chart = parseYaml(readFileSync(join(out, 'tideapps-v1alpha1', 'Chart.yaml'), 'utf-8'));
    expect(chart).toEqual({
      apiVersion: 'v2',
      name: 'tideapps',
      type: 'application',
      version: '0.1.0',
      appVersion: 'v1alpha1',
      description: 'A tide-app composite resource.',
    });
  });

  it('omits description when the XRD has none and honors --chart-version', () => {
    const out = makeTmpDir();
    writeHelmCharts([clusterDef], out, { chartVersion: '2.5.0' });
    const chart = parseYaml(readFileSync(join(out, 'projects-v1alpha1', 'Chart.yaml'), 'utf-8'));
    expect(chart).toEqual({
      apiVersion: 'v2',
      name: 'projects',
      type: 'application',
      version: '2.5.0',
      appVersion: 'v1alpha1',
    });
  });

  it('omits description when the XRD has none and honors --chart-name', () => {
    const out = makeTmpDir();
    writeHelmCharts([clusterDef], out, { chartName: 'custom-name' });
    const chart = parseYaml(readFileSync(join(out, 'projects-v1alpha1', 'Chart.yaml'), 'utf-8'));
    expect(chart).toEqual({
      apiVersion: 'v2',
      name: 'custom-name',
      type: 'application',
      version: '0.1.0',
      appVersion: 'v1alpha1',
    });
  });

  it('extracts `default:` values from the spec schema into values.yaml', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef], out);
    const values = parseYaml(readFileSync(join(out, 'tideapps-v1alpha1', 'values.yaml'), 'utf-8'));
    expect(values).toEqual({ spec: { cms: { minReplicas: 1 } } });
  });

  it('falls back to `spec: {}` when no defaults are present in the schema', () => {
    const out = makeTmpDir();
    writeHelmCharts(
      [
        {
          group: 'example.io',
          version: 'v1',
          kind: 'NoDefault',
          plural: 'nodefaults',
          specSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
        },
      ],
      out,
    );
    const values = parseYaml(readFileSync(join(out, 'nodefaults-v1', 'values.yaml'), 'utf-8'));
    expect(values).toEqual({ spec: {} });
  });

  it('preserves non-object default values (arrays, scalars, explicit empty objects)', () => {
    const out = makeTmpDir();
    writeHelmCharts(
      [
        {
          group: 'example.io',
          version: 'v1',
          kind: 'Defaults',
          plural: 'defaultsx',
          specSchema: {
            type: 'object',
            properties: {
              tags: { type: 'array', default: [] },
              region: { type: 'string', default: 'ap-southeast-2' },
              enabled: { type: 'boolean', default: true },
              cfg: { type: 'object', default: {} },
            },
          },
        },
      ],
      out,
    );
    const values = parseYaml(readFileSync(join(out, 'defaultsx-v1', 'values.yaml'), 'utf-8'));
    expect(values).toEqual({
      spec: { tags: [], region: 'ap-southeast-2', enabled: true, cfg: {} },
    });
  });

  it('adds extraObjects section to values.yaml when allowExtraObjects is true', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef], out, { allowExtraObjects: true });
    const values = parseYaml(readFileSync(join(out, 'tideapps-v1alpha1', 'values.yaml'), 'utf-8'));
    expect(values).toMatchObject({ extraObjects: [] });
  });

  it('emits values.schema.json wrapping the XRD spec schema under properties.spec', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef], out);
    const schema = JSON.parse(
      readFileSync(join(out, 'tideapps-v1alpha1', 'values.schema.json'), 'utf-8'),
    );
    expect(schema).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          required: ['environmentName', 'projectRef'],
          properties: {
            environmentName: { type: 'string' },
            projectRef: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string' } },
            },
            cms: {
              type: 'object',
              properties: {
                image: { type: 'string' },
                minReplicas: { type: 'integer', default: 1 },
                maxReplicas: { type: 'integer' },
              },
            },
          },
        },
      },
      required: ['spec'],
    });
  });

  it('falls back to an empty object schema when the XRD has no spec schema', () => {
    const out = makeTmpDir();
    writeHelmCharts(
      [
        {
          group: 'example.io',
          version: 'v1',
          kind: 'Empty',
          plural: 'empties',
        },
      ],
      out,
    );
    const schema = JSON.parse(readFileSync(join(out, 'empties-v1', 'values.schema.json'), 'utf-8'));
    expect(schema.properties.spec).toEqual({ type: 'object' });
  });

  it('strips x-kubernetes-* extensions recursively from the spec schema', () => {
    const out = makeTmpDir();
    writeHelmCharts([defWithKubernetesExtension], out);
    const schema = JSON.parse(readFileSync(join(out, 'things-v1', 'values.schema.json'), 'utf-8'));
    expect(schema.properties.spec.properties.raw).toEqual({ type: 'object' });
    expect(schema.properties.spec.properties.list).toEqual({
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' } } },
    });
    expect(schema.properties.spec.properties.free).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
  });

  it('adds extraObjects section to schema when allowExtraObjects is true', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef], out, { allowExtraObjects: true });
    const schema = JSON.parse(
      readFileSync(join(out, 'tideapps-v1alpha1', 'values.schema.json'), 'utf-8'),
    );
    expect(schema.properties.extraObjects).toMatchObject({
      type: 'array',
      items: { type: 'object' },
    });
  });

  it('renders a Namespaced XR template with metadata.namespace from the release', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef], out);
    const tmpl = readFileSync(join(out, 'tideapps-v1alpha1', 'templates', 'xr.yaml'), 'utf-8');
    expect(tmpl).toContain('apiVersion: sdp.platform.vic.gov.au/v1alpha1');
    expect(tmpl).toContain('kind: TideApp');
    expect(tmpl).toContain('name: {{ .Release.Name }}');
    expect(tmpl).toContain('namespace: {{ .Release.Namespace }}');
    expect(tmpl).toContain('{{- toYaml .Values.spec | nindent 2 }}');
  });

  it('omits metadata.namespace for Cluster-scoped XRs', () => {
    const out = makeTmpDir();
    writeHelmCharts([clusterDef], out);
    const tmpl = readFileSync(join(out, 'projects-v1alpha1', 'templates', 'xr.yaml'), 'utf-8');
    expect(tmpl).toContain('kind: Project');
    expect(tmpl).not.toContain('namespace:');
  });

  it('creates the output directory when missing', () => {
    const out = join(makeTmpDir(), 'nested', 'charts');
    writeHelmCharts([namespacedDef], out);
    expect(statSync(out).isDirectory()).toBe(true);
    expect(statSync(join(out, 'tideapps-v1alpha1')).isDirectory()).toBe(true);
  });
});

describe('writeHelmCharts + helm lint round-trip', () => {
  const hasHelm = (() => {
    try {
      execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasHelm)('passes helm lint and helm template against the generated chart', () => {
    const out = makeTmpDir();
    writeHelmCharts([namespacedDef], out, { allowExtraObjects: true });
    const chartDir = join(out, 'tideapps-v1alpha1');

    const valuesPath = join(out, 'override-values.yaml');
    writeFileSync(
      valuesPath,
      'spec:\n  environmentName: dev\n  projectRef:\n    name: my-proj\n  cms:\n    image: foo:1\n    minReplicas: 1\n    maxReplicas: 3\n',
    );

    execFileSync('helm', ['lint', chartDir, '-f', valuesPath], { stdio: 'pipe' });

    const rendered = execFileSync(
      'helm',
      ['template', 'my-app', chartDir, '-f', valuesPath, '--namespace', 'apps'],
      { encoding: 'utf-8' },
    );

    const docs = rendered
      .split(/^---$/m)
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
      .map((d) => parseYaml(d));
    const xr = docs.find((d: { kind?: string } | null) => d?.kind === 'TideApp');
    expect(xr).toBeDefined();
    expect(xr.metadata.name).toBe('my-app');
    expect(xr.metadata.namespace).toBe('apps');
    expect(xr.spec.environmentName).toBe('dev');
    expect(xr.spec.cms.image).toBe('foo:1');
  });
});
