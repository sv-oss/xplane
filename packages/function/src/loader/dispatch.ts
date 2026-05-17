import { GitLoader } from './git.js';
import { InlineLoader } from './inline.js';
import type {
  CompositionClass,
  CompositionLoader,
  FunctionInput,
  GitInput,
  InlineInput,
} from './types.js';

const inlineLoader = new InlineLoader();
const gitLoader = new GitLoader();

/**
 * Dispatches to the appropriate loader based on the `kind` field in the input.
 *
 * Expects Crossplane function input with:
 * - `apiVersion: xplane.io/v1alpha1`
 * - `kind: Inline` — delegates to InlineLoader
 * - `kind: Git` — delegates to GitLoader
 */
export class DispatchLoader implements CompositionLoader {
  readonly name = 'dispatch';

  async load(input: FunctionInput): Promise<CompositionClass> {
    const { kind } = input;

    switch (kind) {
      case 'Inline':
        return inlineLoader.load(input as InlineInput);
      case 'Git':
        return gitLoader.load(input as GitInput);
      default:
        throw new Error(
          `DispatchLoader: unsupported input kind "${String(kind)}". Expected "Inline" or "Git"`,
        );
    }
  }
}
