// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetStack, AppSettings } from '../shared/types.js';
import { createDeferredFetch, deferred } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { Inspector } from '../client/src/components/Inspector.js';
import { ToastProvider } from '../client/src/components/ToastProvider.js';

vi.mock('../client/src/components/AudioWaveformPlayer.tsx', () => ({
  AudioWaveformPlayer: () => <div>Audio preview</div>,
}));

const settings: AppSettings = {
  libraryPath: '/tmp/library', libraryPaths: ['/tmp/library'], activeProjectPath: '',
  projectPaths: [], thumbnailQuality: 80, autoStackAnimations: true,
  autoStackAudio: true, defaultFps: 12, catalogPaging: 'load-more',
};

function asset(id: string, name = id, stackId?: string, category: 'image' | 'audio' = 'image'): Asset {
  return {
    id, name, stackId, path: `${name}.png`, absolutePath: `/tmp/library/${name}.png`,
    extension: category === 'audio' ? '.wav' : '.png', category, size: 10, mtime: 1, hash: id,
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

const renderInspector = (
  item: Asset | (AssetStack & { isStack: true }), revision = 1,
  callbacks: {
    onAssetUpdated?: (updated: Asset, updateSelection?: boolean) => void;
    onStackUpdated?: (updated: AssetStack & { isStack: true }, updateSelection?: boolean) => void;
  } = {},
) => (
  <ToastProvider>
    <Inspector item={item} revision={revision} settings={settings} onClose={() => {}}
      initialViewMode="assets" availableTags={[{ name: 'known', count: 1 }]}
      onAssetUpdated={callbacks.onAssetUpdated} onStackUpdated={callbacks.onStackUpdated} />
  </ToastProvider>
);

describe('inspector request identity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resets the integrated image preview on a same-ID revision', async () => {
    const current = asset('same', 'Same');
    const view = await mountReact(renderInspector(current));
    const first = view.container.querySelector<HTMLImageElement>('[role="region"][aria-label="Pan Same preview"] img')!;
    const firstUrl = first.getAttribute('src');
    await click(view.container.querySelector('button[aria-label="Zoom in"]')!);
    expect(view.container.querySelector('[aria-label="Image zoom"]')?.textContent).toContain('125%');

    await view.render(renderInspector(current, 2));
    expect(view.container.querySelector('[aria-label="Image zoom"]')?.textContent).toContain('100%');
    const refreshed = view.container.querySelector<HTMLImageElement>('[role="region"][aria-label="Pan Same preview"] img')!;
    expect(refreshed.getAttribute('src')).not.toBe(firstUrl);
    await view.unmount();
  });

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

  it('loads stack members and parent stacks under StrictMode effect replay', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const view = await mountReact(<StrictMode>{renderInspector(stack('A', asset('a1', 'A one')))}</StrictMode>);
    await view.render(<StrictMode>{renderInspector(asset('b', 'B', 'parent-b'))}</StrictMode>);
    const parentRequest = pending.requests.findLast((request) => request.url === '/api/stacks/parent-b')!;
    await act(async () => parentRequest.resolveJson(stack('parent-b', asset('b', 'B'))));
    expect(view.container.textContent).toContain('Stack parent-b');
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

  it('keeps tag add and remove completions scoped after navigation', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onAssetUpdated = vi.fn();
    const callbacks = { onAssetUpdated };
    const first = asset('a', 'A');
    const second = asset('b', 'B');
    const view = await mountReact(renderInspector(first, 1, callbacks));
    await click(view.container.querySelector('button[title="Click to add #known"]')!);
    expect(pending.requests[0].url).toBe('/api/assets/a/tags');
    await view.render(renderInspector(second, 1, callbacks));
    await click(view.container.querySelector('button[title="Click to add #known"]')!);
    expect(pending.requests[1].url).toBe('/api/assets/b/tags');
    await act(async () => pending.requests[0].resolveJson({ asset: { ...first, tags: ['known'] } }));
    expect(onAssetUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), false);
    await act(async () => pending.requests[1].resolveJson({ asset: { ...second, tags: ['known'] } }));
    expect(onAssetUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), true);
    expect(view.container.textContent).toContain('B');
    expect(view.container.textContent).not.toContain('A one');

    await view.render(renderInspector({ ...first, tags: ['known'] }, 2, callbacks));
    await click(view.container.querySelector('button[title="Remove tag #known"]')!);
    expect(pending.requests[2].url).toBe('/api/assets/a/tags/known');
    await view.render(renderInspector(second, 2, callbacks));
    await act(async () => pending.requests[2].resolveJson({ asset: first }));
    expect(onAssetUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a' }), false);
    await view.unmount();
  });

  it('keeps stack-wide tag completion on its original stack', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onStackUpdated = vi.fn();
    const callbacks = { onStackUpdated };
    const first = stack('A', asset('a1', 'A one'));
    const second = stack('B', asset('b1', 'B one'));
    const view = await mountReact(renderInspector(first, 1, callbacks));
    await act(async () => pending.requests[0].resolveJson([asset('a1', 'A one')]));
    await click(view.container.querySelector('input[type="checkbox"]')!);
    await click(view.container.querySelector('button[title="Click to add #known"]')!);
    expect(pending.requests[1].url).toBe('/api/stacks/A/tags');
    await view.render(renderInspector(second, 1, callbacks));
    await act(async () => pending.requests[1].resolveJson({ stack: { ...first, tags: ['known'] } }));
    expect(onStackUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), false);
    expect(view.container.textContent).not.toContain('A one');
    await view.unmount();
  });

  it('scopes stack-wide tag removal after switching stacks', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onStackUpdated = vi.fn();
    const firstMember = { ...asset('a1', 'A one'), tags: ['known'] };
    const first = stack('A', firstMember);
    const second = stack('B', asset('b1', 'B one'));
    const view = await mountReact(renderInspector(first, 1, { onStackUpdated }));
    await act(async () => pending.requests[0].resolveJson([firstMember]));
    await click(view.container.querySelector('input[type="checkbox"]')!);
    await click(view.container.querySelector('button[title="Remove tag #known"]')!);
    expect(pending.requests[1].url).toBe('/api/stacks/A/tags/known');
    await view.render(renderInspector(second, 1, { onStackUpdated }));
    await act(async () => pending.requests[1].resolveJson({ stack: first }));
    expect(onStackUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), false);
    expect(view.container.textContent).not.toContain('A one');
    await view.unmount();
  });

  it('reports a failed old mutation without carrying its busy state to the new item', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onAssetUpdated = vi.fn();
    const view = await mountReact(renderInspector(asset('a', 'A'), 1, { onAssetUpdated }));
    await click(view.container.querySelector('button[title="Click to add #known"]')!);
    await view.render(renderInspector(asset('b', 'B'), 1, { onAssetUpdated }));
    expect(view.container.querySelector('button[title="Click to add #known"]')).not.toBeNull();
    await act(async () => pending.requests[0].resolveJson({ error: 'Permission denied' }, 403));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('A: Permission denied');
    expect(onAssetUpdated).not.toHaveBeenCalled();
    await view.unmount();
  });

  it.each([
    ['bpm', 'audio', 'Run BPM Classifier on this audio file', { bpm: 123 }],
    ['sprite', 'image', 'Run Sprite Classifier on this image asset', { spriteType: 'object' }],
    ['pack', 'image', 'Run Pack Classifier on this asset', { pack: 'kit' }],
  ] as const)('does not apply a late %s result to another item', async (kind, category, title, result) => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onAssetUpdated = vi.fn();
    const callbacks = { onAssetUpdated };
    const first = asset('a', 'A', undefined, category);
    const second = asset('b', 'B');
    const view = await mountReact(renderInspector(first, 1, callbacks));
    await click(view.container.querySelector(`button[title="${title}"]`)!);
    expect(pending.requests[0].url).toBe(`/api/classifiers/${kind}/run`);
    await view.render(renderInspector(second, 1, callbacks));
    await act(async () => pending.requests[0].resolveJson({
      details: [{ assetId: 'a', success: true, outcome: 'classified', result }],
    }));
    expect(pending.requests[1].url).toBe('/api/assets/a');
    await act(async () => pending.requests[1].resolveJson({ ...first, metadata: result }));
    expect(onAssetUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), false);
    expect(view.container.textContent).toContain('B');
    await view.unmount();
  });

  it('uses persisted no-result classifier state to clear obsolete metadata', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onAssetUpdated = vi.fn();
    const original = { ...asset('a', 'A'), metadata: { spriteType: 'object' }, tags: ['sprite:object'] };
    const view = await mountReact(renderInspector(original, 1, { onAssetUpdated }));
    await click(view.container.querySelector('button[title="Run Sprite Classifier on this image asset"]')!);
    await act(async () => pending.requests[0].resolveJson({
      details: [{ assetId: 'a', success: false, outcome: 'no-result' }],
    }));
    await act(async () => pending.requests[1].resolveJson({ ...original, metadata: {}, tags: [] }));
    expect(onAssetUpdated).toHaveBeenCalledWith(expect.objectContaining({ metadata: {}, tags: [] }), true);
    await view.unmount();
  });
});

describe('inspector clipboard', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('waits for clipboard success and reports permission failure', async () => {
    const write = deferred<void>();
    const writeText = vi.fn().mockImplementationOnce(() => write.promise)
      .mockRejectedValueOnce(new Error('Permission denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = await mountReact(renderInspector(asset('a', 'A')));
    await click(view.container.querySelector('button[aria-label="Copy name to clipboard"]')!);
    expect(writeText).toHaveBeenCalledWith('A');
    expect(view.container.textContent).not.toContain('File Name Copied');
    await act(async () => write.resolve());
    expect(view.container.textContent).toContain('File Name Copied');
    await click(view.container.querySelector('button[aria-label="Copy name to clipboard"]')!);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Permission denied');
    await view.unmount();
  });

  it('identifies and copies the virtual location of an archive member', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const member = {
      ...asset('archive-a', 'a.png'), isArchiveEntry: true,
      archivePath: '/tmp/pack.zip', archiveEntryPath: 'gfx/a.png',
      absolutePath: '/tmp/pack.zip', path: 'pack.zip#/gfx/a.png',
    };
    const view = await mountReact(renderInspector(member));
    expect(view.container.textContent).toContain('Archive File');
    expect(view.container.textContent).toContain('Member in Archive');
    expect(view.container.textContent).toContain('gfx/a.png');
    await click(view.container.querySelector('button[aria-label="Copy archive member location"]')!);
    expect(writeText).toHaveBeenCalledWith('/tmp/pack.zip#/gfx/a.png');
    await view.unmount();
  });

  it('links the displayed file for download under its own name', async () => {
    const view = await mountReact(renderInspector(asset('a', 'a.png')));
    let link = view.container.querySelector<HTMLAnchorElement>('a[aria-label="Download a.png"]')!;
    expect(link.getAttribute('href')).toBe('/file/a?download=1');
    expect(link.getAttribute('download')).toBe('a.png');
    const member = {
      ...asset('archive-a', 'gfx/b.png'), isArchiveEntry: true,
      archivePath: '/tmp/pack.zip', archiveEntryPath: 'gfx/b.png',
      absolutePath: '/tmp/pack.zip', path: 'pack.zip#/gfx/b.png',
    };
    await view.render(renderInspector(member));
    link = view.container.querySelector<HTMLAnchorElement>('a[aria-label="Download b.png"]')!;
    expect(link.getAttribute('href')).toBe('/file/archive-a?download=1');
    expect(link.getAttribute('download')).toBe('b.png');
    await view.unmount();
  });

  it('reports an unavailable clipboard without a false success', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const view = await mountReact(renderInspector(asset('a', 'A')));
    await click(view.container.querySelector('button[aria-label="Copy name to clipboard"]')!);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Clipboard is unavailable');
    expect(view.container.textContent).not.toContain('File Name Copied');
    await view.unmount();
  });

  it('clears copied-state timers when the target changes and unmounts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = await mountReact(renderInspector(asset('a', 'A')));
    await click(view.container.querySelector('button[aria-label="Copy name to clipboard"]')!);
    const beforeSwitch = clear.mock.calls.length;
    await view.render(renderInspector(asset('b', 'B')));
    expect(clear.mock.calls.length).toBeGreaterThan(beforeSwitch);
    await click(view.container.querySelector('button[aria-label="Copy name to clipboard"]')!);
    const beforeUnmount = clear.mock.calls.length;
    await view.unmount();
    expect(clear.mock.calls.length).toBeGreaterThan(beforeUnmount);
    clear.mockRestore();
  });
});
