import * as vm from "node:vm";
import * as core from "@xplane/core";
import type { CompositionClass, CompositionLoader } from "./types.js";

/**
 * Globals injected into the inline code VM context.
 * These are the names available to users writing inline compositions.
 */
function createVmGlobals(): Record<string, unknown> {
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
 * Loads composition code from the `input.composite` field by evaluating it
 * in a Node.js VM context with @xplane/core globals available.
 *
 * The bundled code must follow the convention of exporting the composition
 * class under the name `composition`, analogous to Lambda's `index.handler`:
 *
 * ```typescript
 * class MyVpc extends Composition { ... }
 * export { MyVpc as composition };
 * ```
 *
 * The bundle script compiles this to CJS so the VM receives:
 * `exports.composition = MyVpc;`
 */
export class InlineLoader implements CompositionLoader {
  readonly name = "inline";

  load(input: Record<string, unknown>): CompositionClass {
    const code = input.composite;
    if (typeof code !== "string") {
      throw new Error("InlineLoader: input.composite must be a string containing JavaScript code");
    }

    if (code.trim().length === 0) {
      throw new Error("InlineLoader: input.composite is empty");
    }

    // Create a VM context with core globals and a CJS `exports` shim
    const globals = createVmGlobals();
    const context = vm.createContext(globals);

    // Execute the user's code in the sandboxed context.
    // Prepend a `var exports = {}` declaration so CJS output from rolldown
    // always has `exports` in scope — regardless of sandbox injection.
    // `var` at VM top-level sets a property on the context (global) object.
    const wrappedCode = `var exports = {};\n${code}`;
    try {
      vm.runInContext(wrappedCode, context, {
        filename: "composition.js",
        timeout: 5000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`InlineLoader: failed to evaluate composition code: ${message}`);
    }

    // Read the composition class from exports.composition (CJS convention)
    const exports = globals.exports as Record<string, unknown>;
    const compositionClass = exports.composition;
    if (typeof compositionClass !== "function") {
      throw new Error(
        "InlineLoader: composition code must export a class named 'composition' " +
          "(e.g. `export { MyClass as composition }`)",
      );
    }

    return compositionClass as CompositionClass;
  }
}
