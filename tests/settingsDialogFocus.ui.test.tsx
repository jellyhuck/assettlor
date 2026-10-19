// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferredFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { SettingsModal } from '../client/src/components/SettingsModal.js';
import { ToastProvider } from '../client/src/components/Toast.js';

const app = {
  libraryPath: '/library', libraryPaths: ['/library'],
  activeProjectPath: '/project', projectPaths: ['/project'],
  thumbnailQuality: 80, autoStackAnimations: true, autoStackAudio: true, defaultFps: 12, catalogPaging: 'load-more',
};
const classifiers = {
  bpm: { enabled: true, minBpm: 60, maxBpm: 200, minDurationSeconds: 1, maxAnalysisSeconds: 45 },
  sprite: { enabled: true, minConfidence: 0.5, enableVisualAnalysis: true,
    enablePathAnalysis: true, enableStackAnalysis: true },
  pack: { enabled: true, inferFromArchive: true, inferFromDirectory: true,
    directoryStrategy: 'top', directoryDepth: 1, cleanSeparators: true,
    stripVersionSuffix: true, stripAffixes: false, caseConvention: 'as-is' },
};

function Host() {
  const [open, setOpen] = useState(false);
  return <ToastProvider>
    <button onClick={() => setOpen(true)}>Open settings</button>
    <SettingsModal isOpen={open} onClose={() => setOpen(false)} onSettingsSaved={() => {}} />
  </ToastProvider>;
}

function byText(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

describe('nested settings and folder dialog focus', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('closes only the top dialog on Escape and restores each launcher', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const view = await mountReact(<Host />);
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    try {
      const launcher = byText(view.container, 'Open settings');
      launcher.focus();
      await click(launcher);
      const settingsDialog = view.container.querySelector<HTMLElement>('[aria-labelledby="settings-dialog-title"]')!;
      expect(settingsDialog.getAttribute('role')).toBe('dialog');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close settings');

      await act(async () => {
        pending.requests.find((request) => request.url === '/api/scan/status')!.resolveJson({
          status: 'idle', libraryPath: '', scannedCount: 0, indexedCount: 0,
        });
        pending.requests.find((request) => request.url === '/api/settings')!.resolveJson(app);
        for (const [id, settings] of Object.entries(classifiers)) {
          pending.requests.find((request) => request.url === `/api/classifiers/${id}`)!.resolveJson({
            id, name: id, description: id, category: 'audio', steps: [], settings,
          });
        }
      });

      const browse = byText(view.container, 'Browse');
      browse.focus();
      await click(browse);
      const dialogs = view.container.querySelectorAll('[role="dialog"]');
      expect(dialogs).toHaveLength(2);
      expect(settingsDialog.parentElement?.hasAttribute('inert')).toBe(true);
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close folder browser');

      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true,
        }));
      });
      expect(view.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(document.activeElement).toBe(browse);
      expect(appEscape).not.toHaveBeenCalled();

      await act(async () => {
        browse.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true,
        }));
      });
      expect(view.container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(launcher);
      expect(appEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', appEscape);
      await view.unmount();
    }
  });
});
