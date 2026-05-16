import { describe, expect, it } from "vitest";
import type { KubernetesResource } from "../../core/resource.js";
import { getReadyCondition, isResourceReady } from "../auto-ready.js";

describe("isResourceReady", () => {
	it("returns false for undefined", () => {
		expect(isResourceReady(undefined)).toBe(false);
	});

	it("returns true for resource with no status (e.g. Namespace, ProviderConfig)", () => {
		const resource: KubernetesResource = {
			apiVersion: "v1",
			kind: "Namespace",
		};
		expect(isResourceReady(resource)).toBe(true);
	});

	it("returns true for resource with no conditions (e.g. ProviderConfig)", () => {
		const resource: KubernetesResource = {
			apiVersion: "v1",
			kind: "ProviderConfig",
			status: { users: 1 },
		};
		expect(isResourceReady(resource)).toBe(true);
	});

	it("returns false for Ready=False", () => {
		const resource: KubernetesResource = {
			apiVersion: "v1",
			kind: "ConfigMap",
			status: {
				conditions: [{ type: "Ready", status: "False", reason: "Creating" }],
			},
		};
		expect(isResourceReady(resource)).toBe(false);
	});

	it("returns true for Ready=True", () => {
		const resource: KubernetesResource = {
			apiVersion: "v1",
			kind: "ConfigMap",
			status: {
				conditions: [
					{ type: "Synced", status: "True" },
					{ type: "Ready", status: "True" },
				],
			},
		};
		expect(isResourceReady(resource)).toBe(true);
	});
});

describe("getReadyCondition", () => {
	it("returns the Ready condition", () => {
		const resource: KubernetesResource = {
			apiVersion: "v1",
			kind: "ConfigMap",
			status: {
				conditions: [
					{ type: "Synced", status: "True" },
					{
						type: "Ready",
						status: "False",
						reason: "Creating",
						message: "Resource is being created",
					},
				],
			},
		};

		const condition = getReadyCondition(resource);
		expect(condition?.type).toBe("Ready");
		expect(condition?.status).toBe("False");
		expect(condition?.reason).toBe("Creating");
	});

	it("returns undefined when no Ready condition exists", () => {
		const resource: KubernetesResource = {
			apiVersion: "v1",
			kind: "ConfigMap",
			status: {
				conditions: [{ type: "Synced", status: "True" }],
			},
		};

		expect(getReadyCondition(resource)).toBeUndefined();
	});
});
