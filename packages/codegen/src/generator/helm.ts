import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { ResourceDefinition, SchemaProperty } from '../schema/index.js';

/** Options for writeHelmCharts. */
export interface HelmChartOptions {
  /** Chart name written to Chart.yaml. Default: <name>.
   *
   * @default - the plural form of the resource's kind, e.g. "foos" for kind "Foo"
   */
  chartName?: string;

  /**
   * Chart version written to Chart.yaml.
   *
   * @default "0.1.0"
   */
  chartVersion?: string;
}

/**
 * Emit one Helm chart per resource definition under `<outputDir>/<plural>-<version>/`.
 * Each chart contains a single template: the XR itself, with `spec` rendered
 * from `.Values.spec`. The XRD's spec schema is emitted as `values.schema.json`
 * so `helm install` / `helm template` validate input automatically.
 */
export function writeHelmCharts(
  defs: ResourceDefinition[],
  outputDir: string,
  options: HelmChartOptions = {},
): void {
  mkdirSync(outputDir, { recursive: true });

  for (const def of defs) {
    const chartDir = join(outputDir, `${def.plural}-${def.version}`);
    const templatesDir = join(chartDir, 'templates');
    mkdirSync(templatesDir, { recursive: true });

    writeFileSync(join(chartDir, 'Chart.yaml'), renderChartYaml(def, options));
    writeFileSync(join(chartDir, 'values.yaml'), renderValuesYaml(def));
    writeFileSync(join(chartDir, 'values.schema.json'), renderValuesSchema(def));
    writeFileSync(join(templatesDir, 'xr.yaml'), renderXrTemplate(def));
  }
}

function renderChartYaml(def: ResourceDefinition, options: HelmChartOptions): string {
  const chart: Record<string, unknown> = {
    apiVersion: 'v2',
    name: options.chartName ?? def.plural,
    type: 'application',
    version: options.chartVersion ?? '0.1.0',
    appVersion: def.version,
  };
  if (def.description) {
    chart.description = def.description;
  }
  return stringifyYaml(chart);
}

function renderValuesYaml(def: ResourceDefinition): string {
  const header = [
    '# Default values for this chart.',
    "# All keys under `spec` map directly to the XR's spec fields.",
    '# See values.schema.json for the full schema (used by helm to validate input).',
    '# Defaults below are extracted from `default:` fields in the XRD spec schema.',
  ];
  const defaults = def.specSchema ? extractDefaults(def.specSchema) : undefined;
  const specBlock =
    defaults && typeof defaults === 'object' && Object.keys(defaults).length > 0
      ? stringifyYaml({ spec: defaults })
      : 'spec: {}\n';
  return `${header.join('\n')}\n${specBlock}`;
}

/**
 * Walk the schema and collect all `default:` values into a nested object
 * mirroring the schema's property shape. Returns `undefined` when no defaults
 * are present at this node or below.
 */
function extractDefaults(schema: SchemaProperty): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      const value = extractDefaults(child);
      if (value !== undefined) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

function renderValuesSchema(def: ResourceDefinition): string {
  const specSchema = def.specSchema ?? { type: 'object' };
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      spec: stripUnsupported(specSchema),
    },
    required: ['spec'],
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function renderXrTemplate(def: ResourceDefinition): string {
  const apiVersion = `${def.group}/${def.version}`;
  const namespaceBlock =
    def.scope === 'Namespaced' ? '  namespace: {{ .Release.Namespace }}\n' : '';
  return [
    `apiVersion: ${apiVersion}`,
    `kind: ${def.kind}`,
    'metadata:',
    '  name: {{ .Release.Name }}',
    `${namespaceBlock}spec:`,
    '  {{- toYaml .Values.spec | nindent 2 }}',
    '',
  ].join('\n');
}

/**
 * Strip JSON Schema fields that draft-07 validators reject, e.g. the
 * Kubernetes-specific `x-kubernetes-preserve-unknown-fields` extension.
 * Recurses through `properties`, `items`, and `additionalProperties`.
 */
function stripUnsupported(schema: SchemaProperty): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith('x-kubernetes-')) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, SchemaProperty>)) {
        props[k] = stripUnsupported(v);
      }
      out[key] = props;
    } else if (key === 'items' && value && typeof value === 'object') {
      out[key] = stripUnsupported(value as SchemaProperty);
    } else if (key === 'additionalProperties' && value && typeof value === 'object') {
      out[key] = stripUnsupported(value as SchemaProperty);
    } else {
      out[key] = value;
    }
  }
  return out;
}
