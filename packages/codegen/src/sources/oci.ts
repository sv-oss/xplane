import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManifestLayer } from '@xplane/oci';
import { OciRegistryClient, parseOciRef } from '@xplane/oci';
import * as tar from 'tar';
import type { ResourceDefinition, ResourceSource, SchemaProperty } from '../schema/index.js';

/**
 * Credentials for an OCI registry. Mirrors `OciAuth` from `@xplane/oci`
 * but declared locally so the public `OciSource` type does not leak the
 * internal package.
 */
export type OciSourceAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'dockerConfig'; configPath: string };

/**
 * Loads resource definitions from a Crossplane OCI provider package.
 *
 * Fetches the package manifest from the registry, locates the
 * `io.crossplane.xpkg=schema.json` layer, downloads it, and parses the
 * embedded JSON schemas. Multi-arch image indexes are resolved to a
 * per-arch manifest matching `platform`.
 */
export class OciSource implements ResourceSource {
  readonly name = 'oci';
  private readonly _ref: string;
  private readonly _groups: string[];
  private readonly _groupGlobPatterns: RegExp[];
  private readonly _platform: string;
  private readonly _auth: OciSourceAuth | undefined;

  constructor(ref: string, groups?: string[], platform = 'linux/arm64', auth?: OciSourceAuth) {
    this._ref = ref;
    this._groups = (groups ?? [])
      .map((group) => normalizeGroupPattern(group.trim()))
      .filter((group) => group.length > 0);
    this._groupGlobPatterns = this._groups
      .filter((group) => group.includes('*'))
      .map((group) => compileGroupPattern(group));
    this._platform = platform;
    this._auth = auth;
  }

  async load(): Promise<ResourceDefinition[]> {
    const { registry, repository, reference } = parseOciRef(this._ref);
    const client = new OciRegistryClient({ registry, repository, auth: this._auth });

    const manifest = await client.getManifest({ reference, platform: this._platform });
    const schemaLayer = manifest.layers?.find(
      (l) =>
        (l as ManifestLayerWithAnnotations).annotations?.['io.crossplane.xpkg'] === 'schema.json',
    );
    if (!schemaLayer) {
      throw new Error(
        `No schema.json layer found in manifest for ${this._ref}. ` +
          'Ensure this is a Crossplane provider package with embedded JSON schemas.',
      );
    }

    const tmpDir = mkdtempSync(join(tmpdir(), 'xplane-oci-'));
    try {
      const tarPath = join(tmpDir, 'schema.tar.gz');
      await client.downloadBlob({
        digest: schemaLayer.digest,
        targetPath: tarPath,
        expectedSize: schemaLayer.size,
      });
      await tar.extract({ file: tarPath, cwd: tmpDir, strict: true, preservePaths: false });
      rmSync(tarPath, { force: true });

      const modelsDir = join(tmpDir, 'models');
      const defs: ResourceDefinition[] = [];

      for (const file of readdirSync(modelsDir)) {
        if (!file.endsWith('.schema.json')) continue;
        if (file.includes('List.schema.json')) continue;
        if (file.startsWith('io-k8s-')) continue;

        try {
          const content = readFileSync(join(modelsDir, file), 'utf-8');
          const schema = JSON.parse(content) as SchemaProperty;
          const def = extractFromJsonSchema(schema);
          if (!def) continue;

          if (!this._matchesGroup(def.group)) {
            continue;
          }
          defs.push(def);
        } catch {
          // Skip unparseable files
        }
      }

      return defs;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private _matchesGroup(group: string): boolean {
    if (this._groups.length === 0) {
      return true;
    }

    return this._groups.some((candidate) => {
      if (candidate.includes('*')) {
        return this._groupGlobPatterns.some((pattern) => pattern.test(group));
      }
      // Keep historical behavior: non-glob filters are substring matches.
      return group.includes(candidate);
    });
  }
}

function normalizeGroupPattern(pattern: string): string {
  return pattern.replace(/\\\*/g, '*');
}

function compileGroupPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

interface ManifestLayerWithAnnotations extends ManifestLayer {
  annotations?: Record<string, string>;
}

/**
 * Extract a ResourceDefinition from a Crossplane provider JSON schema file.
 * These schemas have apiVersion/kind as enum values and spec.forProvider / status.atProvider.
 */
function extractFromJsonSchema(schema: SchemaProperty): ResourceDefinition | undefined {
  const props = schema.properties;
  if (!props) return undefined;

  const apiVersion = props.apiVersion?.enum?.[0] ?? props.apiVersion?.default;
  const kind = props.kind?.enum?.[0] ?? props.kind?.default;
  if (typeof apiVersion !== 'string' || typeof kind !== 'string') return undefined;

  const slashIdx = apiVersion.indexOf('/');
  if (slashIdx === -1) return undefined;
  const group = apiVersion.slice(0, slashIdx);
  const version = apiVersion.slice(slashIdx + 1);

  const plural = `${kind.toLowerCase()}s`;

  const specProps = props.spec as SchemaProperty | undefined;
  const statusProps = props.status as SchemaProperty | undefined;

  const forProvider = specProps?.properties?.forProvider as SchemaProperty | undefined;
  const atProvider = statusProps?.properties?.atProvider as SchemaProperty | undefined;

  const specSchema = forProvider ? { ...forProvider, required: forProvider.required } : specProps;
  const statusSchema = atProvider ?? statusProps;

  return {
    group,
    version,
    kind,
    plural,
    description: schema.description,
    specSchema,
    statusSchema,
    fullSpecSchema: specProps,
    fullStatusSchema: statusProps,
    crossplaneProvider: forProvider !== undefined,
    scope: group.includes('.m.') ? 'Namespaced' : 'Cluster',
  };
}
