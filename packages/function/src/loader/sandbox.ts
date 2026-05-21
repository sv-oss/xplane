import * as vm from 'node:vm';
import type { CompositionModule } from '@xplane/core';
import * as core from '@xplane/core';

/**
 * Globals injected into the VM context for thin bundles.
 *
 * Thin bundles rely on these globals instead of bundling @xplane/core.
 * Full bundles carry their own framework code and only need standard JS globals.
 */
export function createVmGlobals(): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const globals: Record<string, unknown> = {
    exports,

    // Core classes (for thin bundles via vmGlobals plugin)
    Composition: core.Composition,
    Resource: core.Resource,
    Construct: core.Construct,
    runComposition: core.runComposition,

    // Standard JS globals
    console,
    require,
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

  return globals;
}

/**
 * Evaluate a JavaScript string in a sandboxed VM context and extract
 * a CompositionModule (with a `run` function).
 *
 * The code must export `exports.run` — a function that takes CompositionInput
 * and returns CompositionResult. Thin bundles can use the sandbox-provided
 * `runComposition` global to wrap a class: `exports.run = (input) => runComposition(MyClass, input)`
 *
 * @param code - JavaScript source code (CJS format)
 * @param filename - Filename shown in stack traces
 * @returns A CompositionModule with a `run` function
 */
export function evaluateCompositionModule(
  code: string,
  filename = 'composition.js',
): CompositionModule {
  const globals = createVmGlobals();
  const context = vm.createContext(globals);

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

  if (typeof exports.run === 'function') {
    return { run: exports.run as CompositionModule['run'] };
  }

  throw new Error(
    "Composition code must export a 'run' function " +
      '(e.g. `exports.run = (input) => runComposition(MyClass, input)`)',
  );
}
