import { describe, expect, it } from 'vitest';
import { Composition, Resource } from '../index.js';
import { computeRefKey } from '../resource.js';

describe('Resource.fromExistingByName', () => {
  it('creates an existing resource with isExisting=true', () => {
    const comp = new Composition();
    const project = Resource.fromExistingByName(comp, 'example.io/v1', 'Project', 'my-project');

    expect(project.isExisting).toBe(true);
    expect(project.apiVersion).toBe('example.io/v1');
    expect(project.kind).toBe('Project');
    expect(project.existingRef).toBeDefined();
    expect(project.existingRef!.refKey).toBe('example.io/v1/Project/my-project');
  });

  it('is not included in composition.resources', () => {
    const comp = new Composition();
    Resource.fromExistingByName(comp, 'example.io/v1', 'Project', 'my-project');
    new Resource(comp, 'bucket', {
      apiVersion: 's3.aws.crossplane.io/v1beta1',
      kind: 'Bucket',
      spec: {},
    });

    expect(comp.resources.size).toBe(1);
    expect([...comp.resources.values()][0]!.kind).toBe('Bucket');
  });

  it('is registered in composition.existingResources', () => {
    const comp = new Composition();
    Resource.fromExistingByName(comp, 'example.io/v1', 'Project', 'my-project');

    expect(comp.existingResources.size).toBe(1);
    expect(comp.existingResources.has('example.io/v1/Project/my-project')).toBe(true);
  });

  it('tracks dependencies when status fields are read', () => {
    const comp = new Composition();
    const project = Resource.fromExistingByName(comp, 'example.io/v1', 'Project', 'my-project');

    new Resource(comp, 'bucket', {
      apiVersion: 's3.aws.crossplane.io/v1beta1',
      kind: 'Bucket',
      spec: { forProvider: { bucketArn: project.status.bucketArn } },
    });

    const edges = comp.collector.edges;
    expect(edges.length).toBe(1);
    expect(edges[0]!.from.id).toContain('__existing__');
    expect(edges[0]!.fromPath).toBe('status.bucketArn');
    expect(edges[0]!.to.id).toBe('bucket');
    expect(edges[0]!.toPath).toBe('spec.forProvider.bucketArn');
  });

  it('tracks dependencies when root fields are read (e.g., Secret.data)', () => {
    const comp = new Composition();
    const secret = Resource.fromExistingByName(comp, 'v1', 'Secret', 'db-creds', 'default');

    new Resource(comp, 'connection', {
      apiVersion: 'example.io/v1',
      kind: 'Connection',
      spec: { password: secret.root.data.password },
    });

    const edges = comp.collector.edges;
    expect(edges.length).toBe(1);
    expect(edges[0]!.fromPath).toBe('data.password');
    expect(edges[0]!.toPath).toBe('spec.password');
  });

  it('tracks dependencies when spec fields are read (observed mode)', () => {
    const comp = new Composition();
    const project = Resource.fromExistingByName(comp, 'example.io/v1', 'Project', 'my-project');

    new Resource(comp, 'bucket', {
      apiVersion: 's3.aws.crossplane.io/v1beta1',
      kind: 'Bucket',
      spec: { forProvider: { region: project.spec.region } },
    });

    const edges = comp.collector.edges;
    expect(edges.length).toBe(1);
    expect(edges[0]!.fromPath).toBe('spec.region');
  });

  it('setObservedFull populates status, spec, and root targets', () => {
    const comp = new Composition();
    const project = Resource.fromExistingByName(comp, 'example.io/v1', 'Project', 'my-project');

    project.setObservedFull({
      apiVersion: 'example.io/v1',
      kind: 'Project',
      metadata: { name: 'my-project' },
      status: { bucketArn: 'arn:aws:s3:::my-bucket' },
      spec: { region: 'us-east-1' },
    });

    expect(project.observed).toBeDefined();
    expect(project.observed!.status!.bucketArn).toBe('arn:aws:s3:::my-bucket');
  });

  it('handles namespaced resources in refKey', () => {
    const comp = new Composition();
    const secret = Resource.fromExistingByName(comp, 'v1', 'Secret', 'my-secret', 'my-namespace');

    expect(secret.existingRef!.refKey).toBe('v1/Secret/my-namespace/my-secret');
  });

  it('handles unresolved dynamic names', () => {
    const comp = new Composition();
    const project = Resource.fromExistingByName(
      comp,
      'example.io/v1',
      'Project',
      comp.xr.spec.projectName,
    );

    // Name is a tracked proxy, not a string — refKey uses __unresolved__
    expect(project.existingRef!.refKey).toBe('example.io/v1/Project/__unresolved__');
  });
});

describe('computeRefKey', () => {
  it('generates correct key without namespace', () => {
    expect(computeRefKey('example.io/v1', 'Project', 'my-project')).toBe(
      'example.io/v1/Project/my-project',
    );
  });

  it('generates correct key with namespace', () => {
    expect(computeRefKey('v1', 'Secret', 'my-secret', 'default')).toBe(
      'v1/Secret/default/my-secret',
    );
  });

  it('generates __unresolved__ key when name is undefined', () => {
    expect(computeRefKey('v1', 'Secret', undefined)).toBe('v1/Secret/__unresolved__');
  });
});
