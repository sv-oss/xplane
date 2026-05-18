import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { XrdSource } from '../sources/xrd.js';

function writeXrd(dir: string, filename: string, content: string): string {
  const path = join(dir, filename);
  writeFileSync(path, content, 'utf-8');
  return path;
}

const projectXrd = `
apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata:
  name: projects.sdp.platform.vic.gov.au
spec:
  group: sdp.platform.vic.gov.au
  names:
    kind: Project
    plural: projects
  versions:
    - name: v1alpha1
      referenceable: true
      served: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required:
                - aws
              properties:
                aws:
                  description: AWS configuration for cross-account access.
                  type: object
                  required:
                    - accountId
                  properties:
                    accountId:
                      description: AWS account ID for cross-account access.
                      type: string
                    region:
                      default: ap-southeast-2
                      description: AWS region for resources.
                      type: string
            status:
              type: object
              properties:
                ready:
                  type: boolean
                  description: Whether the project is ready.
`;

const multiVersionXrd = `
apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata:
  name: databases.infra.example.com
spec:
  group: infra.example.com
  names:
    kind: Database
    plural: databases
  versions:
    - name: v1alpha1
      served: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                engine:
                  type: string
                  enum: [postgres, mysql]
            status:
              type: object
              properties:
                endpoint:
                  type: string
    - name: v1beta1
      served: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required:
                - engine
              properties:
                engine:
                  type: string
                  enum: [postgres, mysql, mariadb]
                size:
                  type: string
            status:
              type: object
              properties:
                endpoint:
                  type: string
                state:
                  type: string
`;

describe('XrdSource', () => {
  it('parses a CompositeResourceDefinition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-xrd-test-'));
    writeXrd(dir, 'project.yaml', projectXrd);

    const source = new XrdSource([dir]);
    const defs = await source.load();

    expect(defs).toHaveLength(1);
    const project = defs[0]!;
    expect(project.group).toBe('sdp.platform.vic.gov.au');
    expect(project.version).toBe('v1alpha1');
    expect(project.kind).toBe('Project');
    expect(project.plural).toBe('projects');
    expect(project.specSchema?.properties?.aws?.description).toBe(
      'AWS configuration for cross-account access.',
    );
    expect(project.specSchema?.required).toEqual(['aws']);
    expect(project.statusSchema?.properties?.ready).toEqual({
      type: 'boolean',
      description: 'Whether the project is ready.',
    });
  });

  it('does not unwrap forProvider/atProvider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-xrd-test-'));
    writeXrd(dir, 'project.yaml', projectXrd);

    const source = new XrdSource([dir]);
    const defs = await source.load();

    expect(defs[0]!.crossplaneProvider).toBeUndefined();
    expect(defs[0]!.fullSpecSchema).toBeUndefined();
  });

  it('handles multiple versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-xrd-test-'));
    writeXrd(dir, 'database.yaml', multiVersionXrd);

    const source = new XrdSource([dir]);
    const defs = await source.load();

    expect(defs).toHaveLength(2);
    expect(defs[0]!.version).toBe('v1alpha1');
    expect(defs[1]!.version).toBe('v1beta1');
    expect(defs[1]!.specSchema?.properties?.size).toEqual({ type: 'string' });
  });

  it('skips non-XRD documents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-xrd-test-'));
    writeXrd(dir, 'not-xrd.yaml', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n');

    const source = new XrdSource([dir]);
    const defs = await source.load();

    expect(defs).toHaveLength(0);
  });

  it('skips versions that are not served', async () => {
    const xrd = `
apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata:
  name: things.test.io
spec:
  group: test.io
  names:
    kind: Thing
    plural: things
  versions:
    - name: v1alpha1
      served: false
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                name:
                  type: string
    - name: v1
      served: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                name:
                  type: string
`;
    const dir = mkdtempSync(join(tmpdir(), 'codegen-xrd-test-'));
    writeXrd(dir, 'thing.yaml', xrd);

    const source = new XrdSource([dir]);
    const defs = await source.load();

    expect(defs).toHaveLength(1);
    expect(defs[0]!.version).toBe('v1');
  });

  it('handles multi-document YAML', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-xrd-test-'));
    writeXrd(dir, 'multi.yaml', `${projectXrd}\n---\n${multiVersionXrd}`);

    const source = new XrdSource([dir]);
    const defs = await source.load();

    expect(defs).toHaveLength(3);
  });

  it('accepts file:// URIs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-xrd-test-'));
    const file = writeXrd(dir, 'project.yaml', projectXrd);

    const source = new XrdSource([`file://${file}`]);
    const defs = await source.load();

    expect(defs).toHaveLength(1);
    expect(defs[0]!.kind).toBe('Project');
  });
});
