// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { AudioWaveformPlayer } from '../client/src/components/AudioWaveformPlayer.js';
import type { Asset } from '../shared/types.js';

type WaveEvent = 'ready' | 'seeking' | 'error';
type WaveListener = (...args: unknown[]) => void;
interface FakeWaveform {
  options: { media: HTMLAudioElement; url: string };
  destroy: ReturnType<typeof vi.fn>;
  setTime: ReturnType<typeof vi.fn>;
  getDuration: ReturnType<typeof vi.fn>;
  on: (event: WaveEvent, listener: WaveListener) => () => void;
  emit: (event: WaveEvent, ...args: unknown[]) => void;
  emitLate: (event: WaveEvent, ...args: unknown[]) => void;
}

const mockWaves = vi.hoisted(() => [] as FakeWaveform[]);
vi.mock('../client/node_modules/wavesurfer.js/dist/wavesurfer.esm.js', () => ({
  default: {
    create: vi.fn((options: FakeWaveform['options']) => {
      const active = new Map<WaveEvent, Set<WaveListener>>();
      const all = new Map<WaveEvent, WaveListener[]>();
      const wave: FakeWaveform = {
        options,
        destroy: vi.fn(),
        setTime: vi.fn(),
        getDuration: vi.fn(() => 12),
        on(event, listener) {
          if (!active.has(event)) active.set(event, new Set());
          active.get(event)!.add(listener);
          if (!all.has(event)) all.set(event, []);
          all.get(event)!.push(listener);
          return () => { active.get(event)?.delete(listener); };
        },
        emit(event, ...args) {
          for (const listener of active.get(event) ?? []) listener(...args);
        },
        emitLate(event, ...args) {
          for (const listener of all.get(event) ?? []) listener(...args);
        },
      };
      mockWaves.push(wave);
      return wave;
    }),
  },
}));

function asset(id: string, revision = 1): Asset {
  return {
    id,
    path: `music/${id}.wav`,
    absolutePath: `/tmp/music/${id}.wav`,
    name: `${id}.wav`,
    extension: '.wav',
    category: 'audio',
    size: 100,
    mtime: revision,
    hash: `${id}-${revision}`,
    isArchiveEntry: false,
    thumbnailUrl: '',
    fileUrl: `/api/assets/${id}/file`,
    metadata: { duration: 12 },
    tags: [],
    createdAt: 1,
    updatedAt: revision,
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function setRange(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('AudioWaveformPlayer media lifecycle', () => {
  const queuedPlay: Array<Promise<void>> = [];
  let pause: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockWaves.length = 0;
    queuedPlay.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      const pending = queuedPlay.shift() ?? Promise.resolve();
      void pending.then(() => {
        Object.defineProperty(this, 'paused', { configurable: true, value: false });
      }).catch(() => {});
      return pending;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases the exact waveform and audio when switching variants during load', async () => {
    const first = asset('first');
    const second = asset('second');
    const view = await mountReact(<AudioWaveformPlayer asset={first} variants={[first, second]} />);
    const oldAudio = view.container.querySelector('audio')!;
    const oldWave = mockWaves[0];
    expect(oldWave.options.url).toContain(first.fileUrl);
    expect(oldWave.options.media).toBe(oldAudio);

    await view.render(<AudioWaveformPlayer asset={second} variants={[first, second]} />);
    const newAudio = view.container.querySelector('audio')!;
    expect(newAudio).not.toBe(oldAudio);
    expect(mockWaves).toHaveLength(2);
    expect(oldWave.destroy).toHaveBeenCalledOnce();
    expect(pause.mock.contexts).toContain(oldAudio);
    expect(oldAudio.hasAttribute('src')).toBe(false);

    await act(async () => {
      oldWave.emitLate('ready');
      oldWave.emitLate('error', new Error('late decode'));
      oldAudio.dispatchEvent(new Event('error'));
    });
    expect(view.container.textContent).toContain('Decoding audio waveform');
    expect(view.container.textContent).not.toContain('unavailable');
    await act(async () => { mockWaves[1].emit('ready'); });
    expect(view.container.textContent).not.toContain('Decoding audio waveform');
    await view.unmount();
    expect(mockWaves[1].destroy).toHaveBeenCalledOnce();
    expect(newAudio.hasAttribute('src')).toBe(false);
  });

  it('keeps playable audio and scrubbing available when waveform decoding fails', async () => {
    const view = await mountReact(<AudioWaveformPlayer asset={asset('playable')} />);
    const audio = view.container.querySelector('audio')!;
    await act(async () => {
      audio.dispatchEvent(new Event('canplay'));
      mockWaves[0].emit('error', new Error('decode failed'));
    });
    expect(view.container.textContent).toContain('Waveform unavailable. Audio playback is available below.');
    expect(audio.controls).toBe(true);
    expect(button(view.container, 'Play audio').disabled).toBe(false);
    await setRange(view.container.querySelector<HTMLInputElement>('[aria-label="Audio position scrubber"]')!, '5');
    expect(audio.currentTime).toBe(5);
    await click(button(view.container, 'Retry audio'));
    expect(mockWaves[0].destroy).toHaveBeenCalledOnce();
    expect(mockWaves).toHaveLength(2);
    expect(view.container.textContent).toContain('Decoding audio waveform');
    await view.unmount();
  });

  it('shows file failure separately and retries with a fresh media element', async () => {
    const view = await mountReact(<AudioWaveformPlayer asset={asset('missing')} />);
    const oldAudio = view.container.querySelector('audio')!;
    await act(async () => { oldAudio.dispatchEvent(new Event('error')); });
    expect(view.container.textContent).toContain('Audio file unavailable.');
    expect(button(view.container, 'Play audio').disabled).toBe(true);
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="Audio position scrubber"]')!.disabled).toBe(true);
    await click(button(view.container, 'Retry audio'));
    expect(view.container.querySelector('audio')).not.toBe(oldAudio);
    expect(mockWaves[0].destroy).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it('reports rejected playback without changing a replacement or stopped session', async () => {
    let rejectFirst!: (reason: Error) => void;
    queuedPlay.push(new Promise<void>((_, reject) => { rejectFirst = reject; }));
    const view = await mountReact(<AudioWaveformPlayer asset={asset('old')} />);
    await click(button(view.container, 'Play audio'));
    await view.render(<AudioWaveformPlayer asset={asset('new')} />);
    await act(async () => { rejectFirst(new Error('denied')); });
    expect(view.container.textContent).not.toContain('denied');

    queuedPlay.push(Promise.reject(new Error('permission denied')));
    await click(button(view.container, 'Play audio'));
    expect(view.container.textContent).toContain('Playback failed: permission denied');
    expect(button(view.container, 'Retry audio')).toBeTruthy();

    let rejectStopped!: (reason: Error) => void;
    queuedPlay.push(new Promise<void>((_, reject) => { rejectStopped = reject; }));
    await click(button(view.container, 'Play audio'));
    await click(button(view.container, 'Stop audio'));
    await act(async () => { rejectStopped(new Error('stopped request')); });
    expect(view.container.textContent).not.toContain('stopped request');
    await view.unmount();
  });

  it('syncs loop, mute, and volume without recreating waveform and rejects non-finite times', async () => {
    const invalid = { ...asset('timing'), metadata: { duration: Infinity } };
    const view = await mountReact(<AudioWaveformPlayer asset={invalid} />);
    const audio = view.container.querySelector('audio')!;
    expect(view.container.textContent).not.toMatch(/Infinity|NaN/);
    await click(button(view.container, 'Loop audio'));
    expect(audio.loop).toBe(true);
    await click(button(view.container, 'Mute audio'));
    expect(audio.muted).toBe(true);
    await setRange(view.container.querySelector<HTMLInputElement>('[aria-label="Audio volume"]')!, '0.4');
    expect(audio.volume).toBe(0.4);
    expect(audio.muted).toBe(false);
    expect(mockWaves).toHaveLength(1);

    mockWaves[0].getDuration.mockReturnValue(Infinity);
    await act(async () => {
      mockWaves[0].emit('ready');
      Object.defineProperty(audio, 'duration', { configurable: true, value: NaN });
      Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: Infinity });
      audio.dispatchEvent(new Event('durationchange'));
      audio.dispatchEvent(new Event('timeupdate'));
    });
    expect(view.container.textContent).not.toMatch(/Infinity|NaN/);
    await view.unmount();
  });

  it('reattaches the audio source when StrictMode replays the media effect', async () => {
    const current = asset('strict');
    const view = await mountReact(<StrictMode><AudioWaveformPlayer asset={current} /></StrictMode>);
    const audio = view.container.querySelector('audio')!;
    expect(mockWaves).toHaveLength(2);
    expect(mockWaves[0].destroy).toHaveBeenCalledOnce();
    expect(mockWaves[1].options.media).toBe(audio);
    expect(audio.getAttribute('src')).toBe(current.fileUrl);
    await view.unmount();
    expect(audio.hasAttribute('src')).toBe(false);
  });

  it('remounts on a same-ID source revision and cleans up on unmount', async () => {
    const view = await mountReact(<AudioWaveformPlayer asset={asset('same', 1)} />);
    const oldAudio = view.container.querySelector('audio')!;
    await view.render(<AudioWaveformPlayer asset={asset('same', 2)} />);
    expect(mockWaves).toHaveLength(2);
    expect(mockWaves[0].destroy).toHaveBeenCalledOnce();
    expect(view.container.querySelector('audio')).not.toBe(oldAudio);
    await view.unmount();
    expect(mockWaves[1].destroy).toHaveBeenCalledOnce();
  });
});
