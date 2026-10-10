// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetStack } from '../shared/types.js';
import { createDeferredFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { CopyModal } from '../client/src/components/CopyModal.js';
import { ToastProvider } from '../client/src/components/Toast.js';

function asset(id: string): Asset {
  return {
    id, path: `${id}.png`, absolutePath: `/library/${id}.png`,
    name: `${id}.png`, extension: '.png', category: 'image', size: 10, mtime: 1,
    hash: id, isArchiveEntry: false, thumbnailUrl: `/thumb/${id}`,
    fileUrl: `/file/${id}`, metadata: {}, tags: [], createdAt: 1, updatedAt: 1,
  };
}

function stack(id: string, representative = asset(`${id}-first`)): AssetStack {
  return {
    id, name: `Stack ${id}`, type: 'animation', itemCount: 2,
    representativeAssetId: representative.id, representativeAsset: representative,
    tags: [], createdAt: 1,
  };
}

type Props = Parameters<typeof CopyModal>[0];
const renderModal = (props: Props) => (
  <ToastProvider><CopyModal {...props} /></ToastProvider>
);

function CopyHost({ onClose }: { onClose: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  return <ToastProvider>
    <button onClick={() => setIsOpen(true)}>Launch copy</button>
    <CopyModal isOpen={isOpen} onClose={() => { onClose(); setIsOpen(false); }}
      asset={asset('sprite')} projectPaths={['/project']} targetDir="/project" />
  </ToastProvider>;
}

function confirm(container: HTMLElement): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.includes('Confirm Copy') || button.textContent?.includes('Copying...'),
  )!;
}

function payload(request: { init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(request.init?.body)) as Record<string, unknown>;
}

describe('CopyModal request and destination lifecycle', () => {
  const pending = createDeferredFetch();
  const onClose = vi.fn();
  let view: Awaited<ReturnType<typeof mountReact>> | null = null;

  afterEach(async () => {
    await view?.unmount();
    view = null;
    pending.requests.length = 0;
    onClose.mockReset();
    vi.unstubAllGlobals();
  });

  it('follows the active destination until a user chooses another available project', async () => {
    vi.stubGlobal('fetch', pending.fetcher);
    const current = asset('sprite');
    view = await mountReact(renderModal({
      isOpen: true, onClose, asset: current, targetDir: '/project/first',
      projectPaths: ['/project/first', '/project/second'],
    }));
    const select = view.container.querySelector('select')!;
    expect(select.value).toBe('/project/first');

    await view.render(renderModal({
      isOpen: true, onClose, asset: current, targetDir: '/project/second',
      projectPaths: ['/project/first', '/project/second'],
    }));
    expect(select.value).toBe('/project/second');

    await act(async () => {
      select.value = '/project/first';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await view.render(renderModal({
      isOpen: true, onClose, asset: current, targetDir: '/project/second',
      projectPaths: ['/project/first', '/project/second', '/project/third'],
    }));
    expect(select.value).toBe('/project/first');

    await view.render(renderModal({
      isOpen: true, onClose, asset: current, targetDir: '/project/third',
      projectPaths: ['/project/second', '/project/third'],
    }));
    expect(select.value).toBe('/project/third');
    await click(confirm(view.container));
    expect(payload(pending.requests[0])).toEqual({ assetId: 'sprite', targetPath: '/project/third' });
  });

  it('keeps an explicitly empty project list empty and disables copy without an item', async () => {
    vi.stubGlobal('fetch', pending.fetcher);
    view = await mountReact(renderModal({
      isOpen: true, onClose, asset: asset('sprite'), targetDir: '/old-scalar',
      projectPaths: [],
    }));
    expect(confirm(view.container).disabled).toBe(true);
    expect(view.container.textContent).toContain('No project destination configured');
    expect(pending.requests).toHaveLength(0);

    await view.render(renderModal({
      isOpen: true, onClose, targetDir: '/old-scalar', projectPaths: ['/project/one'],
    }));
    expect(confirm(view.container).disabled).toBe(true);
  });

  it('submits a full stack or the selected member and blocks duplicate submits', async () => {
    vi.stubGlobal('fetch', pending.fetcher);
    const representative = asset('first');
    const selectedMember = asset('second');
    const selectedStack = stack('frames', representative);
    view = await mountReact(renderModal({
      isOpen: true, onClose, asset: selectedMember, stack: selectedStack,
      targetDir: '/project', projectPaths: ['/project'],
    }));

    await act(async () => {
      confirm(view!.container).click();
      confirm(view!.container).click();
    });
    expect(pending.requests).toHaveLength(1);
    expect(payload(pending.requests[0])).toEqual({
      stackId: 'frames', copyStackAll: true, targetPath: '/project',
    });
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Stack frames');
    expect(confirm(view.container).disabled).toBe(true);
    await act(async () => pending.requests[0].resolveJson({ error: 'Try again' }, 500));

    const singleFile = Array.from(view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'))[1];
    await click(singleFile);
    expect(view.container.textContent).toContain('Copy Selected File Only');
    await click(confirm(view.container));
    expect(payload(pending.requests[1])).toEqual({ assetId: 'second', targetPath: '/project' });
  });

  it('keeps the submitted operation visible when props change and leaves the new item open', async () => {
    vi.stubGlobal('fetch', pending.fetcher);
    view = await mountReact(renderModal({
      isOpen: true, onClose, stack: stack('old'), projectPaths: ['/project/old'],
      targetDir: '/project/old',
    }));
    await click(confirm(view.container));
    await view.render(renderModal({
      isOpen: true, onClose, stack: stack('new'), projectPaths: ['/project/new'],
      targetDir: '/project/new',
    }));
    const status = view.container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Stack old');
    expect(status.textContent).toContain('/project/old');
    expect(confirm(view.container).disabled).toBe(true);

    await act(async () => pending.requests[0].resolveJson({ success: true, message: 'Copied old stack' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(confirm(view.container).disabled).toBe(false);
    await click(confirm(view.container));
    expect(payload(pending.requests[1])).toEqual({
      stackId: 'new', copyStackAll: true, targetPath: '/project/new',
    });
  });

  it('reports conflict, partial results, and legacy errors without claiming success', async () => {
    vi.stubGlobal('fetch', pending.fetcher);
    view = await mountReact(renderModal({
      isOpen: true, onClose, asset: asset('sprite'),
      targetDir: '/project', projectPaths: ['/project'],
    }));
    await click(confirm(view.container));
    await act(async () => pending.requests[0].resolveJson({
      error: 'Destination already contains sprite.png', code: 'COPY_CONFLICT',
    }, 409));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Copy Conflict');
    expect(onClose).not.toHaveBeenCalled();

    await click(confirm(view.container));
    await act(async () => pending.requests[1].resolveJson({
      error: 'Copy failed during publish', code: 'COPY_IO_ERROR',
      details: {
        copiedFiles: ['/project/first.png'], rolledBackFiles: [],
        remainingFiles: ['/project/first.png'], failedFile: '/project/second.png',
        targetDirectory: '/project',
      },
    }, 500));
    const alert = view.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Copy Partially Completed');
    expect(alert.textContent).toContain('Failed file: /project/second.png');
    expect(alert.textContent).toContain('Files still present: /project/first.png');
    expect(alert.textContent).toContain('1 file(s) copied before failure; 0 rolled back');

    await click(confirm(view.container));
    await act(async () => pending.requests[2].resolveJson({ error: 'Old copier error' }, 500));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Old copier error');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores an old response after close and reopen', async () => {
    vi.stubGlobal('fetch', pending.fetcher);
    const first = asset('first');
    const next = asset('next');
    view = await mountReact(renderModal({
      isOpen: true, onClose, asset: first,
      targetDir: '/project/first', projectPaths: ['/project/first'],
    }));
    await click(confirm(view.container));
    await view.render(renderModal({
      isOpen: false, onClose, asset: first,
      targetDir: '/project/first', projectPaths: ['/project/first'],
    }));
    await view.render(renderModal({
      isOpen: true, onClose, asset: next,
      targetDir: '/project/next', projectPaths: ['/project/next'],
    }));
    await click(confirm(view.container));
    await act(async () => pending.requests[0].resolveJson({ success: true, message: 'Old copy done' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('next.png');
    expect(confirm(view.container).disabled).toBe(true);

    await act(async () => pending.requests[1].resolveJson({ success: true, message: 'New copy done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('labels the dialog and returns focus to its launcher after Escape', async () => {
    view = await mountReact(<CopyHost onClose={onClose} />);
    const launcher = view.container.querySelector<HTMLButtonElement>('button')!;
    launcher.focus();
    await click(launcher);
    const dialog = view.container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe('copy-dialog-title');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close copy dialog');

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(launcher);
  });
});
