// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferredFetch, type PendingFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { SettingsModal } from '../client/src/components/SettingsModal.js';
import { ToastProvider } from '../client/src/components/Toast.js';

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
      : { enabled: true, inferFromArchive: true, inferFromDirectory: true,
        directoryStrategy: 'top', directoryDepth: 1, cleanSeparators: true,
        stripVersionSuffix: true, stripAffixes: false, caseConvention: 'as-is',
        applyTag: false },
});

const loadUrls = ['/api/scan/status', '/api/settings', '/api/classifiers/bpm',
  '/api/classifiers/sprite', '/api/classifiers/pack'];
const scanStatus = { status: 'idle', libraryPath: '', scannedCount: 0, indexedCount: 0 };

function content(open: boolean, onClose: () => void, onSettingsSaved: () => void) {
  return <ToastProvider>
    <SettingsModal isOpen={open} onClose={onClose} onSettingsSaved={onSettingsSaved} />
  </ToastProvider>;
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes('Save Settings'));
  if (!button) throw new Error('Save Settings button missing');
  return button;
}

function requestFor(requests: PendingFetch[], url: string, offset = 0): PendingFetch {
  const request = requests.slice(offset).find((candidate) => candidate.url === url);
  if (!request) throw new Error(`Missing ${url} request`);
  return request;
}

async function resolveLoads(requests: PendingFetch[], offset = 0, app = appSettings) {
  await act(async () => {
    requestFor(requests, '/api/scan/status', offset).resolveJson(scanStatus);
    requestFor(requests, '/api/settings', offset).resolveJson(app);
    for (const id of ['bpm', 'sprite', 'pack']) {
      requestFor(requests, `/api/classifiers/${id}`, offset).resolveJson(classifier(id));
    }
  });
}

async function setRange(input: HTMLInputElement, value: number) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, String(value));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('SettingsModal initial draft loading', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('loads a fresh request scope after React Strict Mode effect replay', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const view = await mountReact(<StrictMode>{content(true, vi.fn(), vi.fn())}</StrictMode>);
    try {
      for (const url of loadUrls.slice(1)) {
        expect(pending.requests.filter((request) => request.url === url)).toHaveLength(1);
      }
      const statusRequests = pending.requests.filter((request) => request.url === '/api/scan/status');
      expect(statusRequests).toHaveLength(2);
      expect(statusRequests[0].init?.signal?.aborted).toBe(true);
      await act(async () => {
        statusRequests[1].resolveJson(scanStatus);
        pending.requests.find((request) => request.url === '/api/settings')!.resolveJson(appSettings);
        for (const id of ['bpm', 'sprite', 'pack']) {
          pending.requests.find((request) => request.url === `/api/classifiers/${id}`)!
            .resolveJson(classifier(id));
        }
      });
      expect(saveButton(view.container).disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('keeps Save disabled while any required section is delayed', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onClose = vi.fn();
    const onSettingsSaved = vi.fn();
    const view = await mountReact(content(true, onClose, onSettingsSaved));
    try {
      expect(pending.requests.map((request) => request.url)).toEqual(loadUrls);
      expect(saveButton(view.container).disabled).toBe(true);
      await act(async () => {
        pending.requests[0].resolveJson(scanStatus);
        pending.requests[1].resolveJson(appSettings);
        pending.requests[2].resolveJson(classifier('bpm'));
        pending.requests[3].resolveJson(classifier('sprite'));
      });
      expect(saveButton(view.container).disabled).toBe(true);
      await click(saveButton(view.container));
      expect(pending.requests).toHaveLength(5);
      expect(onSettingsSaved).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => { pending.requests[4].resolveJson(classifier('pack')); });
      expect(saveButton(view.container).disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it.each(['app', 'bpm', 'sprite', 'pack'] as const)(
    'reports a failed %s load and retries that section without saving defaults', async (section) => {
      const pending = createDeferredFetch();
      vi.stubGlobal('fetch', pending.fetcher);
      const onClose = vi.fn();
      const onSettingsSaved = vi.fn();
      const view = await mountReact(content(true, onClose, onSettingsSaved));
      const failedUrl = section === 'app' ? '/api/settings' : `/api/classifiers/${section}`;
      try {
        await act(async () => {
          pending.requests[0].resolveJson(scanStatus);
          for (const request of pending.requests.slice(1, 5)) {
            if (request.url === failedUrl) request.resolveJson({ error: `${section} unavailable` }, 503);
            else if (request.url === '/api/settings') request.resolveJson(appSettings);
            else request.resolveJson(classifier(request.url.split('/').pop()!));
          }
        });
        expect(saveButton(view.container).disabled).toBe(true);
        expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(`${section} unavailable`);
        const retry = Array.from(view.container.querySelectorAll('button'))
          .find((button) => button.textContent?.trim() === `Retry ${section}`)!;
        await click(retry);
        expect(pending.requests).toHaveLength(6);
        expect(pending.requests[5].url).toBe(failedUrl);
        await act(async () => {
          pending.requests[5].resolveJson(section === 'app' ? appSettings : classifier(section));
        });
        expect(saveButton(view.container).disabled).toBe(false);
        expect(onSettingsSaved).not.toHaveBeenCalled();
      } finally {
        await view.unmount();
      }
    },
  );

  it('rejects a malformed initial payload and allows a section retry', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const view = await mountReact(content(true, vi.fn(), vi.fn()));
    try {
      await act(async () => {
        pending.requests[0].resolveJson(scanStatus);
        pending.requests[1].resolveJson({ ...appSettings, libraryPaths: null });
        for (const id of ['bpm', 'sprite', 'pack']) {
          requestFor(pending.requests, `/api/classifiers/${id}`).resolveJson(classifier(id));
        }
      });
      expect(saveButton(view.container).disabled).toBe(true);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('unexpected shape');
      const retry = Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Retry app')!;
      await click(retry);
      await act(async () => { pending.requests[5].resolveJson(appSettings); });
      expect(saveButton(view.container).disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it.each([
    ['bpm', 'minBpm'], ['sprite', 'minConfidence'], ['pack', 'directoryDepth'],
  ] as const)('rejects malformed %s setting values as a retryable load error', async (section, field) => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const view = await mountReact(content(true, vi.fn(), vi.fn()));
    try {
      await act(async () => {
        pending.requests[0].resolveJson(scanStatus);
        pending.requests[1].resolveJson(appSettings);
        for (const id of ['bpm', 'sprite', 'pack']) {
          const info = classifier(id);
          requestFor(pending.requests, `/api/classifiers/${id}`).resolveJson(id === section
            ? { ...info, settings: { ...info.settings, [field]: 'invalid' } } : info);
        }
      });
      expect(saveButton(view.container).disabled).toBe(true);
      expect(view.container.textContent).toContain(`Retry ${section}`);
    } finally {
      await view.unmount();
    }
  });

  it('ignores old loads after close and reopen, then keeps the edited new draft', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onClose = vi.fn();
    const onSettingsSaved = vi.fn();
    const view = await mountReact(content(true, onClose, onSettingsSaved));
    try {
      expect(pending.requests).toHaveLength(5);
      await view.render(content(false, onClose, onSettingsSaved));
      for (const request of pending.requests) expect(request.init?.signal?.aborted).toBe(true);
      await view.render(content(true, onClose, onSettingsSaved));
      expect(pending.requests).toHaveLength(10);
      await resolveLoads(pending.requests, 5, { ...appSettings, defaultFps: 24 });
      expect(view.container.textContent).toContain('24 FPS');

      const slider = view.container.querySelector('input[type="range"]') as HTMLInputElement;
      await setRange(slider, 31);
      expect(view.container.textContent).toContain('31 FPS');
      await resolveLoads(pending.requests, 0, { ...appSettings, defaultFps: 8 });
      expect(view.container.textContent).toContain('31 FPS');
      expect(saveButton(view.container).disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('preserves unknown optional settings while editing a known field', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onSettingsSaved = vi.fn();
    const view = await mountReact(content(true, vi.fn(), onSettingsSaved));
    try {
      const extended = { ...appSettings, futureSetting: { retain: 'yes' } };
      await act(async () => {
        pending.requests[0].resolveJson(scanStatus);
        pending.requests[1].resolveJson(extended);
        pending.requests[2].resolveJson({ ...classifier('bpm'),
          settings: { ...classifier('bpm').settings, futureAlgorithm: 'v2' } });
        pending.requests[3].resolveJson(classifier('sprite'));
        pending.requests[4].resolveJson(classifier('pack'));
      });
      const slider = view.container.querySelector('input[type="range"]') as HTMLInputElement;
      await setRange(slider, 30);
      await click(saveButton(view.container));
      const appSave = requestFor(pending.requests, '/api/settings', 5);
      expect(JSON.parse(String(appSave.init?.body))).toMatchObject({
        defaultFps: 30, futureSetting: { retain: 'yes' },
      });
      await act(async () => { appSave.resolveJson(extended); });
      const bpmSave = requestFor(pending.requests, '/api/classifiers/bpm/settings', 5);
      expect(JSON.parse(String(bpmSave.init?.body))).toMatchObject({ futureAlgorithm: 'v2' });
      expect(onSettingsSaved).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it('discards a cancelled draft and reloads persisted values on reopening', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const onClose = vi.fn();
    const onSettingsSaved = vi.fn();
    const view = await mountReact(content(true, onClose, onSettingsSaved));
    try {
      await resolveLoads(pending.requests);
      const slider = view.container.querySelector('input[type="range"]') as HTMLInputElement;
      await setRange(slider, 34);
      expect(view.container.textContent).toContain('34 FPS');
      const cancel = Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Cancel')!;
      await click(cancel);
      expect(onClose).toHaveBeenCalledOnce();
      await view.render(content(false, onClose, onSettingsSaved));
      await view.render(content(true, onClose, onSettingsSaved));
      expect(saveButton(view.container).disabled).toBe(true);
      await resolveLoads(pending.requests, 5);
      expect(view.container.textContent).toContain('12 FPS');
      expect(pending.requests.every((request) => request.init?.method !== 'POST')).toBe(true);
      expect(onSettingsSaved).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it('gives every settings input and select an accessible name on both tabs', async () => {
    const pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    const view = await mountReact(content(true, vi.fn(), vi.fn()));
    const unnamed = () => Array.from(view.container.querySelectorAll('input, select, textarea'))
      .filter((control) => {
        const labelledBy = control.getAttribute('aria-labelledby');
        const referencedName = labelledBy?.split(/\s+/).map((id) =>
          document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
        const labels = (control as HTMLInputElement).labels;
        return !control.getAttribute('aria-label')?.trim() && !referencedName
          && !Array.from(labels ?? []).some((label) => label.textContent?.trim());
      }).map((control) => control.outerHTML);
    try {
      await resolveLoads(pending.requests);
      expect(unnamed()).toEqual([]);
      const classifierTab = Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Asset Classifiers'))!;
      await click(classifierTab);
      expect(unnamed()).toEqual([]);
    } finally {
      await view.unmount();
    }
  });
});
