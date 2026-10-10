// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetStack, AppSettings } from '../shared/types.js';
import { createDeferredFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { Inspector } from '../client/src/components/Inspector.js';
import { ToastProvider } from '../client/src/components/ToastProvider.js';

const settings: AppSettings = {
  libraryPath: '/tmp/library', libraryPaths: ['/tmp/library'], activeProjectPath: '',
  projectPaths: [], thumbnailQuality: 80, autoStackAnimations: true,
  autoStackAudio: true, defaultFps: 12,
};

function asset(id: string, name = id, stackId?: string): Asset {
  return {
    id, name, stackId, path: `${name}.png`, absolutePath: `/tmp/library/${name}.png`,
    extension: '.png', category: 'image', size: 10, mtime: 1, hash: id,
    isArchiveEntry: false, thumbnailUrl: `/thumb/${id}`, fileUrl: `/file/${id}`,
    metadata: { width: 32, height: 32 }, tags: [], createdAt: 1, updatedAt: 1,
  };
}

function stack(id: string, representative: Asset): AssetStack & { isStack: true } {
  return {
    id, name: `Stack ${id}`, type: 'animation', itemCount: 2,
    representativeAssetId: representative.id, representativeAsset: representative,
    tags: [], createdAt: 1, isStack: true,
  };
}

const renderInspector = (item: Asset | (AssetStack & { isStack: true }), revision = 1) => (
  <ToastProvider>
    <Inspector item={item} revision={revision} settings={settings} onClose={() => {}}
      initialViewMode="assets" availableTags={[{ name: 'known', count: 1 }]} />
  </ToastProvider>
);

describe('inspector request identity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps disjoint stack responses and same-ID revisions in their own view', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const first = stack('A', asset('a1', 'A one'));
    const second = stack('B', asset('b1', 'B one'));
    const view = await mountReact(renderInspector(first));
    expect(pending.requests[0].url).toBe('/api/stacks/A/assets');

    await view.render(renderInspector(second));
    expect(view.container.textContent).toContain('Loading stack members');
    expect(view.container.textContent).not.toContain('A one');
    expect(pending.requests[1].url).toBe('/api/stacks/B/assets');
    await act(async () => pending.requests[1].resolveJson([asset('b1', 'B one'), asset('b2', 'B two')]));
    await act(async () => pending.requests[0].resolveJson([asset('a1', 'A one'), asset('a2', 'A two')]));
    expect(view.container.textContent).toContain('B one');
    expect(view.container.textContent).not.toContain('A two');

    await click(view.container.querySelector('button[title="B two (10.0 B)"]')!);
    expect(view.container.textContent).toContain('B two');
    await view.render(renderInspector(second, 2));
    expect(view.container.textContent).toContain('Loading stack members');
    const refreshed = pending.requests[2];
    await act(async () => refreshed.resolveJson([asset('b1', 'B one'), asset('b2', 'B two refreshed')]));
    expect(view.container.textContent).toContain('B two refreshed');
    expect(view.container.textContent).not.toContain('A two');
    await view.unmount();
  });

  it('ignores a stack response after navigating to a standalone asset', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const view = await mountReact(renderInspector(stack('A', asset('a1', 'A one'))));
    await view.render(renderInspector(asset('solo', 'Solo')));
    await act(async () => pending.requests[0].resolveJson([asset('a1', 'A one')]));
    expect(view.container.textContent).toContain('Solo');
    expect(view.container.textContent).not.toContain('A one');
    await view.unmount();
  });

  it('checks member response status and shape before showing results', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const view = await mountReact(renderInspector(stack('A', asset('a1', 'A one'))));
    await act(async () => pending.requests[0].resolveJson({ error: 'missing' }, 404));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('missing');
    await view.render(renderInspector(stack('A', asset('a1', 'A one')), 2));
    await act(async () => pending.requests[1].resolveJson({ assets: [] }));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('unexpected shape');
    await view.unmount();
  });

  it('ignores a former asset’s delayed parent-stack detail', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const view = await mountReact(renderInspector(asset('a', 'A', 'parent-a')));
    await view.render(renderInspector(asset('b', 'B', 'parent-b')));
    expect(pending.requests.map((request) => request.url)).toEqual([
      '/api/stacks/parent-a', '/api/stacks/parent-b',
    ]);
    await act(async () => pending.requests[1].resolveJson(stack('parent-b', asset('b', 'B'))));
    await act(async () => pending.requests[0].resolveJson(stack('parent-a', asset('a', 'A'))));
    expect(view.container.textContent).toContain('Stack parent-b');
    expect(view.container.textContent).not.toContain('Stack parent-a');
    await view.unmount();
  });
});
