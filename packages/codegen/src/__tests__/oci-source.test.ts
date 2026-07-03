import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { Manifest, ManifestLayer } from '@xplane/oci';
import { OciRegistryClient } from '@xplane/oci';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OciSource } from '../sources/oci.js';

vi.mock('@xplane/oci', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    OciRegistryClient: vi.fn(),
  };
});

interface MockClient {
  getManifest: ReturnType<typeof vi.fn>;
  downloadBlob: ReturnType<typeof vi.fn>;
  fetchBlob: ReturnType<typeof vi.fn>;
}

let currentClient: MockClient;
let constructorOpts: Array<Record<string, unknown>>;
let blobBytes: Map<string, Buffer>;

const SCHEMA_JSON = JSON.stringify({
  description: 'A VPC resource.',
  type: 'object',
  properties: {
    apiVersion: { enum: ['ec2.aws.upbound.io/v1beta1'] },
    kind: { enum: ['VPC'] },
    spec: {
      type: 'object',
      properties: {
        forProvider: {
          type: 'object',
          required: ['region'],
          properties: { region: { type: 'string' } },
        },
      },
    },
    status: {
      type: 'object',
      properties: {
        atProvider: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  },
});

function makeSchemaTarball(files: Record<string, string>): Buffer {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-src-mktar-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const tarPath = path.join(tmp, 'out.tar');
  tar.c({ file: tarPath, cwd: tmp, sync: true }, Object.keys(files));
  const raw = fs.readFileSync(tarPath);
  fs.rmSync(tmp, { recursive: true, force: true });
  return zlib.gzipSync(raw);
}

function schemaLayer(bytes: Buffer): ManifestLayer & { annotations: Record<string, string> } {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  blobBytes.set(digest, bytes);
  return {
    mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
    size: bytes.length,
    digest,
    annotations: { 'io.crossplane.xpkg': 'schema.json' },
  };
}

function manifestOf(layers: ManifestLayer[]): Manifest {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.empty.v1+json',
      size: 2,
      digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    },
    layers,
  };
}

describe('OciSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructorOpts = [];
    blobBytes = new Map();
    currentClient = {
      getManifest: vi.fn(),
      downloadBlob: vi.fn(
        async ({ digest, targetPath }: { digest: string; targetPath: string }) => {
          const bytes = blobBytes.get(digest);
          if (!bytes) throw new Error(`test: no blob bytes registered for ${digest}`);
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, bytes);
        },
      ),
      fetchBlob: vi.fn(),
    };
    class MockClientCtor {
      getManifest = currentClient.getManifest;
      downloadBlob = currentClient.downloadBlob;
      fetchBlob = currentClient.fetchBlob;
      constructor(opts: unknown) {
        constructorOpts.push(opts as Record<string, unknown>);
      }
    }
    vi.mocked(OciRegistryClient).mockImplementation(MockClientCtor as never);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads resource definitions from a manifest', async () => {
    const tgz = makeSchemaTarball({ 'models/vpc.schema.json': SCHEMA_JSON });
    currentClient.getManifest.mockResolvedValue(manifestOf([schemaLayer(tgz)]));

    const source = new OciSource('xpkg.upbound.io/upbound/provider-aws-ec2:v1.0.0');
    const defs = await source.load();

    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      group: 'ec2.aws.upbound.io',
      version: 'v1beta1',
      kind: 'VPC',
      plural: 'vpcs',
      crossplaneProvider: true,
    });
    expect(constructorOpts[0]).toMatchObject({
      registry: 'xpkg.upbound.io',
      repository: 'upbound/provider-aws-ec2',
    });
    expect(currentClient.getManifest).toHaveBeenCalledWith({
      reference: 'v1.0.0',
      platform: 'linux/arm64',
    });
  });

  it('passes a custom platform through to the client', async () => {
    const tgz = makeSchemaTarball({ 'models/vpc.schema.json': SCHEMA_JSON });
    currentClient.getManifest.mockResolvedValue(manifestOf([schemaLayer(tgz)]));

    const source = new OciSource('reg.io/p/x:v1', undefined, 'linux/amd64');
    await source.load();

    expect(currentClient.getManifest).toHaveBeenCalledWith({
      reference: 'v1',
      platform: 'linux/amd64',
    });
  });

  it('forwards auth to the OciRegistryClient constructor', async () => {
    const tgz = makeSchemaTarball({ 'models/vpc.schema.json': SCHEMA_JSON });
    currentClient.getManifest.mockResolvedValue(manifestOf([schemaLayer(tgz)]));

    const source = new OciSource('reg.io/p/x:v1', undefined, 'linux/arm64', {
      type: 'bearer',
      token: 't0k',
    });
    await source.load();

    expect(constructorOpts[0]?.auth).toEqual({ type: 'bearer', token: 't0k' });
  });

  it('throws when the manifest has no schema.json layer', async () => {
    currentClient.getManifest.mockResolvedValue(
      manifestOf([
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          size: 0,
          digest: 'sha256:0',
        },
      ]),
    );

    const source = new OciSource('xpkg.upbound.io/p/x:v1');
    await expect(source.load()).rejects.toThrow('No schema.json layer found');
  });

  it('filters resource definitions by group', async () => {
    const otherSchema = JSON.stringify({
      type: 'object',
      properties: {
        apiVersion: { enum: ['s3.aws.upbound.io/v1beta1'] },
        kind: { enum: ['Bucket'] },
        spec: { type: 'object', properties: { forProvider: { type: 'object' } } },
      },
    });
    const tgz = makeSchemaTarball({
      'models/vpc.schema.json': SCHEMA_JSON,
      'models/bucket.schema.json': otherSchema,
    });
    currentClient.getManifest.mockResolvedValue(manifestOf([schemaLayer(tgz)]));

    const source = new OciSource('xpkg.upbound.io/p/x:v1', ['ec2']);
    const defs = await source.load();

    expect(defs.map((d) => d.kind)).toEqual(['VPC']);
  });

  it('filters resource definitions by wildcard group pattern', async () => {
    const mSchema = JSON.stringify({
      type: 'object',
      properties: {
        apiVersion: { enum: ['iam.aws.m.upbound.io/v1beta1'] },
        kind: { enum: ['Role'] },
        spec: { type: 'object', properties: { forProvider: { type: 'object' } } },
      },
    });
    const nonMSchema = JSON.stringify({
      type: 'object',
      properties: {
        apiVersion: { enum: ['iam.aws.upbound.io/v1beta1'] },
        kind: { enum: ['RolePolicy'] },
        spec: { type: 'object', properties: { forProvider: { type: 'object' } } },
      },
    });
    const tgz = makeSchemaTarball({
      'models/role.schema.json': mSchema,
      'models/rolepolicy.schema.json': nonMSchema,
    });
    currentClient.getManifest.mockResolvedValue(manifestOf([schemaLayer(tgz)]));

    const source = new OciSource('xpkg.upbound.io/p/x:v1', ['*.m.*']);
    const defs = await source.load();

    expect(defs.map((d) => d.group)).toEqual(['iam.aws.m.upbound.io']);
  });

  it('treats escaped wildcard patterns as wildcards', async () => {
    const mSchema = JSON.stringify({
      type: 'object',
      properties: {
        apiVersion: { enum: ['iam.aws.m.upbound.io/v1beta1'] },
        kind: { enum: ['Role'] },
        spec: { type: 'object', properties: { forProvider: { type: 'object' } } },
      },
    });
    const nonMSchema = JSON.stringify({
      type: 'object',
      properties: {
        apiVersion: { enum: ['iam.aws.upbound.io/v1beta1'] },
        kind: { enum: ['RolePolicy'] },
        spec: { type: 'object', properties: { forProvider: { type: 'object' } } },
      },
    });
    const tgz = makeSchemaTarball({
      'models/role.schema.json': mSchema,
      'models/rolepolicy.schema.json': nonMSchema,
    });
    currentClient.getManifest.mockResolvedValue(manifestOf([schemaLayer(tgz)]));

    const source = new OciSource('xpkg.upbound.io/p/x:v1', ['\\*.m.\\*']);
    const defs = await source.load();

    expect(defs.map((d) => d.group)).toEqual(['iam.aws.m.upbound.io']);
  });

  it('skips List and io-k8s-* files', async () => {
    const tgz = makeSchemaTarball({
      'models/vpc.schema.json': SCHEMA_JSON,
      'models/vpcList.schema.json': SCHEMA_JSON,
      'models/io-k8s-something.schema.json': SCHEMA_JSON,
    });
    currentClient.getManifest.mockResolvedValue(manifestOf([schemaLayer(tgz)]));

    const source = new OciSource('xpkg.upbound.io/p/x:v1');
    const defs = await source.load();
    expect(defs).toHaveLength(1);
  });

  it('parses references with digests (@sha256:...)', async () => {
    const tgz = makeSchemaTarball({ 'models/vpc.schema.json': SCHEMA_JSON });
    currentClient.getManifest.mockResolvedValue(manifestOf([schemaLayer(tgz)]));

    const source = new OciSource(
      'xpkg.upbound.io/p/x@sha256:abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
    );
    await source.load();

    expect(constructorOpts[0]).toMatchObject({
      registry: 'xpkg.upbound.io',
      repository: 'p/x',
    });
    expect(currentClient.getManifest).toHaveBeenCalledWith({
      reference: 'sha256:abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
      platform: 'linux/arm64',
    });
  });

  it('throws on invalid references', async () => {
    await expect(new OciSource('no-slash-ref').load()).rejects.toThrow('missing registry');
    await expect(new OciSource('reg.io/repo-no-tag').load()).rejects.toThrow(
      'missing tag or digest',
    );
  });

  it('surfaces getManifest errors from the client', async () => {
    currentClient.getManifest.mockRejectedValue(new Error('boom: 401'));
    const source = new OciSource('reg.io/p/x:v1');
    await expect(source.load()).rejects.toThrow('boom: 401');
  });
});
