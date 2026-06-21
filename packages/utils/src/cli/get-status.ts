import type { KubeConfig } from '@kubernetes/client-node';
import { type LoadKubeConfigOptions, loadKubeConfig } from '../client/kubeconfig.js';
import { listXrCollection } from '../client/lists.js';
import { parseTarget } from '../watcher/target.js';
import type { XrRef } from '../watcher/types.js';
import { resolveResource } from './discovery.js';

export type GetStatusFormat = 'dot' | 'json';

export interface GetStatusCommandArgs {
  target: string;
  namespace?: string;
  /**
   * Pre-built `KubeConfig`. When supplied, `kubeconfig` and `context` are
   * ignored (and rejected when used together) — the caller owns auth.
   */
  kubeConfig?: KubeConfig;
  kubeconfig?: string;
  context?: string;
  /** Output format. Defaults to "dot". */
  format?: GetStatusFormat;
  /** Pretty-print JSON output. Ignored for `dot`. Defaults to true. */
  pretty?: boolean;
  /** Include the framework-managed `status.xplane` subtree. Defaults to false. */
  includeXplane?: boolean;
  /** Include `status.conditions`. Defaults to false. */
  includeConditions?: boolean;
}

export interface GetStatusCommandDeps {
  loadKubeConfig?: (opts: LoadKubeConfigOptions) => KubeConfig;
  resolveResource?: typeof resolveResource;
  listXrCollection?: typeof listXrCollection;
  /** Destination stream for the rendered output. */
  out?: NodeJS.WritableStream;
}

export type GetStatusResult = { code: 0 } | { code: 1; error: string };

/**
 * Headless implementation of the `xplane-utils get-status` subcommand.
 * Fetches a single XR and prints its `.status` to `out` in the requested format.
 */
export async function runGetStatusCommand(
  args: GetStatusCommandArgs,
  deps: GetStatusCommandDeps = {},
): Promise<GetStatusResult> {
  const load = deps.loadKubeConfig ?? loadKubeConfig;
  const resolve = deps.resolveResource ?? resolveResource;
  const list = deps.listXrCollection ?? listXrCollection;
  const out = deps.out ?? process.stdout;

  let kc: KubeConfig;
  if (args.kubeConfig) {
    if (args.kubeconfig !== undefined || args.context !== undefined) {
      return {
        code: 1,
        error: 'pass either kubeConfig or kubeconfig+context, not both',
      };
    }
    kc = args.kubeConfig;
  } else {
    const kcOpts: LoadKubeConfigOptions = {};
    if (args.kubeconfig !== undefined) kcOpts.kubeconfig = args.kubeconfig;
    if (args.context !== undefined) kcOpts.context = args.context;
    kc = load(kcOpts);
  }

  const parsed = parseTarget(args.target);
  const resolved = await resolve(kc, {
    resource: parsed.resource,
    ...(parsed.group !== undefined ? { group: parsed.group } : {}),
    ...(parsed.version !== undefined ? { version: parsed.version } : {}),
  });
  const ref: XrRef = {
    group: resolved.group,
    version: resolved.version,
    plural: resolved.plural,
    kind: resolved.kind,
    namespaced: resolved.namespaced,
    name: parsed.name,
    ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
  };
  if (ref.namespaced && !ref.namespace) {
    return { code: 1, error: `${ref.kind} is namespaced — pass --namespace/-n` };
  }

  const result = await list(kc, ref);
  const item = result.items[0] as Record<string, unknown> | undefined;
  if (!item) {
    const target = `${ref.kind}/${ref.name}${ref.namespace ? ` -n ${ref.namespace}` : ''}`;
    return { code: 1, error: `${target} not found` };
  }
  const status = (item.status ?? {}) as Record<string, unknown>;
  const excluded = new Set<string>();
  if (!args.includeXplane) excluded.add('xplane');
  if (!args.includeConditions) excluded.add('conditions');
  const filtered =
    excluded.size === 0
      ? status
      : Object.fromEntries(Object.entries(status).filter(([k]) => !excluded.has(k)));

  const format: GetStatusFormat = args.format ?? 'dot';
  const text =
    format === 'json'
      ? JSON.stringify(filtered, null, args.pretty === false ? 0 : 2)
      : toDotLines(filtered).join('\n');
  out.write(text.length > 0 ? `${text}\n` : '');
  return { code: 0 };
}

/**
 * Flatten an arbitrary JSON value into `path=value` lines. Object keys are
 * joined with `.`; array indices use `[n]`. Leaf values are JSON-encoded so
 * strings retain their quoting and special characters are preserved.
 */
export function toDotLines(value: unknown, prefix = ''): string[] {
  if (value === undefined) return [];
  if (value === null) return [`${prefix || '.'}=null`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix || '.'}=[]`];
    return value.flatMap((v, i) => toDotLines(v, `${prefix}[${i}]`));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${prefix || '.'}={}`];
    return entries.flatMap(([k, v]) => toDotLines(v, prefix ? `${prefix}.${k}` : k));
  }
  return [`${prefix || '.'}=${JSON.stringify(value)}`];
}
