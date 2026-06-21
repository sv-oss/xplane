import { describe, expect, it, vi } from 'vitest';

const loadFromFile = vi.fn();
const loadFromDefault = vi.fn();
const setCurrentContext = vi.fn();

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromFile = loadFromFile;
    loadFromDefault = loadFromDefault;
    setCurrentContext = setCurrentContext;
  },
}));

const { loadKubeConfig } = await import('../client/kubeconfig.js');

describe('loadKubeConfig', () => {
  it('loads from default when no path is given', () => {
    loadFromDefault.mockClear();
    loadFromFile.mockClear();
    setCurrentContext.mockClear();
    loadKubeConfig();
    expect(loadFromDefault).toHaveBeenCalled();
    expect(loadFromFile).not.toHaveBeenCalled();
    expect(setCurrentContext).not.toHaveBeenCalled();
  });

  it('loads from explicit path and switches context', () => {
    loadFromDefault.mockClear();
    loadFromFile.mockClear();
    setCurrentContext.mockClear();
    loadKubeConfig({ kubeconfig: '/tmp/kc', context: 'staging' });
    expect(loadFromFile).toHaveBeenCalledWith('/tmp/kc');
    expect(loadFromDefault).not.toHaveBeenCalled();
    expect(setCurrentContext).toHaveBeenCalledWith('staging');
  });
});
