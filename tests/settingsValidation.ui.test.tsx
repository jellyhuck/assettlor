// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../shared/types.js';
import { createDeferredFetch, type PendingFetch } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { SettingsModal } from '../client/src/components/SettingsModal.js';
import { ToastProvider } from '../client/src/components/Toast.js';

const appSettings: AppSettings = {
  libraryPath: '/library/one', libraryPaths: ['/library/one'],
  activeProjectPath: '/project/one', projectPaths: ['/project/one'],
  thumbnailQuality: 80, autoStackAnimations: true,
  autoStackAudio: true, defaultFps: 12,
};

const classifierSettings = {
  bpm: { enabled: true, minBpm: 60, maxBpm: 200,
    minDurationSeconds: 1, maxAnalysisSeconds: 45 },
  sprite: { enabled: true, minConfidence: 0.5, enableVisualAnalysis: true,
    enablePathAnalysis: true, enableStackAnalysis: true },
  pack: { enabled: true, inferFromArchive: true, inferFromDirectory: true,
    directoryStrategy: 'top', directoryDepth: 1, cleanSeparators: true,
    stripVersionSuffix: true, stripAffixes: false, caseConvention: 'as-is',
    applyTag: false },
};

type ClassifierId = keyof typeof classifierSettings;
type Fixture = {
  app?: Partial<AppSettings>;
  bpm?: Record<string, unknown>;
  sprite?: Record<string, unknown>;
  pack?: Record<string, unknown>;
};

function requestBody(request: PendingFetch): Record<string, unknown> {
  return JSON.parse(String(request.init?.body)) as Record<string, unknown>;
}

function nativeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

function pathRow(container: HTMLElement, path: string): HTMLElement {
  let element = Array.from(container.querySelectorAll<HTMLElement>('[title]'))
    .find((candidate) => candidate.title === path) ?? null;
  while (element && !element.querySelector('button[title="Remove"]')) element = element.parentElement;
  if (!element) throw new Error(`Path row not found: ${path}`);
  return element;
}

function rowButton(container: HTMLElement, path: string, title: string): HTMLButtonElement {
  const found = pathRow(container, path).querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!found) throw new Error(`Button ${title} not found for ${path}`);
  return found;
}

function numberInput(container: HTMLElement, label: string): HTMLInputElement {
  const heading = Array.from(container.querySelectorAll('label'))
    .find((candidate) => candidate.textContent?.trim() === label);
  const input = heading?.parentElement?.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) throw new Error(`Number input not found: ${label}`);
  return input;
}

describe('SettingsModal validation and path selection', () => {
  let pending: ReturnType<typeof createDeferredFetch>;
  let view: Awaited<ReturnType<typeof mountReact>> | null;
  let onSettingsSaved: ReturnType<typeof vi.fn>;

  function requests(url: string, method?: string): PendingFetch[] {
    return pending.requests.filter((request) =>
      request.url === url && (!method || (request.init?.method ?? 'GET') === method));
  }

  async function mount(fixture: Fixture = {}) {
    pending = createDeferredFetch();
    vi.stubGlobal('fetch', pending.fetcher);
    onSettingsSaved = vi.fn();
    view = await mountReact(
      <ToastProvider>
        <SettingsModal isOpen onClose={() => {}} onSettingsSaved={onSettingsSaved} />
      </ToastProvider>,
    );

    expect(requests('/api/settings')).toHaveLength(1);
    for (const id of Object.keys(classifierSettings) as ClassifierId[]) {
      expect(requests(`/api/classifiers/${id}`)).toHaveLength(1);
    }
    await act(async () => {
      requests('/api/scan/status')[0].resolveJson({
        status: 'idle', libraryPath: '', scannedCount: 0, indexedCount: 0,
      });
      requests('/api/settings')[0].resolveJson({ ...appSettings, ...fixture.app });
      for (const id of Object.keys(classifierSettings) as ClassifierId[]) {
        requests(`/api/classifiers/${id}`)[0].resolveJson({
          id, name: id, description: id, category: 'image', steps: [],
          settings: { ...classifierSettings[id], ...fixture[id] },
        });
      }
    });
    expect(view.container.textContent).not.toContain('Loading settings before editing');
    return view;
  }

  async function addPath(kind: 'library' | 'project', path: string): Promise<PendingFetch> {
    const placeholder = kind === 'library'
      ? 'Add asset library path...' : 'Add game project path...';
    const input = view!.container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
    await act(async () => nativeInput(input, path));
    const add = Array.from(input.parentElement!.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.trim() === 'Add')!;
    await click(add);
    return requests('/api/fs/validate', 'POST').at(-1)!;
  }

  afterEach(async () => {
    await view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  it('blocks saving invalid numeric bounds from all loaded sections', async () => {
    const current = await mount({
      app: { thumbnailQuality: 0, defaultFps: 61 },
      bpm: { minBpm: 200, maxBpm: 100, minDurationSeconds: 0, maxAnalysisSeconds: -1 },
      sprite: { minConfidence: 1.1 },
      pack: { directoryDepth: 0 },
    });
    await click(button(current.container, 'Save Settings'));

    const errors = current.container.querySelector('ul[role="alert"]')?.textContent ?? '';
    expect(errors).toContain('Thumbnail quality must be an integer from 1 to 100');
    expect(errors).toContain('Default FPS must be an integer from 1 to 60');
    expect(errors).toContain('Minimum BPM cannot exceed maximum BPM');
    expect(errors).toContain('Minimum duration must be a positive finite number');
    expect(errors).toContain('Maximum analysis window must be a positive finite number');
    expect(errors).toContain('Sprite confidence must be between 0 and 1');
    expect(errors).toContain('Directory depth must be an integer from 1 to 64');
    expect(requests('/api/settings', 'POST')).toHaveLength(0);
    expect(onSettingsSaved).not.toHaveBeenCalled();
  });

  it('validates edited BPM combinations before issuing a save', async () => {
    const current = await mount();
    await click(button(current.container, 'Asset Classifiers'));
    await act(async () => nativeInput(numberInput(current.container, 'Min BPM Threshold'), '210'));
    await click(button(current.container, 'Save Settings'));
    expect(current.container.querySelector('ul[role="alert"]')?.textContent)
      .toContain('Minimum BPM cannot exceed maximum BPM');
    expect(requests('/api/settings', 'POST')).toHaveLength(0);

    await act(async () => nativeInput(numberInput(current.container, 'Min BPM Threshold'), '60'));
    await act(async () => nativeInput(numberInput(current.container, 'Min Audio Duration (sec)'), '-2'));
    await click(button(current.container, 'Save Settings'));
    expect(current.container.querySelector('ul[role="alert"]')?.textContent)
      .toContain('Minimum duration must be a positive finite number');
    expect(requests('/api/settings', 'POST')).toHaveLength(0);
  });

  it('rejects duplicate path aliases after validation', async () => {
    const current = await mount();
    const library = await addPath('library', '/library/one/./');
    expect(requestBody(library)).toEqual({ path: '/library/one/./' });
    await act(async () => library.resolveJson({
      exists: true, isDirectory: true, resolvedPath: '/library/one/./',
    }));
    expect(current.container.textContent).toContain('This asset library is already in the list');
    expect(current.container.querySelectorAll('[title="/library/one"]')).toHaveLength(1);

    const project = await addPath('project', '/project/one/../one');
    await act(async () => project.resolveJson({
      exists: true, isDirectory: true, resolvedPath: '/project/one/../one',
    }));
    expect(current.container.textContent).toContain('This project destination is already in the list');
    expect(current.container.querySelectorAll('[title="/project/one"]')).toHaveLength(1);
  });

  it('requires an existing directory for a library', async () => {
    const current = await mount();
    const missing = await addPath('library', '/library/missing');
    await act(async () => missing.resolveJson({
      exists: false, isDirectory: false, resolvedPath: '/library/missing',
    }));
    expect(current.container.textContent).toContain('Asset libraries must be existing directories');
    expect(current.container.querySelector('[title="/library/missing"]')).toBeNull();

    const file = await addPath('library', '/library/file.png');
    await act(async () => file.resolveJson({
      exists: true, isDirectory: false, resolvedPath: '/library/file.png',
    }));
    expect(current.container.textContent).toContain('Asset libraries must be existing directories');
    expect(current.container.querySelector('[title="/library/file.png"]')).toBeNull();
  });

  it('waits for both path validations before allowing a save', async () => {
    const current = await mount();
    const library = await addPath('library', '/library/two');
    const project = await addPath('project', '/project/two');
    expect(button(current.container, 'Save Settings').disabled).toBe(true);

    await act(async () => library.resolveJson({
      exists: true, isDirectory: true, resolvedPath: '/library/two',
    }));
    expect(button(current.container, 'Save Settings').disabled).toBe(true);
    expect(requests('/api/settings', 'POST')).toHaveLength(0);

    await act(async () => project.resolveJson({
      exists: true, isDirectory: true, resolvedPath: '/project/two',
    }));
    expect(button(current.container, 'Save Settings').disabled).toBe(false);
    expect(current.container.querySelector('[title="/library/two"]')).not.toBeNull();
    expect(current.container.querySelector('[title="/project/two"]')).not.toBeNull();
  });

  it('adds an existing project folder and requires confirmation for a new destination', async () => {
    const current = await mount();
    const existing = await addPath('project', '/project/existing');
    await act(async () => existing.resolveJson({
      exists: true, isDirectory: true, resolvedPath: '/project/existing',
    }));
    expect(current.container.querySelector('[title="/project/existing"]')).not.toBeNull();
    expect(current.container.textContent).not.toContain('Add new destination');

    const missing = await addPath('project', '/project/new');
    await act(async () => missing.resolveJson({
      exists: false, isDirectory: false, resolvedPath: '/project/new',
    }));
    expect(current.container.querySelector('[title="/project/new"]')).toBeNull();
    expect(current.container.textContent).toContain('/project/new does not exist');
    expect(button(current.container, 'Save Settings').disabled).toBe(true);
    await click(button(current.container, 'Add new destination'));
    expect(current.container.querySelector('[title="/project/new"]')).not.toBeNull();
    expect(button(current.container, 'Save Settings').disabled).toBe(false);

    const file = await addPath('project', '/project/file.png');
    await act(async () => file.resolveJson({
      exists: true, isDirectory: false, resolvedPath: '/project/file.png',
    }));
    expect(current.container.textContent).toContain('Project destination must be a directory');
    expect(current.container.querySelector('[title="/project/file.png"]')).toBeNull();
  });

  it('keeps explicitly empty path lists empty when saving', async () => {
    const current = await mount({ app: {
      libraryPath: '/legacy/library', libraryPaths: [],
      activeProjectPath: '/legacy/project', projectPaths: [],
    } });
    expect(current.container.textContent).toContain('No game project directories configured yet');
    expect(current.container.textContent).toContain('No asset library directories configured yet');
    await click(button(current.container, 'Save Settings'));
    expect(requests('/api/settings', 'POST')).toHaveLength(1);
    expect(requestBody(requests('/api/settings', 'POST')[0])).toMatchObject({
      libraryPath: '', libraryPaths: [], activeProjectPath: '', projectPaths: [],
    });
  });

  it('updates active paths when moving and removing first entries', async () => {
    const current = await mount({ app: {
      projectPaths: ['/project/one', '/project/two', '/project/three'],
      libraryPaths: ['/library/one', '/library/two', '/library/three'],
    } });

    await click(rowButton(current.container, '/project/three', 'Set as Active Project (move to top)'));
    expect(pathRow(current.container, '/project/three').textContent).toContain('Active Project');
    await click(rowButton(current.container, '/project/three', 'Remove'));
    expect(pathRow(current.container, '/project/one').textContent).toContain('Active Project');
    await click(rowButton(current.container, '/project/two', 'Move Up'));
    expect(pathRow(current.container, '/project/two').textContent).toContain('Active Project');

    await click(rowButton(current.container, '/library/two', 'Move Up'));
    await click(rowButton(current.container, '/library/two', 'Remove'));
    await click(button(current.container, 'Save Settings'));
    expect(requestBody(requests('/api/settings', 'POST')[0])).toMatchObject({
      activeProjectPath: '/project/two',
      projectPaths: ['/project/two', '/project/one'],
      libraryPath: '/library/one',
      libraryPaths: ['/library/one', '/library/three'],
    });
  });
});
