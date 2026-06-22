import type { Logger } from '@crossplane-org/function-sdk-typescript';
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

  async load(input: InlineInput, logger?: Logger): Promise<CompositionModule> {
    const log = logger?.child({ loader: this.name });
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

    log?.debug({ codeLength: code.length }, 'Evaluating inline composition code');
    const mod = evaluateCompositionModule(code);
    log?.debug('Inline composition loaded');
    return mod;
  }
}
