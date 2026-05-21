import type { CompositionInput } from '@xplane/core';
import { Composition, Resource } from '@xplane/core';
import { describe, expect, it } from 'vitest';
import { createVmGlobals, evaluateCompositionModule } from '../loader/sandbox.js';

describe('createVmGlobals', () => {
  it('exposes Composition and Resource from host', () => {
    const globals = createVmGlobals();
    expect(globals.Composition).toBe(Composition);
    expect(globals.Resource).toBe(Resource);
  });

  it('exposes an exports object', () => {
    const globals = createVmGlobals();
    expect(globals.exports).toEqual({});
  });

  it('exposes standard JS builtins', () => {
    const globals = createVmGlobals();
    expect(globals.JSON).toBe(JSON);
    expect(globals.Math).toBe(Math);
    expect(globals.Map).toBe(Map);
    expect(globals.Promise).toBe(Promise);
    expect(globals.console).toBe(console);
  });
});

describe('evaluateCompositionModule', () => {
  const baseInput: CompositionInput = {
    xr: { spec: {}, status: {} },
    pipelineContext: {},
    observedComposed: {},
    observedRequired: {},
  };

  it('returns a module with a run function from exports.run', () => {
    const code = `
      class MyComp extends Composition {
        constructor() { super(); }
      }
      exports.run = (input) => runComposition(MyComp, input);
    `;
    const mod = evaluateCompositionModule(code);
    expect(typeof mod.run).toBe('function');
  });

  it('returns a module with a run function for direct run exports', () => {
    const code = `
      exports.run = function(input) { return { resources: [], externalResources: [], xrStatus: {}, diagnostics: [] }; };
    `;
    const mod = evaluateCompositionModule(code);
    expect(typeof mod.run).toBe('function');
    const result = mod.run(baseInput);
    expect(result.resources).toEqual([]);
  });

  it('produces resources when run', () => {
    const code = `
      class TestComp extends Composition {
        constructor() {
          super();
          new Resource(this, 'bucket', {
            apiVersion: 's3.aws.crossplane.io/v1beta1',
            kind: 'Bucket',
            spec: { forProvider: { region: 'us-east-1' } },
          });
        }
      }
      exports.run = (input) => runComposition(TestComp, input);
    `;
    const mod = evaluateCompositionModule(code);
    const result = mod.run(baseInput);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.name).toBe('bucket');
  });

  it('throws when code does not export a run function', () => {
    const code = `exports.something = 42;`;
    expect(() => evaluateCompositionModule(code)).toThrow("must export a 'run' function");
  });

  it('throws when code has a syntax error', () => {
    const code = `this is not valid javascript {{{`;
    expect(() => evaluateCompositionModule(code)).toThrow('Failed to evaluate composition code');
  });

  it('throws when code times out', () => {
    const code = `
      while(true) {}
      exports.run = () => ({});
    `;
    expect(() => evaluateCompositionModule(code)).toThrow('Failed to evaluate composition code');
  }, 10000);

  it('code can access XR via this.xr', () => {
    const code = `
      class XRComp extends Composition {
        constructor() {
          super();
          new Resource(this, 'vpc', {
            apiVersion: 'ec2.aws.crossplane.io/v1beta1',
            kind: 'VPC',
            spec: { forProvider: { region: this.xr.spec.region } },
          });
        }
      }
      exports.run = (input) => runComposition(XRComp, input);
    `;
    const mod = evaluateCompositionModule(code);
    const result = mod.run({
      ...baseInput,
      xr: { spec: { region: 'eu-west-1' }, status: {} },
    });
    expect(result.resources).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: document is Record<string, unknown>, deep access needs any
    expect((result.resources[0]!.document as Record<string, any>).spec.forProvider.region).toBe(
      'eu-west-1',
    );
  });

  it('uses provided filename in errors', () => {
    const code = `throw new Error('boom');`;
    expect(() => evaluateCompositionModule(code, 'my-comp.js')).toThrow(
      'Failed to evaluate composition code',
    );
  });
});
