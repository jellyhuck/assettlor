// @vitest-environment jsdom
import { act, createElement, createRoot, type Root } from '../client/tests/reactDomHarness.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Asset, AssetStack } from '../shared/types.js';
import { AssetGrid } from '../client/src/components/AssetGrid.js';
import { ToastProvider } from '../client/src/components/ToastProvider.js';

function asset(index: number): Asset {
  return {
    id: `asset-${index}`,
    path: `asset-${index}.png`,
    absolutePath: `/tmp/asset-${index}.png`,
    name: `asset-${index}.png`,
    extension: '.png',
    category: 'image',
    size: 1024,
    mtime: 0,
    hash: `hash-${index}`,
    isArchiveEntry: false,
    thumbnailUrl: '',
    fileUrl: '',
    metadata: {},
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

type Props = ComponentProps<typeof AssetGrid>;
let viewportWidth = 1000;
const observers = new Set<TestResizeObserver>();

function measuredHeight(element: Element): number {
  if (element.hasAttribute('data-virtual-row')) {
    if ((element as HTMLElement).style.display !== 'flex') return 235;
    return element.querySelector('.border-l-2') ? 150 : 62;
  }
  return 600;
}

class TestResizeObserver {
  private targets = new Set<Element>();

  constructor(private callback: ResizeObserverCallback) {
    observers.add(this);
  }

  observe(target: Element) {
    this.targets.add(target);
    queueMicrotask(() => {
      if (this.targets.has(target)) this.notify(target);
    });
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }

  notify(target: Element) {
    const width = viewportWidth;
    const height = measuredHeight(target);
    const entry = {
      target,
      contentRect: { width, height },
      borderBoxSize: [{ inlineSize: width, blockSize: height }],
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }

  notifyAll() {
    for (const target of this.targets) this.notify(target);
  }
}

describe('AssetGrid virtual rows', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: Props;
  let oldWidth: PropertyDescriptor | undefined;
  let oldHeight: PropertyDescriptor | undefined;
  let oldClientWidth: PropertyDescriptor | undefined;
  let oldScrollTo: PropertyDescriptor | undefined;

  async function render(overrides: Partial<Props> = {}) {
    props = { ...props, ...overrides };
    await act(async () => {
      root.render(createElement(ToastProvider, null, createElement(AssetGrid, props)));
    });
  }

  function scroller(): HTMLDivElement {
    const element = container.querySelector<HTMLDivElement>('.overflow-y-auto');
    if (!element) throw new Error('Grid scroller was not rendered');
    return element;
  }

  async function scrollToEnd() {
    const element = scroller();
    const content = element.firstElementChild as HTMLElement;
    await act(async () => {
      element.scrollTop = Number.parseFloat(content.style.height) - 600;
      element.dispatchEvent(new Event('scroll'));
    });
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    viewportWidth = 1000;
    oldWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    oldHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    oldClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    oldScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true, get: () => viewportWidth,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true, get: () => viewportWidth,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true, get() { return measuredHeight(this); },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = options.top ?? 0;
        this.dispatchEvent(new Event('scroll'));
      },
    });
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([asset(9999)])));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      items: [],
      selectedItem: null,
      onSelectItem: vi.fn(),
      onQuickCopy: vi.fn(),
      viewMode: 'grid',
      cardZoom: 'medium',
      queryKey: 'initial',
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    observers.clear();
    for (const [name, descriptor] of [
      ['offsetWidth', oldWidth],
      ['offsetHeight', oldHeight],
      ['clientWidth', oldClientWidth],
      ['scrollTo', oldScrollTo],
    ] as const) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
    vi.unstubAllGlobals();
  });

  it.each(['grid', 'list'] as const)('bounds %s DOM rows and reaches the last item', async (viewMode) => {
    await render({ items: Array.from({ length: 2000 }, (_, index) => asset(index)), viewMode });
    expect(container.querySelectorAll('[data-virtual-row]').length).toBeLessThan(30);
    expect(container.querySelectorAll('[data-virtual-item-id]').length).toBeLessThan(100);

    await scrollToEnd();
    expect(container.querySelector('[data-virtual-item-id="asset-1999"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-virtual-row]').length).toBeLessThan(30);
  });

  it('adapts columns to width and zoom, then resets scroll on a new query', async () => {
    const items = Array.from({ length: 1000 }, (_, index) => asset(index));
    await render({ items });
    expect(container.querySelector<HTMLElement>('[data-virtual-row]')?.style.gridTemplateColumns)
      .toBe('repeat(5, minmax(0, 1fr))');

    await act(async () => {
      viewportWidth = 420;
      for (const observer of observers) observer.notifyAll();
    });
    expect(container.querySelector<HTMLElement>('[data-virtual-row]')?.style.gridTemplateColumns)
      .toBe('repeat(2, minmax(0, 1fr))');

    await render({ cardZoom: 'large' });
    expect(container.querySelector<HTMLElement>('[data-virtual-row]')?.style.gridTemplateColumns)
      .toBe('repeat(1, minmax(0, 1fr))');
    await scrollToEnd();
    expect(scroller().scrollTop).toBeGreaterThan(0);

    await render({ queryKey: 'new-search', items: items.slice(0, 40) });
    expect(scroller().scrollTop).toBe(0);
    expect(container.querySelector('[data-virtual-item-id="asset-0"]')).not.toBeNull();
  });

  it('keeps the focused card mounted while distant rows are visible', async () => {
    await render({ items: Array.from({ length: 2000 }, (_, index) => asset(index)), viewMode: 'list' });
    const firstAction = container.querySelector<HTMLButtonElement>('[data-virtual-item-id="asset-0"] button[title="Copy to Project"]');
    if (!firstAction) throw new Error('First card action was not rendered');
    await act(async () => firstAction.focus());
    await scrollToEnd();

    expect(document.activeElement).toBe(firstAction);
    expect(container.querySelector('[data-virtual-item-id="asset-0"]')).not.toBeNull();
    expect(container.querySelector('[data-virtual-item-id="asset-1999"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-virtual-row]').length).toBeLessThan(30);
  });

  it('remeasures expanded stack rows without overlapping later rows', async () => {
    const representative = asset(0);
    const stack: AssetStack & { isStack: true } = {
      id: 'stack-0', name: 'Stack 0', type: 'animation', itemCount: 1,
      representativeAssetId: representative.id, representativeAsset: representative,
      tags: [], createdAt: 0, isStack: true,
    };
    await render({ items: [stack, ...Array.from({ length: 40 }, (_, index) => asset(index + 1))], viewMode: 'list' });
    const secondRow = container.querySelector<HTMLElement>('[data-virtual-row][data-index="1"]');
    expect(secondRow?.style.transform).toBe('translateY(62px)');

    const expand = container.querySelector<HTMLButtonElement>('button[title="Expand to view content assets"]');
    if (!expand) throw new Error('Stack expansion button was not rendered');
    await act(async () => expand.click());
    await act(async () => {
      for (const observer of observers) observer.notifyAll();
    });

    expect(container.querySelector<HTMLElement>('[data-virtual-row][data-index="1"]')?.style.transform)
      .toBe('translateY(150px)');
  });
});
