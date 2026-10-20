// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Asset, AssetListResponse, AssetStack } from '../shared/types.js';
import { FakeEventSource, createDeferredFetch, type PendingFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import App from '../client/src/App.js';

const inspectorCallbacks = vi.hoisted(() => ({
  updateAsset: null as null | ((asset: unknown, updateSelection?: boolean) => void),
}));
const settingsCallbacks = vi.hoisted(() => ({
  onSettingsSaved: null as null | ((settings: AppSettings) => void),
}));

vi.mock('../client/src/components/Sidebar.tsx', () => ({
  Sidebar: ({ onSelectCategory, onTriggerScan, onCancelScan, onOpenSettings,
    scanActionPending, scanStatus, tags, settings: appSettings }: {
    onSelectCategory: (category: string) => void;
    onTriggerScan: () => void;
    onCancelScan: () => void;
    onOpenSettings: () => void;
    scanActionPending: 'start' | 'cancel' | null;
    scanStatus: { status: string };
    tags: { name: string }[];
    settings: AppSettings;
  }) => <aside>
    <button onClick={() => onSelectCategory('all')}>All category</button>
    <button onClick={() => onSelectCategory('audio')}>Audio category</button>
    <button onClick={onTriggerScan}>Start scan</button>
    <button onClick={onCancelScan}>Cancel scan</button>
    <button onClick={onOpenSettings}>Open settings</button>
    <output data-testid="scan-state">{scanStatus.status}:{scanActionPending ?? 'ready'}</output>
    <output data-testid="tags">{tags.map((tag) => tag.name).join(',')}</output>
    <output data-testid="settings-paths">{appSettings.libraryPaths.join(',')}</output>
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
    onAssetUpdated: (asset: unknown, updateSelection?: boolean) => void;
  }) => {
    inspectorCallbacks.updateAsset = onAssetUpdated;
    return <aside data-testid="inspector">
      <output data-testid="selected-item">{item.id}:{item.name}</output>
      <button onClick={onClose}>Close inspector</button>
    </aside>;
  },
}));

vi.mock('../client/src/components/SettingsModal.tsx', () => ({
  SettingsModal: ({ isOpen, onClose, onSettingsSaved }: {
    isOpen: boolean;
    onClose: () => void;
    onSettingsSaved: (settings: AppSettings) => void;
  }) => {
    settingsCallbacks.onSettingsSaved = onSettingsSaved;
    return isOpen ? <div data-testid="settings-modal">
      <button onClick={onClose}>Close settings</button>
    </div> : null;
  },
}));
vi.mock('../client/src/components/ClassifierModal.tsx', () => ({ ClassifierModal: () => null }));
vi.mock('../client/src/components/CopyModal.tsx', () => ({ CopyModal: () => null }));

const settings: AppSettings = {
  libraryPath: '/tmp/library', libraryPaths: ['/tmp/library'],
  activeProjectPath: '', projectPaths: [], thumbnailQuality: 80,
  autoStackAnimations: true, autoStackAudio: true, defaultFps: 12, catalogPaging: 'load-more',
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

  async function resolveBootstrap(items: Item[], total = items.length, appSettings: AppSettings = settings) {
    await act(async () => {
      requests('/api/settings').at(-1)!.resolveJson(appSettings);
      requests('/api/tags').at(-1)!.resolveJson([]);
      requests('/api/formats').at(-1)!.resolveJson([]);
      requests('/api/resolutions').at(-1)!.resolveJson([]);
      requests('/api/bpms').at(-1)!.resolveJson([]);
      requests('/api/folders').at(-1)!.resolveJson([]);
      requests('/api/libraries').at(-1)!.resolveJson([]);
      latestCatalog().resolveJson(catalogPage(items, 1, total));
    });
  }

  async function saveSettings(paths: string[]) {
    const callback = settingsCallbacks.onSettingsSaved;
    if (!callback) throw new Error('Settings save callback missing');
    await act(async () => {
      callback({ ...settings, libraryPath: paths[0] ?? '', libraryPaths: paths });
    });
  }

  beforeEach(() => {
    fetchDouble = createDeferredFetch();
    view = null;
    inspectorCallbacks.updateAsset = null;
    settingsCallbacks.onSettingsSaved = null;
    FakeEventSource.reset();
    vi.stubGlobal('fetch', fetchDouble.fetcher);
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(async () => {
    if (view) await view.unmount();
    vi.unstubAllGlobals();
    window.localStorage.clear();
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

  it('replaces results page by page when numbered pages are configured', async () => {
    const items = Array.from({ length: 250 }, (_, index) => asset(index));
    await mount();
    await resolveBootstrap(items.slice(0, 100), 250, { ...settings, catalogPaging: 'pages' });
    expect(catalogRequests()).toHaveLength(1);
    expect(view!.container.textContent).not.toContain('Load more');
    expect(view!.container.textContent).toContain('1–100 of 250');
    expect(view!.container.querySelector('[data-testid="loaded-count"]')?.textContent).toBe('0/250');
    expect(button('Previous page').disabled).toBe(true);

    await click(button('Next page'));
    expect(query(latestCatalog(), 'page')).toBe('2');
    expect(itemIds()).toHaveLength(100);
    await act(async () => { latestCatalog().resolveJson(catalogPage(items.slice(100, 200), 2, 250)); });
    expect(itemIds()).toHaveLength(100);
    expect(itemIds()[0]).toBe('asset-100');
    expect(button('Page 2').getAttribute('aria-current')).toBe('page');

    await click(button('Page 3'));
    expect(query(latestCatalog(), 'page')).toBe('3');
    await act(async () => { latestCatalog().resolveJson(catalogPage(items.slice(200), 3, 250)); });
    expect(itemIds()).toHaveLength(50);
    expect(view!.container.textContent).toContain('201–250 of 250');
    expect(button('Next page').disabled).toBe(true);

    await click(button('Audio category'));
    expect(query(latestCatalog(), 'category')).toBe('audio');
    expect(query(latestCatalog(), 'page')).toBe('1');
  });

  it('moves to the last remaining page when the index shrinks under the current page', async () => {
    const items = Array.from({ length: 250 }, (_, index) => asset(index));
    await mount();
    await resolveBootstrap(items.slice(0, 100), 250, { ...settings, catalogPaging: 'pages' });
    await click(button('Page 3'));
    await act(async () => { latestCatalog().resolveJson(catalogPage([], 3, 150)); });
    expect(query(latestCatalog(), 'page')).toBe('2');
    await act(async () => { latestCatalog().resolveJson(catalogPage(items.slice(100, 150), 2, 150)); });
    expect(itemIds()).toHaveLength(50);
    expect(button('Page 2').getAttribute('aria-current')).toBe('page');
  });

  it('keeps one stream through query edits and notifies once per observed scan', async () => {
    await mount();
    await resolveBootstrap([], 0);
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    await act(async () => { source.emit(scanEvent('completed', 7)); });
    expect(view!.container.textContent).not.toContain('Library Scan Completed');

    await click(button('Audio category'));
    await act(async () => { latestCatalog().resolveJson(catalogPage([], 1, 0)); });
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => { source.emit(scanEvent('scanning', 8)); });
    await act(async () => { source.emit(scanEvent('completed', 8)); });
    const catalogCount = catalogRequests().length;
    const tagsCount = requests('/api/tags').length;
    expect(view!.container.textContent).toContain('Library Scan Completed');
    await act(async () => { source.emit(scanEvent('completed', 8)); });
    await act(async () => { source.fail(); });
    expect(view!.container.textContent).toContain('Scan updates disconnected');
    await act(async () => { source.open(); source.emit(scanEvent('completed', 8)); });
    expect(view!.container.textContent).not.toContain('Scan updates disconnected');
    expect(catalogRequests()).toHaveLength(catalogCount);
    expect(requests('/api/tags')).toHaveLength(tagsCount);
    expect(view!.container.textContent?.match(/Library Scan Completed/g)).toHaveLength(1);

    await act(async () => { source.emit(scanEvent('scanning', 9)); });
    await act(async () => { source.emit(scanEvent('completed', 9)); });
    expect(view!.container.textContent?.match(/Library Scan Completed/g)).toHaveLength(2);
  });

  it('closes the StrictMode setup stream and keeps the active one stable', async () => {
    await mount(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0].closed).toBe(true);
    await resolveBootstrap([], 0);
    await click(button('Audio category'));
    expect(FakeEventSource.instances).toHaveLength(2);
    await act(async () => { latestCatalog().resolveJson(catalogPage([], 1, 0)); });
    expect(FakeEventSource.instances[1].closed).toBe(false);
  });

  it('guards scan start and cancel requests until the terminal cancellation event', async () => {
    await mount();
    await resolveBootstrap([], 0);
    const source = FakeEventSource.instances[0];

    await click(button('Start scan'));
    await click(button('Start scan'));
    expect(requests('/api/scan/start')).toHaveLength(1);
    const start = requests('/api/scan/start')[0];
    expect(start.init?.method).toBe('POST');
    expect(JSON.parse(String(start.init?.body))).toEqual({
      libraryPath: '/tmp/library', libraryPaths: ['/tmp/library'],
    });
    expect(view!.container.querySelector('[data-testid="scan-state"]')?.textContent).toBe('idle:start');
    await click(button('Cancel scan'));
    expect(requests('/api/scan/cancel')).toHaveLength(0);

    await act(async () => { start.resolveJson({ message: 'Scan started' }); });
    await act(async () => { source.emit(scanEvent('scanning', 31)); });
    await click(button('Start scan'));
    expect(requests('/api/scan/start')).toHaveLength(1);
    await click(button('Cancel scan'));
    await click(button('Cancel scan'));
    expect(requests('/api/scan/cancel')).toHaveLength(1);
    const cancel = requests('/api/scan/cancel')[0];
    expect(cancel.init?.method).toBe('POST');
    expect(view!.container.querySelector('[data-testid="scan-state"]')?.textContent).toBe('scanning:cancel');

    await act(async () => { cancel.resolveJson({ message: 'Cancellation requested' }); });
    expect(view!.container.querySelector('[data-testid="scan-state"]')?.textContent).toBe('scanning:cancel');
    const catalogCount = catalogRequests().length;
    await act(async () => { source.emit({ ...scanEvent('idle', 31), message: 'Scan cancelled' }); });
    expect(view!.container.querySelector('[data-testid="scan-state"]')?.textContent).toBe('idle:ready');
    expect(view!.container.textContent).toContain('Library Scan Cancelled');
    expect(catalogRequests()).toHaveLength(catalogCount + 1);
    await act(async () => { source.emit({ ...scanEvent('idle', 31), message: 'Scan cancelled' }); });
    expect(catalogRequests()).toHaveLength(catalogCount + 1);
  });

  it('reloads persisted app settings when Settings closes after a partial save', async () => {
    await mount();
    await resolveBootstrap([], 0);
    await click(button('Open settings'));
    expect(view!.container.querySelector('[data-testid="settings-modal"]')).not.toBeNull();
    await click(button('Close settings'));
    expect(requests('/api/settings')).toHaveLength(2);
    const persisted = { ...settings,
      libraryPath: '/tmp/persisted', libraryPaths: ['/tmp/persisted'],
    };
    await act(async () => { requests('/api/settings')[1].resolveJson(persisted); });
    expect(view!.container.querySelector('[data-testid="settings-paths"]')?.textContent)
      .toBe('/tmp/persisted');

    await click(button('Start scan'));
    expect(JSON.parse(String(requests('/api/scan/start')[0].init?.body))).toEqual({
      libraryPath: '/tmp/persisted', libraryPaths: ['/tmp/persisted'],
    });
  });

  it.each([
    { status: 'completed' as const, message: 'Scan finished' },
    { status: 'error' as const, message: 'Scan failed' },
    { status: 'idle' as const, message: 'Scan cancelled' },
  ])('starts one latest saved-settings scan after a $status event', async ({ status, message }) => {
    await mount();
    await resolveBootstrap([], 0);
    const source = FakeEventSource.instances[0];
    await act(async () => { source.emit(scanEvent('scanning', 41)); });
    await click(button('Open settings'));
    await saveSettings(['/tmp/earlier']);
    await click(button('Close settings'));
    await act(async () => { requests('/api/settings').at(-1)!.resolveJson({
      ...settings, libraryPath: '/tmp/earlier', libraryPaths: ['/tmp/earlier'],
    }); });
    await click(button('Open settings'));
    await saveSettings(['/tmp/latest-a', '/tmp/latest-b']);
    await click(button('Close settings'));
    await act(async () => { requests('/api/settings').at(-1)!.resolveJson({
      ...settings, libraryPath: '/tmp/latest-a', libraryPaths: ['/tmp/latest-a', '/tmp/latest-b'],
    }); });
    expect(requests('/api/scan/start')).toHaveLength(0);

    await act(async () => { source.emit({ ...scanEvent(status, 41), message }); });
    expect(requests('/api/scan/start')).toHaveLength(1);
    expect(JSON.parse(String(requests('/api/scan/start')[0].init?.body))).toEqual({
      libraryPath: '/tmp/latest-a', libraryPaths: ['/tmp/latest-a', '/tmp/latest-b'],
    });
    expect(view!.container.querySelector('[data-testid="scan-state"]')?.textContent)
      .toBe(`${status}:start`);
    await act(async () => { source.emit({ ...scanEvent(status, 41), message }); });
    expect(requests('/api/scan/start')).toHaveLength(1);
    expect(view!.container.querySelector('[data-testid="scan-state"]')?.textContent)
      .toBe(`${status}:start`);
  });

  it('clears a queued scan when the latest saved settings remove every library', async () => {
    await mount();
    await resolveBootstrap([], 0);
    const source = FakeEventSource.instances[0];
    await act(async () => { source.emit(scanEvent('scanning', 51)); });
    await click(button('Open settings'));
    await saveSettings(['/tmp/earlier']);
    await click(button('Close settings'));
    await act(async () => { requests('/api/settings').at(-1)!.resolveJson({
      ...settings, libraryPath: '/tmp/earlier', libraryPaths: ['/tmp/earlier'],
    }); });
    await click(button('Open settings'));
    await saveSettings([]);
    await click(button('Close settings'));
    await act(async () => { requests('/api/settings').at(-1)!.resolveJson({
      ...settings, libraryPath: '', libraryPaths: [],
    }); });
    await act(async () => { source.emit(scanEvent('completed', 51)); });
    expect(requests('/api/scan/start')).toHaveLength(0);
  });

  it('retries queued settings paths once after a failed pending start is confirmed idle', async () => {
    await mount();
    await resolveBootstrap([], 0);
    await click(button('Start scan'));
    await click(button('Open settings'));
    await saveSettings(['/tmp/saved']);
    expect(requests('/api/scan/start')).toHaveLength(1);

    await act(async () => { requests('/api/scan/start')[0].resolveJson({ error: 'Start failed' }, 500); });
    expect(requests('/api/scan/status')).toHaveLength(1);
    expect(requests('/api/scan/start')).toHaveLength(1);
    await act(async () => { requests('/api/scan/status')[0].resolveJson(scanEvent('idle', 60)); });
    expect(requests('/api/scan/start')).toHaveLength(2);
    expect(JSON.parse(String(requests('/api/scan/start')[1].init?.body))).toEqual({
      libraryPath: '/tmp/saved', libraryPaths: ['/tmp/saved'],
    });

    await act(async () => { requests('/api/scan/start')[1].resolveJson({ error: 'Retry failed' }, 500); });
    expect(requests('/api/scan/start')).toHaveLength(2);
    expect(requests('/api/scan/status')).toHaveLength(1);
  });

  it('waits for terminal status when a failed start response hides a running scan', async () => {
    await mount();
    await resolveBootstrap([], 0);
    await click(button('Start scan'));
    await click(button('Open settings'));
    await saveSettings(['/tmp/saved']);

    await act(async () => { requests('/api/scan/start')[0].resolveJson({ error: 'Response lost' }, 503); });
    await act(async () => { requests('/api/scan/status')[0].resolveJson(scanEvent('scanning', 61)); });
    expect(requests('/api/scan/start')).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    await act(async () => { source.emit(scanEvent('completed', 61)); });
    expect(requests('/api/scan/start')).toHaveLength(2);
    expect(JSON.parse(String(requests('/api/scan/start')[1].init?.body))).toEqual({
      libraryPath: '/tmp/saved', libraryPaths: ['/tmp/saved'],
    });
  });

  it('shows catalog HTTP, JSON, and item-shape failures with a retry path', async () => {
    await mount();
    await act(async () => {
      requests('/api/settings')[0].resolveJson(settings);
      requests('/api/tags')[0].resolveJson([]);
      requests('/api/formats')[0].resolveJson([]);
      requests('/api/resolutions')[0].resolveJson([]);
      requests('/api/bpms')[0].resolveJson([]);
      requests('/api/folders')[0].resolveJson([]);
      requests('/api/libraries')[0].resolveJson([]);
      latestCatalog().resolveJson({ error: 'Catalog unavailable' }, 503);
    });
    expect(view!.container.textContent).toContain('Catalog unavailable');
    await click(button('Retry'));
    await act(async () => { latestCatalog().resolveText('not json'); });
    expect(view!.container.textContent).toContain('invalid JSON');
    await click(button('Retry'));
    await act(async () => { latestCatalog().resolveJson({
      ...catalogPage([asset(1)], 1, 1),
      items: [{ id: 'broken', name: 'Incomplete', category: 'image', tags: [] }],
    }); });
    expect(view!.container.textContent).toContain('invalid asset catalog');
    await click(button('Retry'));
    await act(async () => { latestCatalog().resolveJson(catalogPage([asset(1)], 1, 1)); });
    expect(itemIds()).toEqual(['asset-1']);
  });

  it('retries a network failure without showing an old query as current', async () => {
    await mount();
    await resolveBootstrap([asset(1, 'Old result')], 1);
    await click(button('Search gem'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    expect(query(latestCatalog(), 'search')).toBe('gem');
    await act(async () => { latestCatalog().response.reject(new TypeError('Network unavailable')); });
    expect(view!.container.textContent).toContain('Network unavailable');
    expect(itemIds()).toEqual([]);

    await click(button('Retry results'));
    await act(async () => { latestCatalog().resolveJson(catalogPage([asset(2, 'Fresh result')], 1, 1)); });
    expect(itemIds()).toEqual(['asset-2']);
  });

  it('keeps settings and facets failures out of typed Sidebar state', async () => {
    await mount();
    await act(async () => {
      requests('/api/settings')[0].resolveJson({ error: 'Settings unavailable' }, 503);
      requests('/api/tags')[0].resolveJson({ error: 'bad shape' });
      requests('/api/formats')[0].resolveJson([]);
      requests('/api/resolutions')[0].resolveJson([]);
      requests('/api/bpms')[0].resolveJson([]);
      requests('/api/folders')[0].resolveJson([]);
      requests('/api/libraries')[0].resolveJson([]);
      latestCatalog().resolveJson(catalogPage([], 1, 0));
    });
    expect(view!.container.querySelector('[data-testid="tags"]')?.textContent).toBe('');
    expect(view!.container.textContent).toContain('Settings unavailable');
    expect(view!.container.textContent).toContain('invalid tags');
    await click(button('Retry settings'));
    await click(button('Retry filters'));
    await act(async () => {
      requests('/api/settings').at(-1)!.resolveJson(settings);
      requests('/api/tags').at(-1)!.resolveJson([{ name: 'gem', count: 1 }]);
      requests('/api/formats').at(-1)!.resolveJson([]);
      requests('/api/resolutions').at(-1)!.resolveJson([]);
      requests('/api/bpms').at(-1)!.resolveJson([]);
      requests('/api/folders').at(-1)!.resolveJson([]);
      requests('/api/libraries').at(-1)!.resolveJson([]);
    });
    expect(view!.container.querySelector('[data-testid="tags"]')?.textContent).toBe('gem');
  });

  it('keeps selection by identity through delayed detail and a scan refresh', async () => {
    await mount();
    await resolveBootstrap([asset(1, 'Before A'), asset(2, 'Before B')], 2);
    await click(button('Search gem'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    expect(query(latestCatalog(), 'search')).toBe('gem');
    await act(async () => { latestCatalog().resolveJson(catalogPage([
      asset(1, 'Before A'), asset(2, 'Before B'),
    ], 1, 2)); });
    await click(view!.container.querySelector<HTMLElement>('[data-item-id="asset-1"]')!);
    const oldDetail = requests('/api/assets/asset-1').at(-1)!;
    const staleUpdate = inspectorCallbacks.updateAsset;
    await click(view!.container.querySelector<HTMLElement>('[data-item-id="asset-2"]')!);
    const newDetail = requests('/api/assets/asset-2').at(-1)!;
    expect(oldDetail.init?.signal?.aborted).toBe(true);
    await act(async () => { newDetail.resolveJson(asset(2, 'Fresh B')); });
    await act(async () => { oldDetail.resolveJson(asset(1, 'Late A')); });
    expect(view!.container.querySelector('[data-testid="selected-item"]')?.textContent).toBe('asset-2:Fresh B');

    if (!staleUpdate) throw new Error('Inspector update callback missing');
    await act(async () => { staleUpdate(asset(1, 'Stale callback A')); });
    expect(view!.container.querySelector('[data-testid="selected-item"]')?.textContent).toBe('asset-2:Fresh B');
    await act(async () => { staleUpdate(asset(2, 'Stale callback for B'), false); });
    expect(view!.container.querySelector('[data-testid="selected-item"]')?.textContent).toBe('asset-2:Fresh B');

    const source = FakeEventSource.instances[0];
    await act(async () => { source.emit(scanEvent('scanning', 20)); });
    await act(async () => { source.emit(scanEvent('completed', 20)); });
    await act(async () => { latestCatalog().resolveJson(catalogPage([asset(1, 'Only A on page')], 1, 101)); });
    const refreshedDetail = requests('/api/assets/asset-2').at(-1)!;
    await act(async () => { refreshedDetail.resolveJson(asset(2, 'After scan B')); });
    expect(view!.container.querySelector('[data-testid="selected-item"]')?.textContent).toBe('asset-2:After scan B');

    await act(async () => { source.emit(scanEvent('scanning', 21)); });
    await act(async () => { source.emit(scanEvent('completed', 21)); });
    await act(async () => { latestCatalog().resolveJson(catalogPage([], 1, 0)); });
    await act(async () => { requests('/api/assets/asset-2').at(-1)!.resolveJson({ error: 'Asset not found' }, 404); });
    expect(view!.container.querySelector('[data-testid="inspector"]')).toBeNull();
  });
});
