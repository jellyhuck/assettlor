// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { Sidebar } from '../client/src/components/Sidebar.js';
import { TopBar } from '../client/src/components/TopBar.js';
import { ToastProvider, useToast } from '../client/src/components/Toast.js';

const emptySettings: ComponentProps<typeof Sidebar>['settings'] = {
  libraryPath: '',
  libraryPaths: [],
  activeProjectPath: '',
  projectPaths: [],
  thumbnailQuality: 80,
  autoStackAnimations: true,
  autoStackAudio: true,
  defaultFps: 12,
  catalogPaging: 'load-more',
};

function sidebarProps(overrides: Partial<ComponentProps<typeof Sidebar>> = {}): ComponentProps<typeof Sidebar> {
  return {
    selectedCategory: 'all',
    onSelectCategory: vi.fn(),
    selectedTag: null,
    onSelectTag: vi.fn(),
    selectedFormat: null,
    onSelectFormat: vi.fn(),
    selectedResolution: null,
    onSelectResolution: vi.fn(),
    tags: [],
    formats: [],
    resolutions: [],
    scanStatus: { status: 'idle', libraryPath: '', scannedCount: 0, indexedCount: 0 },
    onTriggerScan: vi.fn(),
    onCancelScan: vi.fn(),
    onOpenSettings: vi.fn(),
    settings: emptySettings,
    summary: { totalAssets: 0, imageCount: 0, audioCount: 0, animationStackCount: 0, audioStackCount: 0 },
    ...overrides,
  };
}

const mounted: Array<{ unmount: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((root) => root.unmount()));
  vi.useRealTimers();
});

describe('catalog controls', () => {
  it('guides empty libraries and forwards scan without a click event', async () => {
    const onTriggerScan = vi.fn();
    const onOpenSettings = vi.fn();
    const props = sidebarProps({ onTriggerScan, onOpenSettings });
    const root = await mountReact(createElement(Sidebar, props));
    mounted.push(root);

    const scan = Array.from(root.container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Scan')!;
    expect(scan.disabled).toBe(true);
    expect(root.container.textContent).toContain('Add a library in settings to enable scanning.');
    await click(Array.from(root.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Add a library'))!);
    expect(onOpenSettings).toHaveBeenCalledOnce();

    await root.render(createElement(Sidebar, {
      ...props,
      settings: { ...emptySettings, libraryPaths: ['  ', '/library/assets'] },
    }));
    expect(scan.disabled).toBe(false);
    await click(scan);
    expect(onTriggerScan).toHaveBeenCalledOnce();
    expect(onTriggerScan).toHaveBeenCalledWith();
  });

  it('offers cancellation and identifies partial scan results', async () => {
    const onCancelScan = vi.fn();
    const props = sidebarProps({
      onCancelScan,
      settings: { ...emptySettings, libraryPaths: ['/library/assets'] },
      scanStatus: { status: 'scanning', libraryPath: '/library/assets', scannedCount: 12, indexedCount: 8 },
    });
    const root = await mountReact(createElement(Sidebar, props));
    mounted.push(root);

    const cancel = Array.from(root.container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Cancel')!;
    expect(cancel.disabled).toBe(false);
    expect(root.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext'))
      .toBe('12 files scanned');
    await click(cancel);
    expect(onCancelScan).toHaveBeenCalledWith();

    await root.render(createElement(Sidebar, { ...props, scanActionPending: 'cancel' }));
    expect(cancel.disabled).toBe(true);
    expect(root.container.textContent).toContain('Cancelling...');

    await root.render(createElement(Sidebar, {
      ...props,
      scanStatus: {
        status: 'completed', libraryPath: '/library/assets', scannedCount: 12, indexedCount: 8,
        failedScopes: ['/library/assets/offline'], message: 'Partial scan: one directory was unavailable.',
      },
      scanActionPending: null,
    }));
    expect(Array.from(root.container.querySelectorAll('[role="status"]'))
      .some((status) => status.textContent?.includes('Partial scan'))).toBe(true);
    expect(root.container.textContent).toContain('80–<120 (Moderate)');
    expect(root.container.textContent).toContain('≥150 (High)');
  });

  it('keeps pending scans disabled and announces cancellation or failure', async () => {
    const onTriggerScan = vi.fn();
    const props = sidebarProps({
      onTriggerScan,
      settings: { ...emptySettings, libraryPaths: ['/library/assets'] },
      scanActionPending: 'start',
    });
    const root = await mountReact(createElement(Sidebar, props));
    mounted.push(root);
    const starting = Array.from(root.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Starting...'))!;
    expect(starting.disabled).toBe(true);
    await click(starting);
    expect(onTriggerScan).not.toHaveBeenCalled();

    await root.render(createElement(Sidebar, {
      ...props,
      scanActionPending: null,
      scanStatus: {
        status: 'idle', libraryPath: '/library/assets', scannedCount: 3, indexedCount: 0,
        message: 'Scan cancelled.',
      },
    }));
    expect(Array.from(root.container.querySelectorAll('[role="status"]'))
      .some((status) => status.textContent?.includes('Scan cancelled.'))).toBe(true);

    await root.render(createElement(Sidebar, {
      ...props,
      scanActionPending: null,
      scanStatus: {
        status: 'error', libraryPath: '/library/assets', scannedCount: 3, indexedCount: 0,
        error: 'Cannot read library', message: 'Scan failed: Cannot read library',
      },
    }));
    expect(root.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Cannot read library');
  });

  it('shows loaded results and contains Escape within search controls', async () => {
    const onSearchChange = vi.fn();
    const root = await mountReact(createElement(TopBar, {
      searchQuery: 'coin', onSearchChange,
      viewMode: 'grid', onViewModeChange: vi.fn(),
      isStackedView: true, onToggleStackedView: vi.fn(),
      cardZoom: 'medium', onCardZoomChange: vi.fn(),
      sortBy: 'name', sortOrder: 'asc', onSortChange: vi.fn(),
      totalItems: 250, loadedItems: 75,
    }));
    mounted.push(root);
    expect(root.container.querySelector('[role="status"]')?.textContent).toContain('75 of 250 matches');
    expect(root.container.querySelector('button[aria-label="Grid view"]')).not.toBeNull();
    expect(root.container.querySelector('select[aria-label="Sort assets"]')).not.toBeNull();

    const onWindowKeyDown = vi.fn();
    window.addEventListener('keydown', onWindowKeyDown);
    try {
      const input = root.container.querySelector<HTMLInputElement>('input[aria-label="Search assets"]')!;
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(onSearchChange).toHaveBeenCalledWith('');
      expect(onWindowKeyDown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown);
    }
  });

  it('keeps search, view, sort, and filter help operable at narrow width', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 420 });
    const onSearchChange = vi.fn();
    const onViewModeChange = vi.fn();
    const onToggleStackedView = vi.fn();
    const onSortChange = vi.fn();
    try {
      const root = await mountReact(createElement(TopBar, {
        searchQuery: 'coin', onSearchChange,
        viewMode: 'grid', onViewModeChange,
        isStackedView: true, onToggleStackedView,
        cardZoom: 'medium', onCardZoomChange: vi.fn(),
        sortBy: 'name', sortOrder: 'asc', onSortChange,
        totalItems: 250, loadedItems: 75,
      }));
      mounted.push(root);
      expect(root.container.querySelector('input[aria-label="Search assets"]')).not.toBeNull();
      await click(root.container.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!);
      await click(root.container.querySelector<HTMLButtonElement>('button[aria-label="Show all files in flat view"]')!);
      expect(onViewModeChange).toHaveBeenCalledWith('list');
      expect(onToggleStackedView).toHaveBeenCalledOnce();

      const sort = root.container.querySelector<HTMLSelectElement>('select[aria-label="Sort assets"]')!;
      await act(async () => {
        sort.value = 'bpm_desc';
        sort.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onSortChange).toHaveBeenCalledWith('bpm', 'desc');

      await click(root.container.querySelector<HTMLButtonElement>('button[aria-label="Search filter syntax guide"]')!);
      const fast = Array.from(root.container.querySelectorAll('button'))
        .find((button) => button.textContent === 'bpm:fast')!;
      await click(fast);
      expect(onSearchChange).toHaveBeenCalledWith('coin bpm:fast');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('clears toast timers on dismissal and unmount', async () => {
    vi.useFakeTimers();
    function ToastHost() {
      const { showToast } = useToast();
      return createElement('button', {
        onClick: () => showToast('error', 'Scan failed', 'Could not read the library'),
      }, 'Show toast');
    }
    const root = await mountReact(createElement(ToastProvider, null, createElement(ToastHost)));
    mounted.push(root);
    await click(root.container.querySelector('button')!);
    expect(root.container.querySelector('[role="alert"]')?.textContent).toContain('Scan failed');
    expect(vi.getTimerCount()).toBe(1);

    await click(root.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss Scan failed"]')!);
    expect(root.container.querySelector('[role="alert"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await click(root.container.querySelector('button')!);
    expect(vi.getTimerCount()).toBe(1);
    await root.unmount();
    mounted.splice(mounted.indexOf(root), 1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
