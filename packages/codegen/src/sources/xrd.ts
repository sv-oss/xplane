import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ResourceDefinition, ResourceSource, SchemaProperty } from '../schema/index.js';

/** Loads resource definitions from Crossplane CompositeResourceDefinition YAML files, file:// URIs, or https:// URLs. */
export class XrdSource implements ResourceSource {
  readonly name = 'xrd';
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
          if (isXrd(parsed)) {
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

interface XrdDocument {
  apiVersion: string;
  kind: string;
  spec: {
    group: string;
    names: {
      kind: string;
      plural: string;
    };
    versions: Array<{
      name: string;
      served: boolean;
      referenceable?: boolean;
      schema?: {
        openAPIV3Schema?: SchemaProperty;
      };
    }>;
  };
}

function isXrd(doc: unknown): doc is XrdDocument {
  if (typeof doc !== 'object' || doc === null) return false;
  const d = doc as Record<string, unknown>;
  return d.kind === 'CompositeResourceDefinition' && typeof d.spec === 'object';
}

function extractDefinitions(xrd: XrdDocument): ResourceDefinition[] {
  const defs: ResourceDefinition[] = [];
  const { group } = xrd.spec;
  const { kind, plural } = xrd.spec.names;

  for (const version of xrd.spec.versions) {
    if (!version.served) continue;

    const schema = version.schema?.openAPIV3Schema;
    if (!schema?.properties) continue;

    const specProps = schema.properties.spec as SchemaProperty | undefined;
    const statusProps = schema.properties.status as SchemaProperty | undefined;

    defs.push({
      group,
      version: version.name,
      kind,
      plural,
      description: schema.description,
      specSchema: specProps,
      statusSchema: statusProps,
    });
  }

  return defs;
}
