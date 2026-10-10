// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderBrowserModal } from '../client/src/components/FolderBrowserModal.js';
import { createDeferredFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact, useState } from '../client/tests/reactDomHarness.js';

function listing(currentPath: string, directories: Array<{ name: string; path: string }> = []) {
  return { currentPath, parentPath: currentPath === '/' ? null : '/', directories };
}

describe('FolderBrowserModal loaded-folder selection', () => {
  let fetchQueue: ReturnType<typeof createDeferredFetch>;
  let view: Awaited<ReturnType<typeof mountReact>> | null;
  let onClose: ReturnType<typeof vi.fn>;
  let onSelect: ReturnType<typeof vi.fn>;

  function modal(isOpen: boolean, initialPath?: string) {
    return <FolderBrowserModal
      isOpen={isOpen}
      initialPath={initialPath}
      title="Select directory"
      onClose={onClose}
      onSelect={onSelect}
    />;
  }

  async function open(initialPath?: string) {
    view = await mountReact(modal(true, initialPath));
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(view!.container.querySelectorAll('button')).find((candidate) =>
      candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label);
    if (!found) throw new Error(`Button not found: ${label}`);
    return found;
  }

  async function resolve(index: number, value: unknown, status = 200) {
    await act(async () => { fetchQueue.requests[index].resolveJson(value, status); });
  }

  beforeEach(() => {
    fetchQueue = createDeferredFetch();
    vi.stubGlobal('fetch', fetchQueue.fetcher);
    view = null;
    onClose = vi.fn();
    onSelect = vi.fn();
  });

  afterEach(async () => {
    await view?.unmount();
    vi.unstubAllGlobals();
  });

  it('selects an empty valid folder only after its read succeeds', async () => {
    await open('/empty');
    expect(fetchQueue.requests[0].url).toBe('/api/fs/browse?path=%2Fempty');
    expect(button('Choose Folder').disabled).toBe(true);
    expect(view!.container.textContent).toContain('Opening: /empty');
    await resolve(0, listing('/empty'));
    expect(view!.container.textContent).toContain('No subdirectories found');
    expect(button('Choose Folder').disabled).toBe(false);
    await click(button('Choose Folder'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('/empty');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores an older navigation after a parent request wins', async () => {
    await open('/library');
    await resolve(0, listing('/library', [{ name: 'child', path: '/library/child' }]));
    await click(button('child'));
    expect(button('Choose Folder').disabled).toBe(true);
    expect(view!.container.textContent).toContain('Opening: /library/child');
    await click(button('Go to parent directory'));
    expect(fetchQueue.requests[1].init?.signal?.aborted).toBe(true);
    expect(button('Choose Folder').disabled).toBe(true);
    await resolve(2, listing('/'));
    await resolve(1, listing('/library/child'));
    expect(view!.container.textContent).toContain('Selected: /');
    expect(view!.container.textContent).not.toContain('Selected: /library/child');
    await click(button('Choose Folder'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('/');
  });

  it('resets on an initialPath change and ignores the old response', async () => {
    await open('/old');
    await view!.render(modal(true, '/new'));
    expect(fetchQueue.requests[0].init?.signal?.aborted).toBe(true);
    expect(button('Choose Folder').disabled).toBe(true);
    await resolve(1, listing('/new'));
    await resolve(0, listing('/old'));
    expect(view!.container.textContent).toContain('Selected: /new');

    await view!.render(modal(false, '/new'));
    expect(view!.container.querySelector('[role="dialog"]')).toBeNull();
    await view!.render(modal(true, '/reopened'));
    expect(button('Choose Folder').disabled).toBe(true);
    expect(view!.container.textContent).toContain('Opening: /reopened');
    await resolve(2, listing('/reopened'));
    await click(button('Choose Folder'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('/reopened');
  });

  it('does not apply a read that finishes after close and reopen', async () => {
    await open('/before-close');
    await view!.render(modal(false, '/before-close'));
    expect(fetchQueue.requests[0].init?.signal?.aborted).toBe(true);
    await view!.render(modal(true, '/after-reopen'));
    await resolve(1, listing('/after-reopen'));
    await resolve(0, listing('/before-close'));
    expect(view!.container.textContent).toContain('Selected: /after-reopen');
    await click(button('Choose Folder'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('/after-reopen');
  });

  it('reports a failed destination and allows retry without selecting the previous folder', async () => {
    await open('/library');
    await resolve(0, listing('/library', [{ name: 'missing', path: '/library/missing' }]));
    await click(button('missing'));
    await resolve(1, { error: 'Directory does not exist' }, 404);
    expect(view!.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Cannot open /library/missing: Directory does not exist');
    expect(view!.container.textContent).toContain('Unavailable: /library/missing');
    expect(button('Choose Folder').disabled).toBe(true);
    await click(button('Retry'));
    expect(button('Choose Folder').disabled).toBe(true);
    await resolve(2, listing('/library/missing'));
    await click(button('Choose Folder'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('/library/missing');
  });

  it('rejects malformed responses and network failures', async () => {
    await open('/library');
    await resolve(0, { currentPath: '/library', parentPath: null, directories: 'invalid' });
    expect(button('Choose Folder').disabled).toBe(true);
    expect(view!.container.querySelector('[role="alert"]')?.textContent).toContain('unexpected shape');
    await click(button('Retry'));
    await act(async () => { fetchQueue.requests[1].response.reject(new TypeError('Network unavailable')); });
    expect(view!.container.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable');
    expect(button('Choose Folder').disabled).toBe(true);
  });

  it('enters focus and restores the opener after Escape', async () => {
    function Host() {
      const [isOpen, setIsOpen] = useState(false);
      return <>
        <button onClick={() => setIsOpen(true)}>Open browser</button>
        <FolderBrowserModal
          isOpen={isOpen}
          initialPath="/library"
          title="Select directory"
          onSelect={onSelect}
          onClose={() => setIsOpen(false)}
        />
      </>;
    }

    view = await mountReact(<Host />);
    const opener = button('Open browser');
    opener.focus();
    await click(opener);
    const closeButton = button('Close folder browser');
    expect(document.activeElement).toBe(closeButton);
    await act(async () => {
      closeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
