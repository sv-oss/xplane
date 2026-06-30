import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../commands.js';

const widgetCrd = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.example.com
spec:
  group: example.com
  names:
    kind: Widget
    plural: widgets
  versions:
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
            status:
              type: object
              properties:
                ready:
                  type: boolean
`;

const projectXrd = `
apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata:
  name: projects.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: Project
    plural: projects
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                name:
                  type: string
            status:
              type: object
              properties:
                ready:
                  type: boolean
`;

function writeYaml(dir: string, filename: string, content: string): string {
  const path = join(dir, filename);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function makeTmpDirs(prefix: string): { sourceDir: string; outputDir: string } {
  const sourceDir = mkdtempSync(join(tmpdir(), `${prefix}-src-`));
  const outputDir = mkdtempSync(join(tmpdir(), `${prefix}-out-`));
  return { sourceDir, outputDir };
}

describe('xplane-codegen CLI', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe('generate-types-from crd', () => {
    it('writes a barrel index.ts by default', async () => {
      const { sourceDir, outputDir } = makeTmpDirs('codegen-cli-crd');
      writeYaml(sourceDir, 'widget.yaml', widgetCrd);

      await runCommand(main, {
        rawArgs: ['generate-types-from', 'crd', '--uri', sourceDir, '--output-dir', outputDir],
      });

      const files = readdirSync(outputDir);
      expect(files).toContain('index.ts');
      expect(files).toContain('example.com.v1.ts');

      const barrel = readFileSync(join(outputDir, 'index.ts'), 'utf-8');
      expect(barrel).toContain('export * as example_com_v1 from "./example.com.v1.js";');
    });

    it('skips the barrel index.ts when --no-barrel is set', async () => {
      const { sourceDir, outputDir } = makeTmpDirs('codegen-cli-crd-nobarrel');
      writeYaml(sourceDir, 'widget.yaml', widgetCrd);

      await runCommand(main, {
        rawArgs: [
          'generate-types-from',
          'crd',
          '--uri',
          sourceDir,
          '--output-dir',
          outputDir,
          '--no-barrel',
        ],
      });

      const files = readdirSync(outputDir);
      expect(files).not.toContain('index.ts');
      expect(files).toContain('example.com.v1.ts');
      expect(existsSync(join(outputDir, 'index.ts'))).toBe(false);
    });

    it('applies --readonly to generated interface properties', async () => {
      const { sourceDir, outputDir } = makeTmpDirs('codegen-cli-crd-readonly');
      writeYaml(sourceDir, 'widget.yaml', widgetCrd);

      await runCommand(main, {
        rawArgs: [
          'generate-types-from',
          'crd',
          '--uri',
          sourceDir,
          '--output-dir',
          outputDir,
          '--readonly',
        ],
      });

      const generated = readFileSync(join(outputDir, 'example.com.v1.ts'), 'utf-8');
      expect(generated).toContain('readonly name?:');
    });

    it('throws when no resource definitions are found', async () => {
      const { sourceDir, outputDir } = makeTmpDirs('codegen-cli-crd-empty');
      writeYaml(
        sourceDir,
        'not-a-crd.yaml',
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n',
      );

      await expect(
        runCommand(main, {
          rawArgs: ['generate-types-from', 'crd', '--uri', sourceDir, '--output-dir', outputDir],
        }),
      ).rejects.toThrow(/No resource definitions found/);
    });
  });

  describe('generate-types-from xrd', () => {
    it('writes a barrel index.ts by default', async () => {
      const { sourceDir, outputDir } = makeTmpDirs('codegen-cli-xrd');
      writeYaml(sourceDir, 'project.yaml', projectXrd);

      await runCommand(main, {
        rawArgs: ['generate-types-from', 'xrd', '--uri', sourceDir, '--output-dir', outputDir],
      });

      const files = readdirSync(outputDir);
      expect(files).toContain('index.ts');
      expect(files).toContain('platform.example.com.v1alpha1.ts');
    });

    it('skips the barrel index.ts when --no-barrel is set', async () => {
      const { sourceDir, outputDir } = makeTmpDirs('codegen-cli-xrd-nobarrel');
      writeYaml(sourceDir, 'project.yaml', projectXrd);

      await runCommand(main, {
        rawArgs: [
          'generate-types-from',
          'xrd',
          '--uri',
          sourceDir,
          '--output-dir',
          outputDir,
          '--no-barrel',
        ],
      });

      const files = readdirSync(outputDir);
      expect(files).not.toContain('index.ts');
      expect(files).toContain('platform.example.com.v1alpha1.ts');
    });
  });

  describe('generate-helm-from xrd', () => {
    it('writes one Helm chart per XRD', async () => {
      const { sourceDir, outputDir } = makeTmpDirs('codegen-cli-helm');
      writeYaml(sourceDir, 'project.yaml', projectXrd);

      await runCommand(main, {
        rawArgs: [
          'generate-helm-from',
          'xrd',
          '--uri',
          sourceDir,
          '--output-dir',
          outputDir,
          '--chart-version',
          '1.2.3',
        ],
      });

      const chartDirs = readdirSync(outputDir);
      expect(chartDirs).toHaveLength(1);
      const chartDir = join(outputDir, chartDirs[0]!);
      const chartYaml = readFileSync(join(chartDir, 'Chart.yaml'), 'utf-8');
      expect(chartYaml).toMatch(/version:\s*1\.2\.3/);
    });

    it('throws when no XRDs are found', async () => {
      const { sourceDir, outputDir } = makeTmpDirs('codegen-cli-helm-empty');
      writeYaml(
        sourceDir,
        'not-xrd.yaml',
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n',
      );

      await expect(
        runCommand(main, {
          rawArgs: ['generate-helm-from', 'xrd', '--uri', sourceDir, '--output-dir', outputDir],
        }),
      ).rejects.toThrow(/No resource definitions found/);
    });
  });
});
