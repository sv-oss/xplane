import { SYNTHETIC_ANNOTATION_KEY, SYNTHETIC_USAGE_VALUE } from '@xplane/core';

/**
 * Returns true when the given desired document is a framework-synthesized
 * Crossplane `Usage` / `ClusterUsage` doc (identified by the synthetic
 * annotation stamped by `@xplane/core`'s usage emitter).
 */
export function isSyntheticUsageDoc(doc: Record<string, unknown>): boolean {
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const annotations = (metadata as Record<string, unknown>).annotations;
  if (!annotations || typeof annotations !== 'object') return false;
  return (
    (annotations as Record<string, unknown>)[SYNTHETIC_ANNOTATION_KEY] === SYNTHETIC_USAGE_VALUE
  );
}
