// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferredFetch, deferred } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { ModelViewer } from '../client/src/components/ModelViewer.js';
import type { Asset } from '../shared/types.js';

interface FakeRenderer {
  domElement: HTMLCanvasElement;
  dispose: ReturnType<typeof vi.fn>;
  forceContextLoss: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
}

const fakes = vi.hoisted(() => ({
  renderers: [] as FakeRenderer[],
  parses: [] as Array<{ data: ArrayBuffer; result: ReturnType<typeof deferred<unknown>> }>,
  controls: [] as Array<{ dispose: ReturnType<typeof vi.fn>; autoRotate: boolean }>,
  failRenderer: false,
}));

vi.mock('../client/node_modules/three/build/three.module.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class WebGLRenderer {
    domElement = document.createElement('canvas');
    toneMapping = 0;
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
    forceContextLoss = vi.fn();
    constructor() {
      if (fakes.failRenderer) throw new Error('Error creating WebGL context.');
      fakes.renderers.push(this);
    }
  }
  class PMREMGenerator {
    fromScene() {
      return { texture: new actual.Texture(), dispose: vi.fn() };
    }
    dispose = vi.fn();
  }
  return { ...actual, WebGLRenderer, PMREMGenerator };
});

vi.mock('../client/node_modules/three/examples/jsm/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('../client/node_modules/three/build/three.module.js');
  class OrbitControls {
    target = new Vector3();
    enableDamping = false;
    autoRotate = false;
    autoRotateSpeed = 2;
    update = vi.fn();
    dispose = vi.fn();
    constructor() {
      fakes.controls.push(this);
    }
  }
  return { OrbitControls };
});

vi.mock('../client/node_modules/three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {
      return this;
    }
    parseAsync(data: ArrayBuffer) {
      const result = deferred<unknown>();
      fakes.parses.push({ data, result });
      return result.promise;
    }
  },
}));

vi.mock('../client/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js', () => ({
  MeshoptDecoder: {},
}));

const THREE = await import('../client/node_modules/three/build/three.module.js');

function asset(id: string, revision = 1): Asset {
  return {
    id, path: `models/${id}.glb`, absolutePath: `/tmp/models/${id}.glb`, name: `${id}.glb`,
    extension: '.glb', category: 'model', size: 100, mtime: revision, hash: `${id}-${revision}`,
    isArchiveEntry: false, thumbnailUrl: `/thumb/${id}`, fileUrl: `/api/assets/${id}/file`,
    metadata: { triangleCount: 12 }, tags: [], createdAt: 1, updatedAt: revision,
  };
}

function gltf(animationNames: string[] = []) {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  scene.add(mesh);
  const animations = animationNames.map((name) => new THREE.AnimationClip(name, 1, [
    new THREE.NumberKeyframeTrack(`${mesh.uuid}.position[x]`, [0, 1], [0, 1]),
  ]));
  return { scene, animations, mesh };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

describe('ModelViewer', () => {
  let fetchDouble: ReturnType<typeof createDeferredFetch>;

  beforeEach(() => {
    fakes.renderers.length = 0;
    fakes.parses.length = 0;
    fakes.controls.length = 0;
    fakes.failRenderer = false;
    fetchDouble = createDeferredFetch();
    vi.stubGlobal('fetch', fetchDouble.fetcher);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the model file, frames it, and releases WebGL resources on unmount', async () => {
    const view = await mountReact(<ModelViewer asset={asset('crate')} />);
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Loading 3D model');
    expect(fetchDouble.requests[0].url).toBe('http://localhost:3000/api/assets/crate/file');
    expect(fakes.renderers).toHaveLength(1);
    const region = view.container.querySelector('[role="region"][aria-label="3D preview of crate.glb"]')!;
    expect(region.contains(fakes.renderers[0].domElement)).toBe(true);

    const loaded = gltf();
    await act(async () => fetchDouble.requests[0].resolveText('glb-bytes'));
    await flush();
    expect(fakes.parses).toHaveLength(1);
    await act(async () => fakes.parses[0].result.resolve(loaded));
    await flush();
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    expect(button(view.container, 'Reset 3D view').disabled).toBe(false);

    await click(button(view.container, 'Show wireframe'));
    expect((loaded.mesh.material as InstanceType<typeof THREE.MeshStandardMaterial>).wireframe).toBe(true);
    await click(button(view.container, 'Auto-rotate model'));
    expect(fakes.controls[0].autoRotate).toBe(true);

    const geometryDispose = vi.spyOn(loaded.mesh.geometry, 'dispose');
    const renderer = fakes.renderers[0];
    await view.unmount();
    expect(renderer.dispose).toHaveBeenCalled();
    expect(renderer.forceContextLoss).toHaveBeenCalled();
    expect(renderer.domElement.isConnected).toBe(false);
    expect(fakes.controls[0].dispose).toHaveBeenCalled();
    expect(geometryDispose).toHaveBeenCalled();
  });

  it('lists animation clips and controls playback', async () => {
    const view = await mountReact(<ModelViewer asset={asset('walker')} />);
    await act(async () => fetchDouble.requests[0].resolveText('glb-bytes'));
    await flush();
    await act(async () => fakes.parses[0].result.resolve(gltf(['Walk', 'Run'])));
    await flush();
    const select = view.container.querySelector<HTMLSelectElement>('select[aria-label="Animation clip"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Walk', 'Run']);
    await click(button(view.container, 'Pause animation'));
    expect(button(view.container, 'Play animation')).toBeTruthy();
    await view.unmount();
  });

  it('shows why WebGL is unavailable and keeps the thumbnail visible', async () => {
    fakes.failRenderer = true;
    const view = await mountReact(<ModelViewer asset={asset('crate')} />);
    await flush();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('WebGL');
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('/thumb/crate');
    expect(fetchDouble.requests).toHaveLength(0);
    await view.unmount();
  });

  it('reports load failures, explains Draco files, and retries with a new renderer', async () => {
    const view = await mountReact(<ModelViewer asset={asset('packed')} />);
    await act(async () => fetchDouble.requests[0].resolveText('glb-bytes'));
    await flush();
    await act(async () => fakes.parses[0].result.reject(new Error('THREE.GLTFLoader: No DRACOLoader instance provided.')));
    await flush();
    expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toBe('Draco-compressed models are not supported yet.');

    const first = fakes.renderers[0];
    await click(button(view.container, 'Retry model'));
    expect(first.dispose).toHaveBeenCalled();
    expect(fakes.renderers).toHaveLength(2);
    expect(fetchDouble.requests).toHaveLength(2);

    await act(async () => fetchDouble.requests[1].resolveText('missing', 404));
    await flush();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('HTTP 404');
    await view.unmount();
  });

  it('aborts a pending download on a source revision and ignores its late result', async () => {
    const view = await mountReact(<StrictMode><ModelViewer asset={asset('crate', 1)} /></StrictMode>);
    const stale = fetchDouble.requests.at(-1)!;
    await view.render(<StrictMode><ModelViewer asset={asset('crate', 2)} /></StrictMode>);
    expect(stale.init?.signal?.aborted).toBe(true);
    const current = fetchDouble.requests.at(-1)!;
    expect(current.init?.signal?.aborted).toBe(false);
    const live = fakes.renderers.filter((renderer) => !renderer.dispose.mock.calls.length);
    expect(live).toHaveLength(1);

    await act(async () => stale.resolveText('old'));
    await flush();
    expect(fakes.parses).toHaveLength(0);
    await view.unmount();
    expect(fakes.renderers.every((renderer) => renderer.dispose.mock.calls.length === 1)).toBe(true);
  });
});
