// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferredFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { parseScanStatus, useScanStatus } from '../client/src/lib/useScanStatus.js';

const scan = (status: 'idle' | 'scanning' | 'completed' | 'error', startTime = 10) => ({
  status, libraryPath: '/library', libraryPaths: ['/library'],
  scannedCount: 3, indexedCount: 2, startTime,
});

function StatusView({ open, interval = 100 }: { open: boolean; interval?: number }) {
  const { status, error, refresh } = useScanStatus(open, interval);
  return <div>
    <output data-testid="status">{status?.status ?? 'unloaded'}</output>
    <output data-testid="error">{error ?? ''}</output>
    <button onClick={() => { void refresh(); }}>Refresh</button>
  </div>;
}

describe('useScanStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads on open, polls through completion, and rejects stale responses', async () => {
    vi.useFakeTimers();
    const { fetcher, requests } = createDeferredFetch();
    vi.stubGlobal('fetch', fetcher);
    const view = await mountReact(<StatusView open />);
    try {
      expect(requests.map((request) => request.url)).toEqual(['/api/scan/status']);
      await click(view.container.querySelector('button')!);
      expect(requests).toHaveLength(2);
      expect(requests[0].init?.signal?.aborted).toBe(true);

      await act(async () => { requests[1].resolveJson(scan('scanning')); });
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('scanning');
      await act(async () => { requests[0].resolveJson(scan('completed', 1)); });
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('scanning');

      await act(async () => { vi.advanceTimersByTime(100); });
      expect(requests).toHaveLength(3);
      await act(async () => { requests[2].resolveJson(scan('completed')); });
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('completed');

      await view.render(<StatusView open={false} />);
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('unloaded');
      await act(async () => { vi.advanceTimersByTime(500); });
      expect(requests).toHaveLength(3);

      await view.render(<StatusView open />);
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('unloaded');
      expect(requests).toHaveLength(4);
      await act(async () => { requests[3].resolveJson(scan('scanning', 20)); });
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('scanning');
    } finally {
      await view.unmount();
    }
  });

  it('shows failed reads, retries while open, and aborts a pending read on close', async () => {
    vi.useFakeTimers();
    const { fetcher, requests } = createDeferredFetch();
    vi.stubGlobal('fetch', fetcher);
    const view = await mountReact(<StatusView open />);
    try {
      await act(async () => { requests[0].resolveJson({ error: 'Status unavailable' }, 503); });
      expect(view.container.querySelector('[data-testid="error"]')?.textContent).toBe('Status unavailable');
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('unloaded');

      await act(async () => { vi.advanceTimersByTime(100); });
      expect(requests).toHaveLength(2);
      await act(async () => { requests[1].resolveJson(scan('scanning')); });
      expect(view.container.querySelector('[data-testid="error"]')?.textContent).toBe('');
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('scanning');

      await act(async () => { vi.advanceTimersByTime(100); });
      expect(requests).toHaveLength(3);
      await act(async () => { vi.advanceTimersByTime(300); });
      expect(requests).toHaveLength(3);
      await view.render(<StatusView open={false} />);
      expect(requests[2].init?.signal?.aborted).toBe(true);
      await act(async () => { requests[2].resolveJson(scan('error')); });
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('unloaded');
      await act(async () => { vi.advanceTimersByTime(300); });
      expect(requests).toHaveLength(3);
    } finally {
      await view.unmount();
    }
  });

  it('rejects malformed status payloads before they enter typed UI state', async () => {
    expect(() => parseScanStatus({ status: 'scanning', libraryPath: '/library',
      scannedCount: 'many', indexedCount: 1 })).toThrow('unexpected shape');
    expect(() => parseScanStatus({ ...scan('completed'), failedScopes: [4] })).toThrow('unexpected shape');
    expect(() => parseScanStatus({ ...scan('scanning'), phase: 'sorting' })).toThrow('unexpected shape');
    expect(() => parseScanStatus({ ...scan('scanning'), totalCount: Infinity })).toThrow('unexpected shape');
    expect(() => parseScanStatus({ ...scan('scanning'), processedCount: '3' })).toThrow('unexpected shape');
    expect(parseScanStatus({ ...scan('scanning'), phase: 'indexing', totalCount: 4, processedCount: 1 }).totalCount)
      .toBe(4);
    expect(parseScanStatus(scan('idle')).status).toBe('idle');

    const { fetcher, requests } = createDeferredFetch();
    vi.stubGlobal('fetch', fetcher);
    const view = await mountReact(<StatusView open />);
    try {
      await act(async () => { requests[0].resolveJson({ status: 'scanning' }); });
      expect(view.container.querySelector('[data-testid="error"]')?.textContent)
        .toContain('unexpected shape');
      expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('unloaded');
    } finally {
      await view.unmount();
    }
  });
});
