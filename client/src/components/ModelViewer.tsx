import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Loader2, Pause, Play, RotateCcw, Rotate3d, Grid3x3 } from 'lucide-react';
import type { Asset } from '../types';

interface ModelViewerProps {
  asset: Asset;
  revision?: number;
}

type ViewerStatus = 'loading' | 'ready' | 'unavailable';

/** Imperative handles the toolbar uses; owned by one effect run. */
interface ViewerControls {
  resetView: () => void;
  setWireframe: (enabled: boolean) => void;
  setAutoRotate: (enabled: boolean) => void;
  playClip: (index: number) => void;
  setPaused: (paused: boolean) => void;
}

function describeLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('DRACOLoader')) return 'Draco-compressed models are not supported yet.';
  if (message.includes('KTX2Loader')) return 'KTX2 (Basis) textures are not supported yet.';
  return `Could not load this model: ${message}`;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

/** A source revision or retry gets a new renderer and WebGL context. */
export function ModelViewer({ asset, revision }: ModelViewerProps) {
  const [retry, setRetry] = useState(0);
  const sourceKey = [asset.id, asset.fileUrl, asset.hash, asset.mtime,
    asset.updatedAt, revision ?? '', retry].join('\0');
  return <ModelViewerSession key={sourceKey} asset={asset} onRetry={() => setRetry((count) => count + 1)} />;
}

export default ModelViewer;

function ModelViewerSession({ asset, onRetry }: { asset: Asset; onRetry: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<ViewerControls | null>(null);
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<string[]>([]);
  const [activeClip, setActiveClip] = useState(0);
  const [paused, setPaused] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let active = true;
    const abort = new AbortController();
    const fail = (message: string) => {
      if (!active) return;
      setError(message);
      setStatus('unavailable');
    };

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (reason) {
      console.warn('WebGL renderer unavailable:', reason);
      queueMicrotask(() => fail('3D preview needs WebGL, which is not available in this browser.'));
      return () => { active = false; };
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.domElement.className = 'block h-full w-full';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.7;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x1e293b, 0.3));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(3, 5, 4);
    scene.add(keyLight);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.position.set(2, 1.5, 2);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.autoRotateSpeed = 1.5;

    const timer = new THREE.Clock();
    let mixer: THREE.AnimationMixer | null = null;
    let actions: THREE.AnimationAction[] = [];
    let model: THREE.Object3D | null = null;
    let frame = 0;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(container);
    resize();

    const render = () => {
      frame = requestAnimationFrame(render);
      mixer?.update(timer.getDelta());
      orbit.update();
      renderer.render(scene, camera);
    };
    render();

    const resetView = () => {
      if (!model) return;
      const box = new THREE.Box3().setFromObject(model);
      const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
      const radius = sphere.radius > 0 ? sphere.radius : 1;
      const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.1;
      camera.near = distance / 100;
      camera.far = distance * 100;
      camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(distance));
      camera.updateProjectionMatrix();
      orbit.target.copy(sphere.center);
      orbit.update();
    };

    controlsRef.current = {
      resetView,
      setWireframe(enabled) {
        model?.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if ('wireframe' in material) (material as THREE.MeshStandardMaterial).wireframe = enabled;
          }
        });
      },
      setAutoRotate(enabled) {
        orbit.autoRotate = enabled;
      },
      playClip(index) {
        actions.forEach((action, i) => {
          if (i === index) action.reset().play();
          else action.stop();
        });
      },
      setPaused(isPaused) {
        for (const action of actions) action.paused = isPaused;
      },
    };

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    fetch(new URL(asset.fileUrl, window.location.origin).href, { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => (active ? loader.parseAsync(data, '') : null))
      .then((gltf) => {
        if (!gltf) return;
        if (!active) {
          disposeObject(gltf.scene);
          return;
        }
        model = gltf.scene;
        scene.add(model);
        resetView();
        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model);
          actions = gltf.animations.map((clip) => mixer!.clipAction(clip));
          actions[0].play();
        }
        setClips(gltf.animations.map((clip, index) => clip.name || `Animation ${index + 1}`));
        setStatus('ready');
      })
      .catch((reason) => {
        if (!active || abort.signal.aborted) return;
        console.warn(`Could not load model ${asset.name}:`, reason);
        fail(describeLoadError(reason));
      });

    return () => {
      active = false;
      abort.abort();
      cancelAnimationFrame(frame);
      observer?.disconnect();
      controlsRef.current = null;
      orbit.dispose();
      mixer?.stopAllAction();
      if (model) disposeObject(model);
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [asset.fileUrl, asset.name]);

  const toolbarButton = 'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40';
  const idle = 'border-[#2d2d46] bg-[#181829] text-slate-300 hover:text-white';
  const pressed = 'border-indigo-400 bg-indigo-600 text-white';
  const ready = status === 'ready';

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="relative h-64 overflow-hidden rounded-lg border border-[#2b2b44] bg-gradient-to-b from-[#1b1b2e] to-[#0f0f19]">
        <div
          ref={containerRef}
          role="region"
          aria-label={`3D preview of ${asset.name}`}
          className="h-full w-full cursor-grab active:cursor-grabbing"
        />
        {status === 'loading' && (
          <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-indigo-300">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            <span>Loading 3D model…</span>
          </div>
        )}
        {status === 'unavailable' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#11111d]/90 p-4 text-center">
            <img src={asset.thumbnailUrl} alt="" className="h-20 w-20 object-contain opacity-60" />
            <p role="alert" className="text-xs text-slate-300">{error}</p>
            <button type="button" onClick={onRetry} className="text-xs text-indigo-300 underline hover:text-indigo-100">
              Retry model
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" disabled={!ready} onClick={() => controlsRef.current?.resetView()}
          className={`${toolbarButton} ${idle}`} aria-label="Reset 3D view" title="Reset view">
          <RotateCcw aria-hidden="true" className="h-3 w-3" />Reset
        </button>
        <button type="button" disabled={!ready} aria-pressed={autoRotate}
          onClick={() => { controlsRef.current?.setAutoRotate(!autoRotate); setAutoRotate(!autoRotate); }}
          className={`${toolbarButton} ${autoRotate ? pressed : idle}`} aria-label="Auto-rotate model" title="Auto-rotate">
          <Rotate3d aria-hidden="true" className="h-3 w-3" />Rotate
        </button>
        <button type="button" disabled={!ready} aria-pressed={wireframe}
          onClick={() => { controlsRef.current?.setWireframe(!wireframe); setWireframe(!wireframe); }}
          className={`${toolbarButton} ${wireframe ? pressed : idle}`} aria-label="Show wireframe" title="Wireframe">
          <Grid3x3 aria-hidden="true" className="h-3 w-3" />Wireframe
        </button>
        {clips.length > 0 && <>
          <button type="button" aria-label={paused ? 'Play animation' : 'Pause animation'}
            onClick={() => { controlsRef.current?.setPaused(!paused); setPaused(!paused); }}
            className={`${toolbarButton} ${idle}`}>
            {paused ? <Play aria-hidden="true" className="h-3 w-3" /> : <Pause aria-hidden="true" className="h-3 w-3" />}
          </button>
          <select
            aria-label="Animation clip"
            value={activeClip}
            onChange={(event) => {
              const index = Number(event.target.value);
              controlsRef.current?.playClip(index);
              controlsRef.current?.setPaused(false);
              setActiveClip(index);
              setPaused(false);
            }}
            className="min-w-0 max-w-[10rem] flex-1 truncate rounded-md border border-[#2d2d46] bg-[#181829] px-1.5 py-1 text-[11px] text-slate-200"
          >
            {clips.map((name, index) => <option key={index} value={index}>{name}</option>)}
          </select>
        </>}
      </div>
      <p className="text-[10px] text-slate-500">Drag to orbit · scroll to zoom · right-drag to pan</p>
    </div>
  );
}
