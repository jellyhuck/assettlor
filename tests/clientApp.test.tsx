// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetListResponse, AssetStack } from '../shared/types.js';
import { FakeEventSource, createDeferredFetch, type PendingFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import App from '../client/src/App.js';

const inspectorCallbacks = vi.hoisted(() => ({
  updateAsset: null as null | ((asset: unknown) => void),
}));

vi.mock('../client/src/components/Sidebar.tsx', () => ({
  Sidebar: ({ onSelectCategory, onTriggerScan, onCancelScan, scanActionPending,
    scanStatus, tags }: {
    onSelectCategory: (category: string) => void;
    onTriggerScan: () => void;
    onCancelScan: () => void;
    scanActionPending: 'start' | 'cancel' | null;
    scanStatus: { status: string };
    tags: { name: string }[];
  }) => <aside>
    <button onClick={() => onSelectCategory('all')}>All category</button>
    <button onClick={() => onSelectCategory('audio')}>Audio category</button>
    <button onClick={onTriggerScan}>Start scan</button>
    <button onClick={onCancelScan}>Cancel scan</button>
    <output data-testid="scan-state">{scanStatus.status}:{scanActionPending ?? 'ready'}</output>
    <output data-testid="tags">{tags.map((tag) => tag.name).join(',')}</output>
  </aside>,
}));

vi.mock('../client/src/components/TopBar.tsx', () => ({
  TopBar: ({ searchQuery, onSearchChange, isStackedView, onToggleStackedView,
    totalItems, loadedItems }: {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    isStackedView: boolean;
    onToggleStackedView: () => void;
    totalItems: number;
    loadedItems?: number;
  }) => <header>
    <input aria-label="Search assets" value={searchQuery}
      onChange={(event) => onSearchChange(event.target.value)} />
    <button onClick={() => onSearchChange('gem')}>Search gem</button>
    <button onClick={onToggleStackedView}>{isStackedView ? 'Flat view' : 'Stacked view'}</button>
    <output data-testid="loaded-count">{loadedItems ?? 0}/{totalItems}</output>
  </header>,
}));

vi.mock('../client/src/components/AssetGrid.tsx', () => ({
  AssetGrid: ({ items, onSelectItem, loading }: {
    items: Array<{ id: string; name: string }>;
    onSelectItem: (item: { id: string; name: string }) => void;
    loading: boolean;
  }) => <main data-testid="catalog" aria-busy={loading}>
    {items.map((item) => <button key={item.id} data-item-id={item.id}
      onClick={() => onSelectItem(item)}>{item.name}</button>)}
  </main>,
}));

vi.mock('../client/src/components/Inspector.tsx', () => ({
  Inspector: ({ item, onClose, onAssetUpdated }: {
    item: { id: string; name: string };
    onClose: () => void;
    onAssetUpdated: (asset: unknown) => void;
  }) => {
    inspectorCallbacks.updateAsset = onAssetUpdated;
    return <aside data-testid="inspector">
      <output data-testid="selected-item">{item.id}:{item.name}</output>
      <button onClick={onClose}>Close inspector</button>
    </aside>;
  },
}));

vi.mock('../client/src/components/SettingsModal.tsx', () => ({ SettingsModal: () => null }));
vi.mock('../client/src/components/ClassifierModal.tsx', () => ({ ClassifierModal: () => null }));
vi.mock('../client/src/components/CopyModal.tsx', () => ({ CopyModal: () => null }));

const settings = {
  libraryPath: '/tmp/library', libraryPaths: ['/tmp/library'],
  activeProjectPath: '', projectPaths: [], thumbnailQuality: 80,
  autoStackAnimations: true, autoStackAudio: true, defaultFps: 12,
};

function asset(index: number, name = 'Same name'): Asset {
  return {
    id: `asset-${index}`, path: `assets/${index}.png`, absolutePath: `/tmp/library/${index}.png`,
    name, extension: '.png', category: 'image', size: 100, mtime: 1,
    hash: `hash-${index}`, isArchiveEntry: false, thumbnailUrl: `/thumb/${index}`,
    fileUrl: `/file/${index}`, metadata: { width: 64, height: 64 }, tags: [],
    createdAt: 1, updatedAt: 1,
  };
}

function stack(index: number): AssetStack & { isStack: true } {
  return {
    id: `stack-${index}`, name: 'Same name', type: 'animation', itemCount: 2,
    representativeAssetId: `asset-${index}`, representativeAsset: asset(index),
    tags: [], createdAt: 1, isStack: true,
  };
}

type Item = Asset | (AssetStack & { isStack: true });

function catalogPage(items: Item[], page: number, total: number): AssetListResponse {
  return {
    items, page, limit: 100, total, totalPages: Math.max(1, Math.ceil(total / 100)),
    summary: {
      totalAssets: total, totalSize: total * 100, imageCount: total,
      audioCount: 0, animationStackCount: 0, audioStackCount: 0,
    },
  };
}

const scanEvent = (status: 'idle' | 'scanning' | 'completed' | 'error', startTime: number) => ({
  status, startTime, libraryPath: '/tmp/library', scannedCount: 4, indexedCount: 4,
});

describe('App catalog and live request lifecycle', () => {
  let fetchDouble: ReturnType<typeof createDeferredFetch>;
  let view: Awaited<ReturnType<typeof mountReact>> | null;

  function requests(path: string): PendingFetch[] {
    return fetchDouble.requests.filter((request) => new URL(request.url, 'http://local').pathname === path);
  }

  function catalogRequests(): PendingFetch[] {
    return requests('/api/assets');
  }

  function latestCatalog(): PendingFetch {
    const request = catalogRequests().at(-1);
    if (!request) throw new Error('No catalog request');
    return request;
  }

  function query(request: PendingFetch, name: string): string | null {
    return new URL(request.url, 'http://local').searchParams.get(name);
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(view!.container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.toLowerCase().includes(label.toLowerCase())
        || candidate.getAttribute('aria-label')?.toLowerCase().includes(label.toLowerCase()));
    if (!found) throw new Error(`Button not found: ${label}`);
    return found;
  }

  function itemIds(): string[] {
    return Array.from(view!.container.querySelectorAll<HTMLElement>('[data-item-id]'))
      .map((node) => node.dataset.itemId!);
  }

  async function mount(strict = false) {
    view = await mountReact(strict ? <StrictMode><App /></StrictMode> : <App />);
  }

  async function resolveBootstrap(items: Item[], total = items.length) {
    await act(async () => {
      requests('/api/settings').at(-1)!.resolveJson(settings);
      requests('/api/tags').at(-1)!.resolveJson([]);
      requests('/api/formats').at(-1)!.resolveJson([]);
      requests('/api/resolutions').at(-1)!.resolveJson([]);
      requests('/api/bpms').at(-1)!.resolveJson([]);
      latestCatalog().resolveJson(catalogPage(items, 1, total));
    });
  }

  beforeEach(() => {
    fetchDouble = createDeferredFetch();
    view = null;
    inspectorCallbacks.updateAsset = null;
    FakeEventSource.reset();
    vi.stubGlobal('fetch', fetchDouble.fetcher);
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(async () => {
    if (view) await view.unmount();
    vi.unstubAllGlobals();
    FakeEventSource.reset();
  });

  it('reaches 251 equal-name items in stacked and flat views', async () => {
    const stacks = Array.from({ length: 251 }, (_, index) => stack(index));
    await mount();
    await resolveBootstrap(stacks.slice(0, 100), stacks.length);
    expect(query(catalogRequests()[0], 'isStackedView')).toBe('true');
    expect(itemIds()).toHaveLength(100);
    expect(view!.container.querySelector('[data-testid="loaded-count"]')?.textContent).toBe('100/251');

    await click(button('Load more'));
    expect(query(latestCatalog(), 'page')).toBe('2');
    await act(async () => { latestCatalog().resolveJson(catalogPage(stacks.slice(100, 200), 2, 251)); });
    await click(button('Load more'));
    expect(query(latestCatalog(), 'page')).toBe('3');
    await act(async () => { latestCatalog().resolveJson(catalogPage(stacks.slice(200), 3, 251)); });
    expect(itemIds()).toHaveLength(251);
    expect(itemIds().at(-1)).toBe('stack-250');
    expect(view!.container.querySelector('[data-testid="loaded-count"]')?.textContent).toBe('251/251');

    await click(button('Flat view'));
    expect(query(latestCatalog(), 'isStackedView')).toBe('false');
    expect(query(latestCatalog(), 'page')).toBe('1');
    const assets = Array.from({ length: 251 }, (_, index) => asset(index));
    await act(async () => { latestCatalog().resolveJson(catalogPage(assets.slice(0, 100), 1, 251)); });
    await click(button('Load more'));
    await act(async () => { latestCatalog().resolveJson(catalogPage(assets.slice(100, 200), 2, 251)); });
    await click(button('Load more'));
    await act(async () => { latestCatalog().resolveJson(catalogPage(assets.slice(200), 3, 251)); });
    expect(itemIds()).toHaveLength(251);
    expect(itemIds().at(-1)).toBe('asset-250');
    expect(view!.container.querySelector('[data-testid="loaded-count"]')?.textContent).toBe('251/251');
  });

  it('retries a later page without discarding loaded results', async () => {
    const items = Array.from({ length: 250 }, (_, index) => asset(index));
    await mount();
    await resolveBootstrap(items.slice(0, 100), 250);
    await click(button('Load more'));
    const failed = latestCatalog();
    await act(async () => { failed.resolveJson({ error: 'Page unavailable' }, 503); });
    expect(itemIds()).toHaveLength(100);
    expect(view!.container.textContent).toContain('Page unavailable');

    await click(button('Retry'));
    expect(query(latestCatalog(), 'page')).toBe('2');
    await act(async () => { latestCatalog().resolveJson(catalogPage(items.slice(100, 200), 2, 250)); });
    expect(itemIds()).toHaveLength(200);
    expect(itemIds()[199]).toBe('asset-199');
  });

  it('refreshes page one when a later page falls beyond a shrunken index', async () => {
    const items = Array.from({ length: 150 }, (_, index) => asset(index));
    await mount();
    await resolveBootstrap(items.slice(0, 100), 150);
    await click(button('Load more'));
    expect(query(latestCatalog(), 'page')).toBe('2');

    await act(async () => { latestCatalog().resolveJson(catalogPage([], 2, 80)); });
    expect(query(latestCatalog(), 'page')).toBe('1');
    await act(async () => { latestCatalog().resolveJson(catalogPage(items.slice(0, 80), 1, 80)); });

    expect(itemIds()).toHaveLength(80);
    expect(itemIds().at(-1)).toBe('asset-79');
    expect(view!.container.querySelector('[data-testid="loaded-count"]')?.textContent).toBe('80/80');
    expect(view!.container.textContent).not.toContain('Load more');
  });

  it('drops an old second page after a filter change', async () => {
    const items = Array.from({ length: 250 }, (_, index) => asset(index));
    await mount();
    await resolveBootstrap(items.slice(0, 100), 250);
    await click(button('Load more'));
    const oldPage = latestCatalog();
    await click(button('Audio category'));
    const newPage = latestCatalog();
    expect(query(newPage, 'category')).toBe('audio');
    expect(query(newPage, 'page')).toBe('1');
    expect(oldPage.init?.signal?.aborted).toBe(true);

    const matching = asset(900, 'Audio result');
    matching.category = 'audio';
    await act(async () => { newPage.resolveJson(catalogPage([matching], 1, 1)); });
    await act(async () => { oldPage.resolveJson(catalogPage(items.slice(100, 200), 2, 250)); });
    expect(itemIds()).toEqual(['asset-900']);
    expect(view!.container.querySelector('[data-testid="loaded-count"]')?.textContent).toBe('1/1');
  });


});
