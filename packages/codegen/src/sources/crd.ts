import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ResourceDefinition, ResourceSource, SchemaProperty } from '../schema/index.js';

/** Loads resource definitions from local CRD YAML files, file:// URIs, or https:// URLs. */
export class CrdSource implements ResourceSource {
  readonly name = 'crd';
  private readonly _inputs: string[];

  constructor(inputs: string[]) {
    this._inputs = inputs;
  }

  async load(): Promise<ResourceDefinition[]> {
    const defs: ResourceDefinition[] = [];

    for (const input of this._inputs) {
      const contents = await this._loadContent(input);
      for (const content of contents) {
        const docs = content.split(/^---$/m).filter((d) => d.trim().length > 0);
        for (const doc of docs) {
          const parsed = parseYaml(doc);
          if (isCrd(parsed)) {
            defs.push(...extractDefinitions(parsed));
          }
        }
      }
    }

    return defs;
  }

  private async _loadContent(input: string): Promise<string[]> {
    if (input.startsWith('https://') || input.startsWith('http://')) {
      return [await fetchUrl(input)];
    }

    // Strip file:// scheme if present
    const path = input.startsWith('file://') ? input.slice(7) : input;
    return this._resolveFiles(path).map((f) => readFileSync(f, 'utf-8'));
  }

  private _resolveFiles(path: string): string[] {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return readdirSync(path)
        .filter((e) => e.endsWith('.yaml') || e.endsWith('.yml'))
        .map((e) => join(path, e));
    }
    return [path];
  }
}

async function fetchUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

interface CrdDocument {
  apiVersion: string;
  kind: string;
  spec: {
    group: string;
    names: {
      kind: string;
      plural: string;
      singular?: string;
    };
    versions: Array<{
      name: string;
      served: boolean;
      schema?: {
        openAPIV3Schema?: SchemaProperty;
      };
    }>;
  };
}

function isCrd(doc: unknown): doc is CrdDocument {
  if (typeof doc !== 'object' || doc === null) return false;
  const d = doc as Record<string, unknown>;
  return d.kind === 'CustomResourceDefinition' && typeof d.spec === 'object';
}

function extractDefinitions(crd: CrdDocument): ResourceDefinition[] {
  const defs: ResourceDefinition[] = [];
  const { group } = crd.spec;
  const { kind, plural } = crd.spec.names;

  for (const version of crd.spec.versions) {
    if (!version.served) continue;

    const schema = version.schema?.openAPIV3Schema;
    if (!schema?.properties) continue;

    const specProps = schema.properties.spec as SchemaProperty | undefined;
    const statusProps = schema.properties.status as SchemaProperty | undefined;

    // Crossplane CRDs nest under spec.forProvider / status.atProvider
    // Standard k8s CRDs use spec / status directly
    const forProvider = specProps?.properties?.forProvider;
    const atProvider = statusProps?.properties?.atProvider;
    const isCrossplaneProvider = forProvider !== undefined;

    defs.push({
      group,
      version: version.name,
      kind,
      plural,
      description: schema.description,
      specSchema: forProvider ?? specProps,
      statusSchema: atProvider ?? statusProps,
      fullSpecSchema: specProps,
      fullStatusSchema: statusProps,
      crossplaneProvider: isCrossplaneProvider,
    });
  }

  return defs;
}
