import { Composition, Resource } from '@xplane/core';
import { describe, expect, it } from 'vitest';
import { Simulator } from '../index.js';

class ProjectEnvironmentComposition extends Composition {
  constructor() {
    super();

    const project = Resource.fromExistingByName(
      this,
      'example.io/v1',
      'Project',
      // biome-ignore lint/suspicious/noExplicitAny: Resource proxy allows deep chaining at runtime
      (this.xr as any).spec.projectName,
    );

    new Resource(this, 'env-bucket', {
      apiVersion: 's3.aws.crossplane.io/v1beta1',
      kind: 'Bucket',
      spec: {
        forProvider: {
          region: 'us-east-1',
          // biome-ignore lint/suspicious/noExplicitAny: Resource proxy allows deep chaining at runtime
          tags: { projectBucket: (project as any).status.bucketArn },
        },
      },
    });
  }
}

class SecretReaderComposition extends Composition {
  constructor() {
    super();

    const secret = Resource.fromExistingByName(this, 'v1', 'Secret', 'db-creds', 'default');

    new Resource(this, 'connection', {
      apiVersion: 'example.io/v1',
      kind: 'Connection',
      // biome-ignore lint/suspicious/noExplicitAny: Resource proxy allows deep chaining at runtime
      spec: { password: (secret as any).data.password },
    });
  }
}

describe('Simulator.withExisting', () => {
  it('resolves fields from an existing resource via status proxy', () => {
    const result = Simulator.synthesize(ProjectEnvironmentComposition, {
      xr: { spec: { projectName: 'my-project' } },
    })
      .withExisting({
        'example.io/v1/Project/my-project': {
          apiVersion: 'example.io/v1',
          kind: 'Project',
          metadata: { name: 'my-project' },
          status: { bucketArn: 'arn:aws:s3:::my-project-bucket' },
        },
      })
      .run();

    result.emitted.resourceCountIs('s3.aws.crossplane.io/v1beta1', 'Bucket', 1);
    result.emitted.hasResourceSpec('s3.aws.crossplane.io/v1beta1', 'Bucket', {
      forProvider: {
        region: 'us-east-1',
        tags: { projectBucket: 'arn:aws:s3:::my-project-bucket' },
      },
    });
    expect(result.conditions).toHaveLength(0);
  });

  it('blocks when existing resource is not available', () => {
    const result = Simulator.synthesize(ProjectEnvironmentComposition, {
      xr: { spec: { projectName: 'my-project' } },
    })
      .withExisting({})
      .run();

    result.blocked.resourceCountIs('s3.aws.crossplane.io/v1beta1', 'Bucket', 1);
    expect(result.conditions).toContainEqual(
      expect.objectContaining({
        type: 'Ready',
        status: 'False',
        reason: 'MissingRequiredResource',
      }),
    );
  });

  it('resolves arbitrary top-level fields via root proxy (Secret .data)', () => {
    const result = Simulator.synthesize(SecretReaderComposition)
      .withExisting({
        'v1/Secret/default/db-creds': {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'db-creds', namespace: 'default' },
          data: { password: 'c2VjcmV0' },
        },
      })
      .run();

    result.emitted.resourceCountIs('example.io/v1', 'Connection', 1);
    result.emitted.hasResourceSpec('example.io/v1', 'Connection', {
      password: 'c2VjcmV0',
    });
    expect(result.conditions).toHaveLength(0);
  });

  it('works without withExisting() call (no existing resources)', () => {
    class SimpleComposition extends Composition {
      constructor() {
        super();
        new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          spec: { forProvider: { region: 'us-east-1' } },
        });
      }
    }

    const result = Simulator.synthesize(SimpleComposition).run();
    result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'VPC', 1);
    expect(result.conditions).toHaveLength(0);
  });
});
