/** Subset of OpenAPI v3 / JSON Schema used in CRD schemas. */
export interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  format?: string;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  additionalProperties?: SchemaProperty | boolean;
  required?: string[];
  /** x-kubernetes-preserve-unknown-fields */
  "x-kubernetes-preserve-unknown-fields"?: boolean;
}

/** Parsed resource definition from any source (CRD, k8s schema, OCI). */
export interface ResourceDefinition {
  /** Kubernetes API group, e.g. "ec2.aws.upbound.io" */
  group: string;
  /** API version, e.g. "v1beta1" */
  version: string;
  /** Kind name, e.g. "VPC" */
  kind: string;
  /** Plural form, e.g. "vpcs" */
  plural: string;
  /** Description of the resource */
  description?: string;
  /** Schema for spec.forProvider (or spec for k8s resources) */
  specSchema?: SchemaProperty;
  /** Schema for status.atProvider (or status for k8s resources) */
  statusSchema?: SchemaProperty;
  /** Full spec schema (including forProvider, initProvider, etc.) */
  fullSpecSchema?: SchemaProperty;
  /** Full status schema */
  fullStatusSchema?: SchemaProperty;
  /** True if this is a Crossplane provider resource (uses forProvider/atProvider) */
  crossplaneProvider?: boolean;
  /** Top-level fields that are not spec/status/metadata (e.g. Secret's data/stringData/type). */
  extraSchema?: Record<string, SchemaProperty>;
}

/** A source of resource definitions. */
export interface ResourceSource {
  readonly name: string;
  load(): Promise<ResourceDefinition[]>;
}
