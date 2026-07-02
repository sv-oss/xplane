import { AsyncLocalStorage } from 'node:async_hooks';
import type { ReadProxyMeta, ResourceRef } from './types.js';
import { PendingTemplate } from './types.js';

// ─── Token Registry ───────────────────────────────────────────────────────────

/**
 * Internal registry entry. When `value` is set, the token has a concrete
 * resolution captured at read time; `processStringValue` will inline it
 * directly. When absent, the slot stays pending until the resolve phase.
 */
interface TokenEntry extends ReadProxyMeta {
  readonly value?: string | number | boolean;
}

export interface TokenRegistry {
  readonly byToken: Map<string, TokenEntry>;
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
 *
 * When `value` is supplied, the registry remembers it so the substitution
 * pass can inline the concrete value while still recording the dependency
 * edge. Without a value, the slot remains pending and is resolved later
 * from observed state.
 *
 * Returns null when no registry is active (outside of a composition run).
 */
export function getOrCreateToken(
  owner: ResourceRef,
  path: string,
  value?: string | number | boolean,
): string | null {
  const registry = tokenRegistryStorage.getStore();
  if (!registry) return null;

  const key = `${owner.id}\0${path}`;
  const existing = registry.byKey.get(key);
  if (existing !== undefined) {
    // First write wins for value — later reads from observed state may
    // produce identical values; keeping the original avoids churn.
    return existing;
  }

  const token = `__pending__tpl_${registry.counter++}__`;
  const entry: TokenEntry = value === undefined ? { owner, path } : { owner, path, value };
  registry.byToken.set(token, entry);
  registry.byKey.set(key, token);
  return token;
}

export function lookupToken(token: string): ReadProxyMeta | undefined {
  return tokenRegistryStorage.getStore()?.byToken.get(token);
}

// ─── String Processing ────────────────────────────────────────────────────────

const TEMPLATE_TOKEN_RE = /__pending__tpl_\d+__/g;

/**
 * Scan a string for pending template tokens.
 *
 * For each registered token, `onSlot` is invoked so the caller can record
 * a dependency edge. Tokens whose registry entry carries a concrete value
 * are substituted inline; tokens without a value remain as slots in a
 * returned PendingTemplate.
 *
 * Returns the original string when no tokens are found, a plain string
 * when every token resolved to a concrete value, or a PendingTemplate
 * when any slot is still unresolved.
 */
export function processStringValue(
  value: string,
  onSlot: (meta: ReadProxyMeta) => void,
): PendingTemplate | string {
  const registry = tokenRegistryStorage.getStore();
  const parts: string[] = [];
  const slots: Array<{ source: ResourceRef; path: string }> = [];
  let buffer = '';
  let lastIndex = 0;
  let hasSlots = false;
  let hasPending = false;

  // Reset lastIndex before iterating (regex is stateful)
  TEMPLATE_TOKEN_RE.lastIndex = 0;

  for (const match of value.matchAll(TEMPLATE_TOKEN_RE)) {
    const entry = registry?.byToken.get(match[0]!);
    if (!entry) continue; // token not in registry — treat as literal

    hasSlots = true;
    const literal = value.slice(lastIndex, match.index!);
    onSlot(entry);

    if (entry.value !== undefined) {
      // Concrete value — inline it; do not emit a slot.
      buffer += literal + String(entry.value);
    } else {
      // Pending slot — flush buffered text as a part and record the slot.
      parts.push(buffer + literal);
      buffer = '';
      slots.push({ source: entry.owner, path: entry.path });
      hasPending = true;
    }
    lastIndex = match.index! + match[0]!.length;
  }

  if (!hasSlots) return value;

  const tail = value.slice(lastIndex);
  if (!hasPending) return buffer + tail;

  parts.push(buffer + tail);
  return new PendingTemplate(parts, slots);
}
