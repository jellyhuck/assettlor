// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from '../client/tests/reactDomHarness.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { FlipbookPlayer } from '../client/src/components/FlipbookPlayer.js';
import type { Asset } from '../shared/types.js';

function frame(id: string): Asset {
  return {
    id,
    path: `${id}.png`,
    absolutePath: `/tmp/${id}.png`,
    name: `${id}.png`,
    extension: '.png',
    category: 'image',
    size: 1,
    mtime: 0,
    hash: id,
    isArchiveEntry: false,
    thumbnailUrl: `/thumbs/${id}`,
    fileUrl: `/files/${id}`,
    metadata: {},
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function button(container: HTMLElement, title: string): HTMLButtonElement {
  const target = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!target) throw new Error(`Missing button: ${title}`);
  return target;
}

function shownFrame(container: HTMLElement): string {
  return container.querySelector<HTMLImageElement>('img')?.alt ?? '';
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(milliseconds); });
}

async function moveRange(input: HTMLInputElement, value: number): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('FlipbookPlayer playback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('handles zero and single-frame sets without a running timer', async () => {
    const mounted = await mountReact(createElement(FlipbookPlayer, { frames: [] }));
    try {
      expect(mounted.container.textContent).toContain('No frames available');
      expect(vi.getTimerCount()).toBe(0);

      await mounted.render(createElement(FlipbookPlayer, {
        frames: [frame('only')], initialFrameIndex: 99, initialFps: 0,
      }));
      expect(shownFrame(mounted.container)).toBe('only.png');
      expect(mounted.container.textContent).toContain('1 / 1');
      expect(mounted.container.textContent).toContain('1 fps');
      expect(button(mounted.container, 'Play').disabled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await mounted.unmount();
    }
  });

  it('stops at the final non-loop frame and replays from the beginning', async () => {
    const frames = ['a', 'b', 'c'].map(frame);
    const onFrameChange = vi.fn();
    const mounted = await mountReact(createElement(FlipbookPlayer, {
      frames, initialFps: 10, onFrameChange,
    }));
    try {
      await click(button(mounted.container, 'Toggle Loop'));
      await advance(200);
      expect(shownFrame(mounted.container)).toBe('c.png');
      expect(button(mounted.container, 'Play')).toBeTruthy();
      expect(vi.getTimerCount()).toBe(0);
      expect(onFrameChange.mock.calls.map(([index]) => index)).toEqual([1, 2]);

      await advance(1000);
      expect(onFrameChange).toHaveBeenCalledTimes(2);
      await click(button(mounted.container, 'Play'));
      expect(shownFrame(mounted.container)).toBe('a.png');
      expect(button(mounted.container, 'Pause')).toBeTruthy();
      expect(onFrameChange).toHaveBeenLastCalledWith(0, frames[0]);
      await advance(100);
      expect(shownFrame(mounted.container)).toBe('b.png');
    } finally {
      await mounted.unmount();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('keeps metadata selection separate from playback and supports manual stepping', async () => {
    const frames = ['a', 'b', 'c'].map(frame);
    const onSelectFrame = vi.fn();
    const onFrameChange = vi.fn();
    const props = { frames, initialFps: 10, initialFrameIndex: 0, selectedFrameIndex: 0, onSelectFrame, onFrameChange };
    const mounted = await mountReact(createElement(FlipbookPlayer, props));
    try {
      await advance(100);
      expect(shownFrame(mounted.container)).toBe('b.png');

      await mounted.render(createElement(FlipbookPlayer, {
        ...props, initialFrameIndex: 2, selectedFrameIndex: 2,
      }));
      expect(shownFrame(mounted.container)).toBe('b.png');
      await click(button(mounted.container, 'Frame 1: a.png'));
      expect(onSelectFrame).toHaveBeenLastCalledWith(0, frames[0]);
      expect(shownFrame(mounted.container)).toBe('b.png');

      await click(button(mounted.container, 'Pause'));
      await click(button(mounted.container, 'Next Frame'));
      expect(shownFrame(mounted.container)).toBe('c.png');
      await click(button(mounted.container, 'Previous Frame'));
      expect(shownFrame(mounted.container)).toBe('b.png');
      await click(button(mounted.container, 'Frame 1: a.png'));
      expect(shownFrame(mounted.container)).toBe('a.png');

      const scrubber = mounted.container.querySelector<HTMLInputElement>('input[type="range"][max="2"]');
      if (!scrubber) throw new Error('Missing frame scrubber');
      await moveRange(scrubber, 2);
      expect(shownFrame(mounted.container)).toBe('c.png');
      expect(onFrameChange).toHaveBeenLastCalledWith(2, frames[2]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await mounted.unmount();
    }
  });

  it('clamps starting state and applies each frame set’s initial speed', async () => {
    const a = ['a0', 'a1', 'a2'].map(frame);
    const b = ['b0', 'b1', 'b2'].map(frame);
    const mounted = await mountReact(createElement(FlipbookPlayer, {
      frames: a, initialFps: 2, initialFrameIndex: -7,
    }));
    try {
      expect(shownFrame(mounted.container)).toBe('a0.png');
      await advance(499);
      expect(shownFrame(mounted.container)).toBe('a0.png');
      await advance(1);
      expect(shownFrame(mounted.container)).toBe('a1.png');

      await mounted.render(createElement(FlipbookPlayer, {
        frames: b, initialFps: 120, initialFrameIndex: 99,
      }));
      expect(shownFrame(mounted.container)).toBe('b2.png');
      expect(mounted.container.textContent).toContain('60 fps');
      const speed = mounted.container.querySelector<HTMLInputElement>('input[type="range"][max="60"]');
      expect(speed?.min).toBe('1');
      expect(speed?.max).toBe('60');
      await advance(17);
      expect(shownFrame(mounted.container)).toBe('b0.png');
      if (!speed) throw new Error('Missing speed slider');
      await moveRange(speed, 20);
      expect(mounted.container.textContent).toContain('20 fps');
      await advance(49);
      expect(shownFrame(mounted.container)).toBe('b0.png');
      await advance(1);
      expect(shownFrame(mounted.container)).toBe('b1.png');
    } finally {
      await mounted.unmount();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
