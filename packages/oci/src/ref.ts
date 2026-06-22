/**
 * Parse an OCI reference into structured parts.
 *
 * Accepts:
 *   `registry.example.com/repo/name:tag`
 *   `registry.example.com/repo/name@sha256:...`
 *   `registry.example.com:5000/repo/name:tag`
 */
export function parseOciRef(ref: string): {
  registry: string;
  repository: string;
  reference: string;
} {
  const slashIdx = ref.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Invalid OCI reference "${ref}": missing registry`);
  }
  const registry = ref.slice(0, slashIdx);
  const rest = ref.slice(slashIdx + 1);

  const atIdx = rest.indexOf('@');
  if (atIdx !== -1) {
    return {
      registry,
      repository: rest.slice(0, atIdx),
      reference: rest.slice(atIdx + 1),
    };
  }
  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid OCI reference "${ref}": missing tag or digest`);
  }
  return {
    registry,
    repository: rest.slice(0, colonIdx),
    reference: rest.slice(colonIdx + 1),
  };
}
