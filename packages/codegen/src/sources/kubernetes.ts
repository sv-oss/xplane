import $RefParser from "@apidevtools/json-schema-ref-parser";
import type { ResourceDefinition, ResourceSource, SchemaProperty } from "../schema/index.js";

const CDK8S_SCHEMA_BASE =
  "https://raw.githubusercontent.com/cdk8s-team/cdk8s/master/kubernetes-schemas";

/**
 * Fetches Kubernetes resource definitions from cdk8s-published JSON schemas.
 * Resolves all internal $ref pointers so spec/status interfaces get full types.
 */
export class KubernetesSource implements ResourceSource {
  readonly name = "kubernetes";
  private readonly _version: string;

  constructor(version: string) {
    this._version = version;
  }

  async load(): Promise<ResourceDefinition[]> {
    const url = `${CDK8S_SCHEMA_BASE}/${this._version}/_definitions.json`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch k8s schema for ${this._version}: ${response.status} ${response.statusText}. ` +
          `Check available versions at https://github.com/cdk8s-team/cdk8s/tree/master/kubernetes-schemas`,
      );
    }

    const raw = (await response.json()) as Record<string, unknown>;

    // Wrap definitions in a proper JSON Schema document so $RefParser can resolve internal refs
    const schemaDoc = {
      definitions: raw.definitions ?? raw.$defs ?? {},
    } as Record<string, unknown>;

    // Dereference all $ref pointers inline — this replaces {"$ref": "#/definitions/..."} with
    // the actual resolved schema objects. Circular refs are left as-is.
    const dereferenced = (await $RefParser.dereference(schemaDoc, {
      dereference: { circular: "ignore" },
    })) as { definitions: Record<string, JsonSchemaDefinition> };

    const defs: ResourceDefinition[] = [];

    for (const [, defSchema] of Object.entries(dereferenced.definitions)) {
      const gvks = defSchema["x-kubernetes-group-version-kind"];
      if (!gvks || gvks.length === 0) continue;

      for (const gvk of gvks) {
        const group = gvk.group || "core";
        const version = gvk.version;
        const kind = gvk.kind;

        if (!kind || !version) continue;
        if (kind.endsWith("List")) continue;

        const specSchema = defSchema.properties?.spec as SchemaProperty | undefined;
        const statusSchema = defSchema.properties?.status as SchemaProperty | undefined;

        // Capture top-level fields that aren't spec/status/metadata (e.g. Secret's data/stringData/type)
        const SKIP_KEYS = new Set(["apiVersion", "kind", "metadata", "spec", "status"]);
        const extraSchema: Record<string, SchemaProperty> = {};
        for (const [k, v] of Object.entries(defSchema.properties ?? {})) {
          if (!SKIP_KEYS.has(k)) extraSchema[k] = v as SchemaProperty;
        }

        defs.push({
          group,
          version,
          kind,
          plural: pluralize(kind),
          description:
            defSchema.description ?? `${kind} is a Kubernetes ${group}/${version} resource.`,
          specSchema,
          statusSchema,
          fullSpecSchema: specSchema,
          fullStatusSchema: statusSchema,
          extraSchema: Object.keys(extraSchema).length > 0 ? extraSchema : undefined,
        });
      }
    }

    return defs;
  }
}

interface GVK {
  group: string;
  version: string;
  kind: string;
}

interface JsonSchemaDefinition extends SchemaProperty {
  "x-kubernetes-group-version-kind"?: GVK[];
}

/** Naive pluralization for k8s kinds. */
function pluralize(kind: string): string {
  const lower = kind.toLowerCase();
  if (lower.endsWith("s")) return `${lower}es`;
  if (lower.endsWith("y")) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}
