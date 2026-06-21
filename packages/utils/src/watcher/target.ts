/**
 * Parse a kubectl-style resource target of the form:
 *   <resource>/<name>
 * where `<resource>` is one of:
 *   - `kind` (e.g. `xprojects`, `XProject`)
 *   - `kind.group` (e.g. `xprojects.platform.example.com`)
 *   - `kind.version.group` (e.g. `xprojects.v1alpha1.platform.example.com`)
 *
 * The `kind` token is returned as-is; resolving it to an API group/version/plural
 * is the discovery layer's responsibility (see `client/discovery.ts`).
 */
export interface ParsedTarget {
  /** Resource hint: kind, plural, or short name as typed by the user. */
  resource: string;
  /** Optional API group hint extracted from `kind.group` or `kind.version.group`. */
  group?: string;
  /** Optional API version hint extracted from `kind.version.group`. */
  version?: string;
  /** Object name. */
  name: string;
}

export function parseTarget(input: string): ParsedTarget {
  const slash = input.indexOf('/');
  if (slash < 0) {
    throw new Error(
      `Invalid target "${input}": expected kubectl-style "<resource>/<name>" (e.g. "xprojects/foo" or "xprojects.platform.example.com/foo").`,
    );
  }
  const left = input.slice(0, slash);
  const name = input.slice(slash + 1);
  if (left.length === 0 || name.length === 0) {
    throw new Error(`Invalid target "${input}": both resource and name are required.`);
  }

  const dot = left.indexOf('.');
  if (dot < 0) return { resource: left, name };

  const resource = left.slice(0, dot);
  const rest = left.slice(dot + 1);

  // Heuristic: a Kubernetes API version token starts with `v` followed by a digit
  // (`v1`, `v1alpha1`, `v2beta3`). If the first segment of `rest` matches, treat
  // it as the version and the remainder as the group.
  const restDot = rest.indexOf('.');
  if (restDot > 0) {
    const maybeVersion = rest.slice(0, restDot);
    if (/^v\d/.test(maybeVersion)) {
      return { resource, version: maybeVersion, group: rest.slice(restDot + 1), name };
    }
  }
  return { resource, group: rest, name };
}
