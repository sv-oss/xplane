import * as vm from 'node:vm';
import * as core from '@xplane/core';
import type { CompositionClass } from './types.js';

/**
 * Globals injected into the inline code VM context.
 * These are the names available to users writing inline compositions.
 */
export function createVmGlobals(): Record<string, unknown> {
  // CJS shim: the bundled code assigns `exports.composition = MyClass`
  const exports: Record<string, unknown> = {};
  return {
    exports,

    // Core classes
    Composition: core.Composition,
    Construct: core.Construct,
    Resource: core.Resource,

    // Utilities
    console,
    JSON,
    Math,
    Date,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Error,
    TypeError,
    RangeError,
    Promise,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    atob,
    btoa,
  };
}

/**
 * Evaluate a JavaScript string in a sandboxed VM context and extract the
 * exported `composition` class.
 *
 * @param code - JavaScript source code (CJS format)
 * @param filename - Filename shown in stack traces
 * @returns The composition class constructor
 */
export function evaluateCompositionCode(
  code: string,
  filename = 'composition.js',
): CompositionClass {
  const globals = createVmGlobals();
  const context = vm.createContext(globals);

  // Prepend a `var exports = {}` declaration so CJS output from rolldown
  // always has `exports` in scope — regardless of sandbox injection.
  const wrappedCode = `var exports = {};\n${code}`;
  try {
    vm.runInContext(wrappedCode, context, {
      filename,
      timeout: 5000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to evaluate composition code: ${message}`);
  }

  const exports = globals.exports as Record<string, unknown>;
  const compositionClass = exports.composition;
  if (typeof compositionClass !== 'function') {
    throw new Error(
      "Composition code must export a class named 'composition' " +
        '(e.g. `export { MyClass as composition }`)',
    );
  }

  return compositionClass as CompositionClass;
}
