// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetStack } from '../shared/types.js';
import { createDeferredFetch, deferred } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { AssetCard } from '../client/src/components/AssetCard.js';
import { ToastProvider } from '../client/src/components/ToastProvider.js';

type StackItem = AssetStack & { isStack: true };

function asset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id, path: `${id}.png`, absolutePath: `/tmp/${id}.png`, name: id,
    extension: '.png', category: 'image', size: 256, mtime: 1, hash: id,
    isArchiveEntry: false, thumbnailUrl: `/thumb/${id}`, fileUrl: `/file/${id}`,
    metadata: { width: 16, height: 16 }, tags: [], createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

function stack(id: string, representative: Asset, count = 2): StackItem {
  return {
    id, name: id, type: 'animation', itemCount: count,
    representativeAssetId: representative.id, representativeAsset: representative,
    tags: [], createdAt: 1, isStack: true,
  };
}

const controls = {
  onSelect: vi.fn(), onQuickCopy: vi.fn(), onSelectAsset: vi.fn(),
  onViewStackAssets: vi.fn(),
};

function card(item: Asset | StackItem, viewMode: 'list' | 'grid' = 'list') {
  return <ToastProvider><AssetCard item={item} viewMode={viewMode} cardZoom="medium"
    isSelected={false} {...controls} /></ToastProvider>;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe('AssetCard preview ownership', () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];
  let fetchDouble: ReturnType<typeof createDeferredFetch>;

  beforeEach(() => {
    fetchDouble = createDeferredFetch();
    vi.stubGlobal('fetch', fetchDouble.fetcher);
    Object.values(controls).forEach((mock) => mock.mockClear());
  });

  afterEach(async () => {
    await Promise.all(mounted.splice(0).map((view) => view.unmount()));
    vi.unstubAllGlobals();
  });

  it('refreshes same-ID members and ignores a late earlier response', async () => {
    const first = stack('sheet', asset('first'));
    const view = await mountReact(card(first));
    mounted.push(view);
    await click(button(view.container, 'Expand to view content assets'));
    expect(fetchDouble.requests).toHaveLength(1);
    const oldRequest = fetchDouble.requests[0];

    const revised = stack('sheet', asset('second', { updatedAt: 2 }));
    await view.render(card(revised));
    await click(button(view.container, 'Expand to view content assets'));
    expect(fetchDouble.requests).toHaveLength(2);
    expect(oldRequest.init?.signal?.aborted).toBe(true);

    await act(async () => {
      fetchDouble.requests[1].resolveJson([asset('new-member')]);
      oldRequest.resolveJson([asset('old-member')]);
    });
    expect(view.container.textContent).toContain('new-member');
    expect(view.container.textContent).not.toContain('old-member');
  });

  it('deduplicates hover reads and remembers an empty stack', async () => {
    const view = await mountReact(card(stack('empty', asset('base'), 0), 'grid'));
    mounted.push(view);
    const cardRoot = button(view.container, 'Select empty').parentElement!;
    await act(async () => {
      cardRoot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      cardRoot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      cardRoot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(fetchDouble.requests).toHaveLength(1);

    await act(async () => { fetchDouble.requests[0].resolveJson([]); });
    expect(view.container.textContent).toContain('No content assets');
    await act(async () => {
      cardRoot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      cardRoot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(fetchDouble.requests).toHaveLength(1);
  });

  it('shows member errors and retries after a malformed response', async () => {
    const view = await mountReact(card(stack('broken', asset('base'))));
    mounted.push(view);
    await click(button(view.container, 'Expand to view content assets'));
    await act(async () => { fetchDouble.requests[0].resolveJson({ error: 'No members' }, 503); });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('No members');
    const retry = Array.from(view.container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Retry')!;
    await click(retry);
    await act(async () => { fetchDouble.requests[1].resolveJson([{ id: 'incomplete' }]); });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('unexpected shape');
  });

  it('terminates failed image sources and resets for a revised preview', async () => {
    const original = asset('sprite');
    const view = await mountReact(card(original, 'grid'));
    mounted.push(view);
    const image = () => view.container.querySelector('img');
    expect(image()?.getAttribute('src')).toBe('/thumb/sprite');
    await act(async () => { image()?.dispatchEvent(new Event('error')); });
    expect(image()?.getAttribute('src')).toBe('/file/sprite');
    await act(async () => { image()?.dispatchEvent(new Event('error')); });
    expect(image()).toBeNull();
    expect(view.container.textContent).toContain('Preview unavailable');

    await view.render(card(asset('sprite', { updatedAt: 2, thumbnailUrl: '/thumb/sprite?v=2' }), 'grid'));
    expect(image()?.getAttribute('src')).toBe('/thumb/sprite?v=2');

    await view.render(card(asset('raw', {
      category: 'image', extension: '.tga', fileUrl: '/file/raw', thumbnailUrl: '/thumb/raw',
    }), 'grid'));
    expect(image()?.getAttribute('src')).toBe('/thumb/raw');
    await act(async () => { image()?.dispatchEvent(new Event('error')); });
    expect(image()).toBeNull();
    expect(view.container.textContent).toContain('Preview unavailable');
  });

  it('shows only the rendered thumbnail of a model, smoothly, with its triangle count', async () => {
    const view = await mountReact(card(asset('crate', {
      category: 'model', extension: '.glb', name: 'crate.glb',
      fileUrl: '/file/crate', thumbnailUrl: '/thumb/crate', metadata: { triangleCount: 12_345 },
    }), 'grid'));
    mounted.push(view);
    const image = () => view.container.querySelector('img');
    expect(image()?.getAttribute('src')).toBe('/thumb/crate');
    expect(image()?.className).not.toContain('pixelated');
    expect(view.container.textContent).toContain('12k tris');
    await act(async () => { image()?.dispatchEvent(new Event('error')); });
    expect(image()).toBeNull();
    expect(view.container.querySelector('[role="img"]')?.getAttribute('aria-label'))
      .toBe('Preview unavailable for crate.glb');
  });

  it('uses separate keyboard controls without selecting the card', async () => {
    const view = await mountReact(card(stack('sheet', asset('base'))));
    mounted.push(view);
    const select = button(view.container, 'Select sheet');
    select.focus();
    expect(document.activeElement).toBe(select);
    await click(select);
    expect(controls.onSelect).toHaveBeenCalledOnce();
    await click(button(view.container, 'Copy to Project'));
    await click(button(view.container, 'View each content asset separately'));
    await click(button(view.container, 'Expand to view content assets'));
    expect(controls.onSelect).toHaveBeenCalledOnce();
    expect(controls.onQuickCopy).toHaveBeenCalledOnce();
    expect(controls.onViewStackAssets).toHaveBeenCalledOnce();

    await act(async () => { fetchDouble.requests[0].resolveJson([asset('member')]); });
    await click(button(view.container, 'Select content asset member'));
    expect(controls.onSelectAsset).toHaveBeenCalledWith(expect.objectContaining({ id: 'member' }));
    expect(controls.onSelect).toHaveBeenCalledOnce();
  });
});

class FakeAudio {
  static instances: FakeAudio[] = [];
  readonly src: string;
  currentTime = 0;
  pauseCount = 0;
  playResult = deferred<void>();
  private listeners = new Map<string, Set<() => void>>();

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    const entries = this.listeners.get(type) ?? new Set<() => void>();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  play() { return this.playResult.promise; }
  pause() { this.pauseCount += 1; }
  emit(type: string) { this.listeners.get(type)?.forEach((listener) => listener()); }
  listenerCount(type: string) { return this.listeners.get(type)?.size ?? 0; }
}

describe('AssetCard audio preview', () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];

  beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal('Audio', FakeAudio);
    Object.values(controls).forEach((mock) => mock.mockClear());
  });

  afterEach(async () => {
    await Promise.all(mounted.splice(0).map((view) => view.unmount()));
    vi.unstubAllGlobals();
  });

  it('ignores late play completion after stop and releases the old source on revision', async () => {
    const first = asset('sound', {
      extension: '.wav', category: 'audio', fileUrl: '/audio/first', thumbnailUrl: '',
    });
    const view = await mountReact(card(first, 'grid'));
    mounted.push(view);
    await click(button(view.container, 'Play audio preview'));
    expect(FakeAudio.instances).toHaveLength(1);
    const oldAudio = FakeAudio.instances[0];
    await click(button(view.container, 'Stop audio preview'));
    expect(oldAudio.pauseCount).toBe(1);
    expect(oldAudio.listenerCount('ended')).toBe(0);
    await act(async () => { oldAudio.playResult.resolve(); });
    expect(button(view.container, 'Play audio preview')).not.toBeNull();

    await click(button(view.container, 'Play audio preview'));
    const activeAudio = FakeAudio.instances[1];
    await act(async () => { activeAudio.playResult.resolve(); });
    expect(button(view.container, 'Stop audio preview')).not.toBeNull();
    await view.render(card({ ...first, fileUrl: '/audio/second', updatedAt: 2 }, 'grid'));
    expect(activeAudio.pauseCount).toBeGreaterThan(0);
    expect(activeAudio.listenerCount('ended')).toBe(0);
    await click(button(view.container, 'Play audio preview'));
    expect(FakeAudio.instances[2].src).toBe('/audio/second');
  });

  it('shows a rejected play request and permits retry', async () => {
    const sound = asset('sound', {
      extension: '.wav', category: 'audio', fileUrl: '/audio/rejected', thumbnailUrl: '',
    });
    const view = await mountReact(card(sound, 'grid'));
    mounted.push(view);
    await click(button(view.container, 'Play audio preview'));
    await act(async () => { FakeAudio.instances[0].playResult.reject(new Error('Playback denied')); });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Playback denied');
    await click(button(view.container, 'Retry audio preview'));
    expect(FakeAudio.instances).toHaveLength(2);
    await view.unmount();
    mounted.pop();
    expect(FakeAudio.instances[1].listenerCount('ended')).toBe(0);
  });
});
