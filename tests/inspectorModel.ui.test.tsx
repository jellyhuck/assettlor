// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AppSettings } from '../shared/types.js';
import { act, mountReact } from '../client/tests/reactDomHarness.js';
import { Inspector } from '../client/src/components/Inspector.js';
import { ToastProvider } from '../client/src/components/ToastProvider.js';

vi.mock('../client/src/components/ModelViewer.tsx', () => ({
  default: ({ asset, revision }: { asset: Asset; revision?: number }) =>
    <div data-testid="model-viewer">Viewer for {asset.name} at revision {revision}</div>,
}));

const settings: AppSettings = {
  libraryPath: '/tmp/library', libraryPaths: ['/tmp/library'], activeProjectPath: '',
  projectPaths: [], thumbnailQuality: 80, autoStackAnimations: true,
  autoStackAudio: true, defaultFps: 12, catalogPaging: 'load-more',
};

function model(metadata: Asset['metadata']): Asset {
  return {
    id: 'crate', name: 'crate.glb', path: 'props/crate.glb', absolutePath: '/tmp/library/props/crate.glb',
    extension: '.glb', category: 'model', size: 2048, mtime: 1, hash: 'h',
    isArchiveEntry: false, thumbnailUrl: '/thumb/crate', fileUrl: '/file/crate',
    metadata, tags: [], createdAt: 1, updatedAt: 1,
  };
}

const render = (asset: Asset) => (
  <ToastProvider>
    <Inspector item={asset} revision={3} settings={settings} onClose={() => {}}
      initialViewMode="assets" availableTags={[]} />
  </ToastProvider>
);

function rowValue(container: HTMLElement, label: string): string | undefined {
  const row = [...container.querySelectorAll('div')].find((candidate) =>
    candidate.firstElementChild?.textContent === label && candidate.children.length === 2);
  return row?.lastElementChild?.textContent ?? undefined;
}

describe('Inspector with a 3D model', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lazy-loads the model viewer and lists model statistics', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const view = await mountReact(render(model({
      format: 'glb', triangleCount: 12_345, vertexCount: 24_000, meshCount: 3, primitiveCount: 4,
      materialCount: 2, textureCount: 1, animationCount: 2, generator: 'Blender glTF exporter',
      modelBounds: { min: [-0.5, 0, -0.25], max: [0.5, 2, 0.25] },
      gltfExtensionsUsed: ['KHR_materials_unlit'], gltfExtensionsRequired: [],
      modelMetadataStatus: 'complete', modelThumbnailStatus: 'rendered',
    })));
    // The lazy chunk may resolve during mount; wait for it either way.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.container.querySelector('[data-testid="model-viewer"]')?.textContent)
      .toBe('Viewer for crate.glb at revision 3');

    expect(rowValue(view.container, 'Triangles')).toBe('12k');
    expect(rowValue(view.container, 'Vertices')).toBe('24,000');
    expect(rowValue(view.container, 'Meshes')).toBe('3 (4 primitives)');
    expect(rowValue(view.container, 'Animations')).toBe('2');
    expect(rowValue(view.container, 'Size (X × Y × Z)')).toBe('1.00 × 2.00 × 0.50');
    expect(rowValue(view.container, 'Generator')).toBe('Blender glTF exporter');
    expect(rowValue(view.container, 'Extensions')).toBe('KHR_materials_unlit');
    expect(view.container.querySelector('[role="note"]')).toBeNull();
    await view.unmount();
  });

  it('explains placeholder thumbnails and unreadable files', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const view = await mountReact(render(model({
      modelMetadataStatus: 'complete', modelThumbnailStatus: 'placeholder',
      modelThumbnailIssue: 'Draco-compressed geometry', meshCount: 1,
    })));
    expect(view.container.querySelector('[role="note"]')?.textContent)
      .toBe('Thumbnail uses a placeholder: Draco-compressed geometry');

    await view.render(render({
      ...model({ modelMetadataStatus: 'failed', modelMetadataError: 'Missing glTF binary header' }),
      id: 'broken', updatedAt: 2,
    }));
    expect(view.container.querySelector('[role="note"]')?.textContent)
      .toBe('Model could not be read: Missing glTF binary header');
    await view.unmount();
  });
});
