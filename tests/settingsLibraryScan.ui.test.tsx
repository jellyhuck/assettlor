// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../client/src/components/SettingsModal.js';
import { ToastProvider } from '../client/src/components/Toast.js';
import { createDeferredFetch, type PendingFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact, useState } from '../client/tests/reactDomHarness.js';

const appSettings = {
  libraryPath: '/library', libraryPaths: ['/library'],
  activeProjectPath: '/project', projectPaths: ['/project'],
  thumbnailQuality: 80, autoStackAnimations: true,
  autoStackAudio: true, defaultFps: 12, catalogPaging: 'load-more',
};

const classifier = (id: string) => ({
  id, name: id, description: id, category: 'audio', steps: [],
  settings: id === 'bpm'
    ? { enabled: true, minBpm: 60, maxBpm: 200, minDurationSeconds: 1, maxAnalysisSeconds: 45 }
    : id === 'sprite'
      ? { enabled: true, minConfidence: 0.5, enableVisualAnalysis: true,
        enablePathAnalysis: true, enableStackAnalysis: true }
      : id === 'folder'
        ? { enabled: true, includeArchiveFolders: true }
        : { enabled: true, inferFromArchive: true, inferFromDirectory: true,
          directoryStrategy: 'top', directoryDepth: 1, cleanSeparators: true,
          stripVersionSuffix: true, stripAffixes: false, caseConvention: 'as-is' },
});

const scanStatus = (
  status: 'idle' | 'scanning' | 'completed' | 'error',
  startTime = 900,
  message?: string,
) => ({
  status, libraryPath: '/library', libraryPaths: ['/library'],
  scannedCount: 3, indexedCount: 2, startTime, message,
});

function Host() {
  const [isOpen, setIsOpen] = useState(true);
  return <>
    <button onClick={() => setIsOpen(true)}>Open settings</button>
    <SettingsModal isOpen={isOpen} onClose={() => setIsOpen(false)} onSettingsSaved={() => {}} />
  </>;
}

describe('SettingsModal library scan lifecycle', () => {
  let fetchQueue: ReturnType<typeof createDeferredFetch>;
  let view: Awaited<ReturnType<typeof mountReact>> | null;

  function requests(url: string): PendingFetch[] {
    return fetchQueue.requests.filter((request) => request.url === url);
  }

  async function respond(request: PendingFetch, value: unknown, status = 200) {
    await act(async () => { request.resolveJson(value, status); });
  }

  async function loadOpenDialog(fromIndex: number, status = scanStatus('idle')) {
    const batch = fetchQueue.requests.slice(fromIndex);
    const responseByUrl: Record<string, unknown> = {
      '/api/settings': appSettings,
      '/api/classifiers/bpm': classifier('bpm'),
      '/api/classifiers/sprite': classifier('sprite'),
      '/api/classifiers/pack': classifier('pack'),
      '/api/classifiers/folder': classifier('folder'),
      '/api/scan/status': status,
    };
    expect(batch.map((request) => request.url).sort()).toEqual(Object.keys(responseByUrl).sort());
    await act(async () => {
      for (const request of batch) request.resolveJson(responseByUrl[request.url]);
    });
    expect(view!.container.textContent).toContain('Asset Library Source Directories');
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(view!.container.querySelectorAll('button')).find((candidate) =>
      candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label);
    if (!found) throw new Error(`Button not found: ${label}`);
    return found;
  }

  function libraryRow(path: string): HTMLElement {
    const pathLabel = view!.container.querySelector<HTMLElement>(`span[title="${path}"]`);
    const row = pathLabel?.parentElement?.parentElement?.parentElement?.parentElement;
    if (!row) throw new Error(`Library row not found for ${path}`);
    return row;
  }

  function rowButton(path: string, label: string): HTMLButtonElement {
    const found = Array.from(libraryRow(path).querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.trim() === label || candidate.title === label);
    if (!found) throw new Error(`${label} button not found for ${path}`);
    return found;
  }

  // Labels change while busy; titles name the action.
  function titledButton(path: string, selector: string, action: string): HTMLButtonElement {
    const found = libraryRow(path).querySelector<HTMLButtonElement>(selector);
    if (!found) throw new Error(`${action} button not found for ${path}`);
    return found;
  }
  const scanButton = (path: string) => titledButton(path,
    'button[title^="Scan this"], button[title="Save this library before scanning"]', 'Scan');
  const reindexButton = (path: string) => titledButton(path,
    'button[title^="Delete this library"], button[title="Save this library before reindexing"]', 'Reindex');

  async function startScan(path = '/library') {
    await click(scanButton(path));
    const request = requests('/api/scan/library').at(-1)!;
    expect(request.init?.method).toBe('POST');
    expect(JSON.parse(String(request.init?.body))).toEqual({ libraryPath: path });
    return request;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    fetchQueue = createDeferredFetch();
    vi.stubGlobal('fetch', fetchQueue.fetcher);
    view = await mountReact(<ToastProvider><Host /></ToastProvider>);
    await loadOpenDialog(0);
  });

  afterEach(async () => {
    await view?.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('allows saved libraries and blocks a new library in the draft', async () => {
    const input = view!.container.querySelector<HTMLInputElement>('input[placeholder="Add asset library path..."]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '/draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const add = input.parentElement!.querySelector<HTMLButtonElement>('button:last-child')!;
    await click(add);
    await respond(requests('/api/fs/validate')[0], {
      exists: true, isDirectory: true, resolvedPath: '/draft',
    });

    expect(scanButton('/library').disabled).toBe(false);
    expect(reindexButton('/library').disabled).toBe(false);
    expect(scanButton('/draft').disabled).toBe(true);
    expect(reindexButton('/draft').disabled).toBe(true);
    await startScan('/library');
    expect(requests('/api/scan/library')).toHaveLength(1);
  });

  it('shows validation errors for rejected starts and lets the user retry', async () => {
    const start = await startScan();
    expect(scanButton('/library').disabled).toBe(true);
    await respond(start, { error: 'Invalid library path' }, 400);
    expect(scanButton('/library').disabled).toBe(true);
    expect(requests('/api/scan/status')).toHaveLength(2);
    await respond(requests('/api/scan/status')[1], scanStatus('idle'));
    expect(view!.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Cannot scan this directory: Invalid library path');
    expect(scanButton('/library').disabled).toBe(false);
  });

  it('refreshes a conflicting job before allowing another start', async () => {
    const start = await startScan();
    await respond(start, { error: 'A scan is already running' }, 409);
    expect(scanButton('/library').disabled).toBe(true);
    expect(requests('/api/scan/status')).toHaveLength(2);
    await respond(requests('/api/scan/status')[1], scanStatus('scanning', 1001));
    expect(view!.container.textContent).toContain('A scan is already running');
    expect(scanButton('/library').disabled).toBe(true);
    expect(requests('/api/scan/library')).toHaveLength(1);
  });

  it('checks status after a lost start response before allowing a retry', async () => {
    const start = await startScan();
    await act(async () => { start.response.reject(new TypeError('Connection lost')); });
    expect(scanButton('/library').disabled).toBe(true);
    expect(requests('/api/scan/status')).toHaveLength(2);
    await respond(requests('/api/scan/status')[1], scanStatus('scanning', 1001));
    expect(view!.container.textContent).toContain('Connection lost');
    expect(scanButton('/library').disabled).toBe(true);
    expect(requests('/api/scan/library')).toHaveLength(1);
  });

  it('stays busy through delayed status, then releases after cancellation', async () => {
    const start = await startScan();
    expect(scanButton('/library').disabled).toBe(true);
    await respond(start, { message: 'Scan started' });
    expect(requests('/api/scan/status')).toHaveLength(2);
    await respond(requests('/api/scan/status')[1], scanStatus('idle'));
    expect(scanButton('/library').disabled).toBe(true);
    expect(view!.container.textContent).toContain('Waiting for the new scan status');

    await act(async () => { vi.advanceTimersByTime(1000); });
    await respond(requests('/api/scan/status')[2], scanStatus('scanning', 1001));
    expect(scanButton('/library').disabled).toBe(true);
    expect(view!.container.textContent).toContain('Scan running');

    await act(async () => { vi.advanceTimersByTime(1000); });
    await respond(requests('/api/scan/status')[3], scanStatus('idle', 1001, 'Scan cancelled.'));
    expect(view!.container.textContent).toContain('Scan cancelled.');
    expect(scanButton('/library').disabled).toBe(false);
  });

  it('recovers the active job after close and reopen without starting another scan', async () => {
    const start = await startScan();
    await respond(start, { message: 'Scan started' });
    await respond(requests('/api/scan/status')[1], scanStatus('scanning', 1001));
    expect(scanButton('/library').disabled).toBe(true);
    await click(button('Close settings'));
    expect(view!.container.querySelector('[role="dialog"]')).toBeNull();

    const reopenAt = fetchQueue.requests.length;
    await click(button('Open settings'));
    await loadOpenDialog(reopenAt, scanStatus('scanning', 1001));
    expect(scanButton('/library').disabled).toBe(true);
    expect(requests('/api/scan/library')).toHaveLength(1);

    await act(async () => { vi.advanceTimersByTime(1000); });
    await respond(requests('/api/scan/status')[3], scanStatus('completed', 1001));
    expect(scanButton('/library').disabled).toBe(false);
  });

  it('confirms a reindex and sends the user tag choice', async () => {
    await click(reindexButton('/library'));
    const prompt = view!.container.querySelector<HTMLElement>('[role="group"][aria-label="Reindex library"]')!;
    expect(prompt.textContent).toContain('deletes this library');
    const keepTags = prompt.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(keepTags.checked).toBe(true);
    await click(Array.from(prompt.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!);
    expect(view!.container.querySelector('[aria-label="Reindex library"]')).toBeNull();
    expect(requests('/api/scan/library')).toHaveLength(0);

    await click(reindexButton('/library'));
    const reopened = view!.container.querySelector<HTMLElement>('[aria-label="Reindex library"]')!;
    await click(reopened.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(Array.from(reopened.querySelectorAll('button')).find((b) => b.textContent === 'Reindex')!);
    const request = requests('/api/scan/library').at(-1)!;
    expect(JSON.parse(String(request.init?.body)))
      .toEqual({ libraryPath: '/library', reindex: true, keepUserTags: false });
    await respond(request, { message: 'Reindex started' });
    await respond(requests('/api/scan/status')[1], { ...scanStatus('scanning', 1001), reindexing: true });
    expect(reindexButton('/library').textContent).toContain('Reindexing');
    expect(scanButton('/library').textContent).toContain('Scan');
  });

  it('asks before removing a saved library and purges its index on save', async () => {
    await click(rowButton('/library', 'Remove'));
    const prompt = view!.container.querySelector<HTMLElement>('[aria-label="Remove library"]')!;
    expect(prompt.textContent).toContain('also deletes its index');
    await click(Array.from(prompt.querySelectorAll('button')).find((b) => b.textContent === 'Remove library and index')!);
    expect(view!.container.querySelector('span[title="/library"]')).toBeNull();
    expect(view!.container.textContent).toContain('Saving deletes the index of the removed library');

    await click(button('Save Settings'));
    const save = requests('/api/settings').find((request) => request.init?.method === 'POST')!;
    expect(JSON.parse(String(save.init?.body))).toMatchObject({ libraryPaths: [], purgeRemovedLibraries: true });
  });

  it('removes an unsaved library without asking', async () => {
    const input = view!.container.querySelector<HTMLInputElement>('input[placeholder="Add asset library path..."]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '/draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(input.parentElement!.querySelector<HTMLButtonElement>('button:last-child')!);
    await respond(requests('/api/fs/validate')[0], { exists: true, isDirectory: true, resolvedPath: '/draft' });

    await click(rowButton('/draft', 'Remove'));
    expect(view!.container.querySelector('[aria-label="Remove draft"]')).toBeNull();
    expect(view!.container.querySelector('span[title="/draft"]')).toBeNull();
    expect(view!.container.textContent).not.toContain('Saving deletes the index');
  });
});
