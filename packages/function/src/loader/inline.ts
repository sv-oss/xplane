import { evaluateCompositionCode } from "./sandbox.js";
import type { CompositionClass, CompositionLoader, InlineInput } from "./types.js";

/**
 * Loads composition code from `input.spec.code` by evaluating it
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

  async load(input: InlineInput): Promise<CompositionClass> {
    const spec = input.spec;
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      throw new Error("InlineLoader: input.spec must be an object");
    }
    const { code } = spec;
    if (typeof code !== "string") {
      throw new Error("InlineLoader: input.spec.code must be a string containing JavaScript code");
    }

    if (code.trim().length === 0) {
      throw new Error("InlineLoader: input.spec.code is empty");
    }

    return evaluateCompositionCode(code);
  }
}
