import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceDefinition, ResourceSource, SchemaProperty } from "../schema/index.js";

/**
 * Loads resource definitions from a Crossplane OCI provider package.
 * Uses `crane manifest` to find the schema.json blob, then `crane blob` to download it.
 * Requires `crane` CLI on PATH.
 */
export class OciSource implements ResourceSource {
	readonly name = "oci";
	private readonly _ref: string;
	private readonly _groups: string[] | undefined;
	private readonly _platform: string;

	constructor(ref: string, groups?: string[], platform = "linux/arm64") {
		this._ref = ref;
		this._groups = groups;
		this._platform = platform;
	}

	async load(): Promise<ResourceDefinition[]> {
		assertCrane();

		// 1. Get manifest and find the schema.json blob digest
		const manifestJson = execFileSync(
			"crane",
			["manifest", this._ref, "--platform", this._platform],
			{ encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
		);
		const manifest = JSON.parse(manifestJson) as OciManifest;
		const schemaLayer = manifest.layers?.find(
			(l) => l.annotations?.["io.crossplane.xpkg"] === "schema.json",
		);
		if (!schemaLayer) {
			throw new Error(
				`No schema.json layer found in manifest for ${this._ref}. ` +
					"Ensure this is a Crossplane provider package with embedded JSON schemas.",
			);
		}

		// 2. Download and extract the schema blob (tgz of models/*.schema.json)
		const tmpDir = mkdtempSync(join(tmpdir(), "xplane-oci-"));
		try {
			execFileSync(
				"sh",
				["-c", `crane blob "${this._ref}@${schemaLayer.digest}" | tar xz -C "${tmpDir}"`],
				{ stdio: ["pipe", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 },
			);

			// 3. Parse each non-List resource schema
			const modelsDir = join(tmpDir, "models");
			const defs: ResourceDefinition[] = [];

			for (const file of readdirSync(modelsDir)) {
				if (!file.endsWith(".schema.json")) continue;
				// Skip List types and k8s meta types
				if (file.includes("List.schema.json")) continue;
				if (file.startsWith("io-k8s-")) continue;

				try {
					const content = readFileSync(join(modelsDir, file), "utf-8");
					const schema = JSON.parse(content) as SchemaProperty;
					const def = extractFromJsonSchema(schema);
					if (!def) continue;

					if (this._groups && !this._groups.some((g) => def.group.includes(g))) {
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
}

interface OciManifest {
	layers?: Array<{
		digest: string;
		size: number;
		mediaType: string;
		annotations?: Record<string, string>;
	}>;
}

function assertCrane(): void {
	try {
		execFileSync("crane", ["version"], { stdio: "pipe" });
	} catch {
		throw new Error(
			"crane CLI not found on PATH. Install from https://github.com/google/go-containerregistry/tree/main/cmd/crane",
		);
	}
}

/**
 * Extract a ResourceDefinition from a Crossplane provider JSON schema file.
 * These schemas have apiVersion/kind as enum values and spec.forProvider / status.atProvider.
 */
function extractFromJsonSchema(schema: SchemaProperty): ResourceDefinition | undefined {
	const props = schema.properties;
	if (!props) return undefined;

	// Extract apiVersion and kind from enum defaults
	const apiVersion = props.apiVersion?.enum?.[0] ?? props.apiVersion?.default;
	const kind = props.kind?.enum?.[0] ?? props.kind?.default;
	if (typeof apiVersion !== "string" || typeof kind !== "string") return undefined;

	// Parse group/version from apiVersion
	const slashIdx = apiVersion.indexOf("/");
	if (slashIdx === -1) return undefined;
	const group = apiVersion.slice(0, slashIdx);
	const version = apiVersion.slice(slashIdx + 1);

	// Derive plural from filename convention or fall back to lowercased kind + "s"
	const plural = `${kind.toLowerCase()}s`;

	const specProps = props.spec as SchemaProperty | undefined;
	const statusProps = props.status as SchemaProperty | undefined;

	const forProvider = specProps?.properties?.forProvider as SchemaProperty | undefined;
	const atProvider = statusProps?.properties?.atProvider as SchemaProperty | undefined;

	// Extract required fields from forProvider
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
	};
}
