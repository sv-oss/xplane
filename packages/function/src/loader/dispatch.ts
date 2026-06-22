import type { Logger } from '@crossplane-org/function-sdk-typescript';
import type { CompositionModule } from '@xplane/core';

import { GitLoader } from './git.js';
import { InlineLoader } from './inline.js';
import { OciLoader } from './oci.js';
import type { CompositionLoader, FunctionInput, GitInput, InlineInput, OciInput } from './types.js';

const inlineLoader = new InlineLoader();
const gitLoader = new GitLoader();
const ociLoader = new OciLoader();

/**
 * Dispatches to the appropriate loader based on the `kind` field in the input.
 *
 * Expects Crossplane function input with:
 * - `apiVersion: xplane.io/v1alpha1`
 * - `kind: Inline` — delegates to InlineLoader
 * - `kind: Git` — delegates to GitLoader
 * - `kind: Oci` — delegates to OciLoader
 */
export class DispatchLoader implements CompositionLoader {
  readonly name = 'dispatch';

  async load(input: FunctionInput, logger?: Logger): Promise<CompositionModule> {
    const { kind } = input;

    switch (kind) {
      case 'Inline':
        return inlineLoader.load(input as InlineInput, logger);
      case 'Git':
        return gitLoader.load(input as GitInput, logger);
      case 'Oci':
        return ociLoader.load(input as OciInput, logger);
      default:
        throw new Error(
          `DispatchLoader: unsupported input kind "${String(kind)}". Expected "Inline", "Git", or "Oci"`,
        );
    }
  }
}
