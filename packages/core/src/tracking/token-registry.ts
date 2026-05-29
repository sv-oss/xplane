import { AsyncLocalStorage } from 'node:async_hooks';
import type { ReadProxyMeta, ResourceRef } from './types.js';
import { PendingTemplate } from './types.js';

// ─── Token Registry ───────────────────────────────────────────────────────────

export interface TokenRegistry {
  readonly byToken: Map<string, ReadProxyMeta>;
  readonly byKey: Map<string, string>;
  counter: number;
}

/**
 * Per-run AsyncLocalStorage for the template-literal token registry.
 * Kept separate from compositionStorage (core/) to avoid circular deps.
 */
export const tokenRegistryStorage = new AsyncLocalStorage<TokenRegistry>();

export function createTokenRegistry(): TokenRegistry {
  return { byToken: new Map(), byKey: new Map(), counter: 0 };
}

/**
 * Get or create a stable token for a given (owner, path) pair.
 * Returns null when no registry is active (outside of a composition run).
 */
export function getOrCreateToken(owner: ResourceRef, path: string): string | null {
  const registry = tokenRegistryStorage.getStore();
  if (!registry) return null;

  const key = `${owner.id}\0${path}`;
  const existing = registry.byKey.get(key);
  if (existing !== undefined) return existing;

  const token = `__pending__tpl_${registry.counter++}__`;
  registry.byToken.set(token, { owner, path });
  registry.byKey.set(key, token);
  return token;
}

export function lookupToken(token: string): ReadProxyMeta | undefined {
  return tokenRegistryStorage.getStore()?.byToken.get(token);
}

// ─── String Processing ────────────────────────────────────────────────────────

const TEMPLATE_TOKEN_RE = /__pending__tpl_\d+__/g;

/**
 * Scan a string for pending template tokens. If any are found, calls
 * `onSlot` for each registered token and returns a PendingTemplate.
 * Returns the original string if no tokens are found or none are registered.
 */
export function processStringValue(
  value: string,
  onSlot: (meta: ReadProxyMeta) => void,
): PendingTemplate | string {
  const parts: string[] = [];
  const slots: Array<{ source: ResourceRef; path: string }> = [];
  let lastIndex = 0;
  let hasSlots = false;

  // Reset lastIndex before iterating (regex is stateful)
  TEMPLATE_TOKEN_RE.lastIndex = 0;

  for (const match of value.matchAll(TEMPLATE_TOKEN_RE)) {
    const meta = lookupToken(match[0]!);
    if (!meta) continue; // token not in registry — treat as literal

    hasSlots = true;
    parts.push(value.slice(lastIndex, match.index!));
    slots.push({ source: meta.owner, path: meta.path });
    onSlot(meta);
    lastIndex = match.index! + match[0]!.length;
  }

  if (!hasSlots) return value;

  parts.push(value.slice(lastIndex));
  return new PendingTemplate(parts, slots);
}
