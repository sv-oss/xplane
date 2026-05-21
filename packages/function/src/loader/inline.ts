import type { CompositionModule } from '@xplane/core';

import { evaluateCompositionModule } from './sandbox.js';
import type { CompositionLoader, InlineInput } from './types.js';

/**
 * Loads composition code from `input.spec.code` by evaluating it
 * in a Node.js VM context.
 *
 * The code must export `exports.run` — a function that takes CompositionInput
 * and returns CompositionResult.
 */
export class InlineLoader implements CompositionLoader {
  readonly name = 'inline';

  async load(input: InlineInput): Promise<CompositionModule> {
    const spec = input.spec;
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new Error('InlineLoader: input.spec must be an object');
    }
    const { code } = spec;
    if (typeof code !== 'string') {
      throw new Error('InlineLoader: input.spec.code must be a string containing JavaScript code');
    }

    if (code.trim().length === 0) {
      throw new Error('InlineLoader: input.spec.code is empty');
    }

    return evaluateCompositionModule(code);
  }
}
