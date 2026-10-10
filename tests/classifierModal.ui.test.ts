// @vitest-environment jsdom
import { act, createElement, Fragment, useState, createRoot, type Root } from '../client/tests/reactDomHarness.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassifierModal } from '../client/src/components/ClassifierModal.js';
import { ToastProvider } from '../client/src/components/Toast.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const classifiers = [
  {
    id: 'bpm', name: 'BPM', description: 'Detect music tempo', category: 'audio',
    steps: [{ id: 'decode', name: 'Decode', description: 'Read audio' }], settings: { enabled: true },
  },
  {
    id: 'sprite', name: 'Sprite', description: 'Classify sprites', category: 'image',
    steps: [{ id: 'visual', name: 'Visual', description: 'Read image' }], settings: { enabled: true },
  },
];

const inventory = {
  directories: [{ value: 'Library/music', label: 'Library/music' }],
  archives: [{ value: '/Library/pack.zip', label: 'Library/pack.zip' }],
  assets: [{ value: 'audio-1', label: 'Library/music/track.wav', category: 'audio' }],
};

const bpmRun = {
  classifierId: 'bpm', targetType: 'all', totalTargeted: 1, processedCount: 1,
  classifiedCount: 1, failedCount: 0, noResultCount: 0, errorCount: 0,
  details: [{ assetId: 'audio-1', assetPath: 'Library/music/track.wav',
    success: true, outcome: 'classified', result: { bpm: 120 } }],
  elapsedMs: 50,
};

function Host({ onRunComplete, initialOpen }: { onRunComplete: () => void; initialOpen: boolean }) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  return createElement(Fragment, null,
    createElement('button', { onClick: () => setIsOpen(true) }, 'Open modal'),
    createElement(ClassifierModal, {
      isOpen,
      onClose: () => setIsOpen(false),
      onRunComplete,
    }),
  );
}

describe('ClassifierModal request and dialog behavior', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queued: Map<string, Deferred<Response>[]>;
  let requests: Array<{ url: string; signal?: AbortSignal }>;

  function queue(url: string, value?: unknown): Deferred<Response> {
    const next = deferred<Response>();
    const list = queued.get(url) ?? [];
    list.push(next);
    queued.set(url, list);
    if (value !== undefined) next.resolve(Response.json(value));
    return next;
  }

  async function resolveJson(next: Deferred<Response>, value: unknown) {
    await act(async () => { next.resolve(Response.json(value)); });
  }

  async function mount(onRunComplete = vi.fn(), initialOpen = true) {
    await act(async () => {
      root.render(createElement(ToastProvider, null,
        createElement(Host, { onRunComplete, initialOpen })));
    });
    return onRunComplete;
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.getAttribute('aria-label') === label || candidate.textContent?.includes(label));
    if (!found) throw new Error(`Button not found: ${label}`);
    return found;
  }

  async function click(label: string) {
    await act(async () => { button(label).click(); });
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queued = new Map();
    requests = [];
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, signal: init?.signal ?? undefined });
      const next = queued.get(url)?.shift();
      if (!next) throw new Error(`Unexpected request: ${url}`);
      return next.promise;
    }));
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('disables Run while a required target inventory is loading or unselected', async () => {
    queue('/api/classifiers', classifiers);
    const targets = queue('/api/classifiers/targets');
    await mount();
    await click('Specific Directory');

    expect(button('Run Classifier').disabled).toBe(true);
    expect(container.textContent).toContain('Loading available targets');

    await resolveJson(targets, inventory);
    expect(button('Run Classifier').disabled).toBe(true);
    const select = container.querySelector<HTMLSelectElement>('#classifier-target')!;
    await act(async () => {
      select.value = 'Library/music';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(button('Run Classifier').disabled).toBe(false);
  });

  it('ignores stale inventory after close and reopen', async () => {
    queue('/api/classifiers', classifiers);
    const oldTargets = queue('/api/classifiers/targets');
    queue('/api/classifiers', classifiers);
    const newTargets = queue('/api/classifiers/targets');
    await mount();
    await click('Close classifiers');
    expect(requests.find((item) => item.url === '/api/classifiers/targets')?.signal?.aborted).toBe(true);
    await click('Open modal');
    await resolveJson(newTargets, {
      ...inventory,
      directories: [{ value: 'New/music', label: 'New/music' }],
    });
    await click('Specific Directory');
    await resolveJson(oldTargets, {
      ...inventory,
      directories: [{ value: 'Old/music', label: 'Old/music' }],
    });

    const labels = Array.from(container.querySelectorAll('#classifier-target option'))
      .map((option) => option.textContent);
    expect(labels).toContain('New/music');
    expect(labels).not.toContain('Old/music');
  });

  it('keeps a newly selected classifier clear of an older delayed run', async () => {
    queue('/api/classifiers', classifiers);
    queue('/api/classifiers/targets', inventory);
    const run = queue('/api/classifiers/bpm/run');
    const onRunComplete = vi.fn();
    await mount(onRunComplete);
    await click('Run Classifier');
    await click('Sprite');
    await resolveJson(run, bpmRun);

    expect(button('Sprite').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).not.toContain('Classification Results');
    expect(container.textContent).not.toContain('BPM Completed');
    expect(onRunComplete).toHaveBeenCalledOnce();
  });

  it('refreshes after a closed dialog run completes without stale UI', async () => {
    queue('/api/classifiers', classifiers);
    queue('/api/classifiers/targets', inventory);
    const run = queue('/api/classifiers/bpm/run');
    const onRunComplete = vi.fn();
    await mount(onRunComplete);
    await click('Run Classifier');
    await click('Close classifiers');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(requests.find((item) => item.url === '/api/classifiers/bpm/run')?.signal?.aborted).toBe(false);
    const latestOnRunComplete = vi.fn();
    await act(async () => {
      root.render(createElement(ToastProvider, null,
        createElement(Host, { onRunComplete: latestOnRunComplete, initialOpen: true })));
    });

    await resolveJson(run, bpmRun);
    expect(onRunComplete).not.toHaveBeenCalled();
    expect(latestOnRunComplete).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain('BPM Completed');
  });

  it('restores focus to the opener after Escape', async () => {
    queue('/api/classifiers', classifiers);
    queue('/api/classifiers/targets', inventory);
    await mount(vi.fn(), false);
    const opener = button('Open modal');
    opener.focus();
    await click('Open modal');
    const close = button('Close classifiers');
    expect(document.activeElement).toBe(close);

    await act(async () => {
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
