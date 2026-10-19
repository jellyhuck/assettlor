// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from '../client/tests/reactDomHarness.js';
import { act, mountReact } from '../client/tests/reactDomHarness.js';
import { createDeferredFetch } from '../client/tests/asyncFixtures.js';
import { SettingsModal } from '../client/src/components/SettingsModal.js';
import { ToastProvider } from '../client/src/components/Toast.js';

const settings = {
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
        stripVersionSuffix: true, stripAffixes: false, caseConvention: 'as-is' },
});

const loadUrls = ['/api/settings', '/api/classifiers/bpm',
  '/api/classifiers/sprite', '/api/classifiers/pack'];
const saveUrls = ['/api/settings', '/api/classifiers/bpm/settings',
  '/api/classifiers/sprite/settings', '/api/classifiers/pack/settings'];

async function setup() {
  const pending = createDeferredFetch();
  vi.stubGlobal('fetch', pending.fetcher);
  const onClose = vi.fn();
  const onSettingsSaved = vi.fn();
  const view = await mountReact(createElement(ToastProvider, null,
    createElement(SettingsModal, { isOpen: true, onClose, onSettingsSaved })));
  expect(pending.requests.map((request) => request.url)).toEqual(['/api/scan/status', ...loadUrls]);
  await act(async () => {
    pending.requests[0].resolveJson({ status: 'idle', libraryPath: '', scannedCount: 0, indexedCount: 0 });
    pending.requests[1].resolveJson(settings);
    for (let index = 1; index < 4; index++) {
      pending.requests[index + 1].resolveJson(classifier(loadUrls[index].split('/').pop()!));
    }
  });
  const saveButton = Array.from(view.container.querySelectorAll('button'))
    .find((button) => button.textContent?.includes('Save Settings'))!;
  await act(async () => { saveButton.click(); });
  return { pending, onClose, onSettingsSaved, view };
}

describe('settings save ordering', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('waits for all four durable saves before notifying the parent once', async () => {
    const { pending, onClose, onSettingsSaved, view } = await setup();
    for (let index = 0; index < 4; index++) {
      expect(pending.requests.slice(5).map((request) => request.url)).toEqual(saveUrls.slice(0, index + 1));
      expect(onSettingsSaved).not.toHaveBeenCalled();
      await act(async () => { pending.requests[index + 5].resolveJson(index === 0 ? settings : {}); });
    }
    expect(onSettingsSaved).toHaveBeenCalledExactlyOnceWith(settings);
    expect(onClose).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it.each([0, 1, 2, 3])('does not start a scan when save %i fails', async (failedIndex) => {
    const { pending, onClose, onSettingsSaved, view } = await setup();
    for (let index = 0; index <= failedIndex; index++) {
      await act(async () => {
        pending.requests[index + 5].resolveJson(
          index === failedIndex ? { error: 'write failed' } : index === 0 ? settings : {},
          index === failedIndex ? 500 : 200,
        );
      });
    }
    expect(pending.requests.slice(5).map((request) => request.url)).toEqual(saveUrls.slice(0, failedIndex + 1));
    expect(onSettingsSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Save Settings');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('No scan started');
    await view.unmount();
  });

  it('keeps a partially saved draft available for a single successful retry', async () => {
    const { pending, onClose, onSettingsSaved, view } = await setup();
    const saveButton = Array.from(view.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Saving'))!;
    await act(async () => { saveButton.click(); });
    expect(pending.requests).toHaveLength(6);
    await act(async () => { pending.requests[5].resolveJson(settings); });
    await act(async () => { pending.requests[6].resolveJson({ error: 'BPM write failed' }, 500); });
    expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toContain('1 section confirmed saved');
    expect(onSettingsSaved).not.toHaveBeenCalled();

    const retry = Array.from(view.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Save Settings'))!;
    await act(async () => { retry.click(); });
    for (let index = 7; index < 11; index++) {
      await act(async () => { pending.requests[index].resolveJson(index === 7 ? settings : {}); });
    }
    expect(pending.requests.slice(7).map((request) => request.url)).toEqual(saveUrls);
    expect(onSettingsSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    await view.unmount();
  });
});
