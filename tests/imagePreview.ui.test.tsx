// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '../shared/types.js';
import { act, click, mountReact } from '../client/tests/reactDomHarness.js';
import { ImagePreview, type ImagePreviewProps } from '../client/src/components/ImagePreview.js';

function asset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id, path: `${id}.png`, absolutePath: `/tmp/${id}.png`, name: id,
    extension: '.png', category: 'image', size: 256, mtime: 1, hash: id,
    isArchiveEntry: false, thumbnailUrl: `/thumb/${id}`, fileUrl: `/file/${id}`,
    metadata: { width: 64, height: 64 }, tags: [], createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

const onPixelatedChange = vi.fn();
const onCheckerboardChange = vi.fn();

function preview(current: Asset, overrides: Partial<ImagePreviewProps> = {}) {
  return <ImagePreview asset={current} pixelated checkerboard
    onPixelatedChange={onPixelatedChange}
    onCheckerboardChange={onCheckerboardChange} {...overrides} />;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function image(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img');
}

function imagePath(container: HTMLElement): string | null {
  const src = image(container)?.getAttribute('src');
  return src ? new URL(src, 'http://local').pathname : null;
}

function pointer(viewport: HTMLElement, type: string, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  viewport.dispatchEvent(event);
}

describe('ImagePreview source and viewport lifecycle', () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(mounted.splice(0).map((view) => view.unmount()));
    onPixelatedChange.mockClear();
    onCheckerboardChange.mockClear();
  });

  it('tries native file then thumbnail once, shows a terminal fallback, and retries explicitly', async () => {
    const current = asset('hero', { fileUrl: '/file/hero?mode=original' });
    const view = await mountReact(preview(current));
    mounted.push(view);
    expect(imagePath(view.container)).toBe('/file/hero');
    const firstUrl = image(view.container)?.getAttribute('src');
    expect(firstUrl).toMatch(/^\/file\/hero\?mode=original&_preview=/);
    await act(async () => { image(view.container)?.dispatchEvent(new Event('error')); });
    expect(imagePath(view.container)).toBe('/thumb/hero');
    await act(async () => { image(view.container)?.dispatchEvent(new Event('error')); });
    expect(image(view.container)).toBeNull();
    expect(view.container.textContent).toContain('Preview unavailable');
    await click(Array.from(view.container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Retry image')!);
    expect(imagePath(view.container)).toBe('/file/hero');
    expect(image(view.container)?.getAttribute('src')).not.toBe(firstUrl);
  });

  it('uses only the converted thumbnail for TGA and resets on same-ID regeneration', async () => {
    const current = asset('raw', { extension: '.tga' });
    const view = await mountReact(preview(current));
    mounted.push(view);
    expect(imagePath(view.container)).toBe('/thumb/raw');
    const firstUrl = image(view.container)?.getAttribute('src');
    await act(async () => { image(view.container)?.dispatchEvent(new Event('error')); });
    expect(image(view.container)).toBeNull();

    await view.render(preview({ ...current, updatedAt: 2 }));
    expect(imagePath(view.container)).toBe('/thumb/raw');
    const regeneratedUrl = image(view.container)?.getAttribute('src');
    expect(regeneratedUrl).not.toBe(firstUrl);
    await act(async () => { image(view.container)?.dispatchEvent(new Event('error')); });
    await view.render(preview(current, { revision: 3 }));
    expect(imagePath(view.container)).toBe('/thumb/raw');
    expect(image(view.container)?.getAttribute('src')).not.toBe(regeneratedUrl);

    await view.render(preview(asset('missing', { fileUrl: '', thumbnailUrl: '' })));
    expect(image(view.container)).toBeNull();
    expect(view.container.textContent).toContain('Preview unavailable');
    expect(view.container.textContent).not.toContain('Retry image');
  });

  it('keeps a 4x stage scrollable to every edge with pointer and keyboard pan', async () => {
    const view = await mountReact(preview(asset('map')));
    mounted.push(view);
    const viewport = view.container.querySelector<HTMLElement>('[role="region"]')!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, get: () => 240 },
      clientHeight: { configurable: true, get: () => 240 },
      scrollWidth: { configurable: true, get: () =>
        Number.parseFloat(viewport.firstElementChild?.getAttribute('style')?.match(/width: ([\d.]+)%/)?.[1] ?? '100') * 2.4 },
      scrollHeight: { configurable: true, get: () =>
        Number.parseFloat(viewport.firstElementChild?.getAttribute('style')?.match(/height: ([\d.]+)%/)?.[1] ?? '100') * 2.4 },
    });

    const unzoomedArrow = new KeyboardEvent('keydown', {
      key: 'ArrowDown', bubbles: true, cancelable: true,
    });
    await act(async () => { viewport.dispatchEvent(unzoomedArrow); });
    expect(unzoomedArrow.defaultPrevented).toBe(false);

    for (let index = 0; index < 12; index += 1) {
      await click(button(view.container, 'Zoom in'));
    }
    expect(view.container.querySelector('[aria-label="Image zoom"]')?.textContent?.trim()).toBe('400%');
    expect(viewport.firstElementChild?.getAttribute('style')).toContain('width: 400%');
    expect(viewport.scrollWidth - viewport.clientWidth).toBe(720);
    viewport.focus();
    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(viewport.scrollLeft).toBe(720);
    expect(viewport.scrollTop).toBe(720);
    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(viewport.scrollLeft).toBe(48);
    expect(viewport.scrollTop).toBe(48);

    await act(async () => {
      pointer(viewport, 'pointerdown', 100, 100);
      pointer(viewport, 'pointermove', -1000, -1000);
      pointer(viewport, 'pointerup', -1000, -1000);
    });
    expect(viewport.scrollLeft).toBe(720);
    expect(viewport.scrollTop).toBe(720);

    await click(button(view.container, 'Reset zoom and pan'));
    expect(view.container.querySelector('[aria-label="Image zoom"]')?.textContent?.trim()).toBe('100%');
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
  });

  it('resets zoom/pan on a new source and forwards display controls', async () => {
    const view = await mountReact(preview(asset('first')));
    mounted.push(view);
    const viewport = view.container.querySelector<HTMLElement>('[role="region"]')!;
    await click(button(view.container, 'Zoom in'));
    expect(view.container.querySelector('[aria-label="Image zoom"]')?.textContent?.trim()).toBe('125%');
    viewport.scrollLeft = 100;
    viewport.scrollTop = 75;
    await click(button(view.container, 'Pixelated rendering'));
    await click(button(view.container, 'Checkerboard background'));
    expect(onPixelatedChange).toHaveBeenCalledWith(false);
    expect(onCheckerboardChange).toHaveBeenCalledWith(false);

    await view.render(preview(asset('second'), { pixelated: false, checkerboard: false }));
    const nextViewport = view.container.querySelector<HTMLElement>('[role="region"]')!;
    expect(view.container.querySelector('[aria-label="Image zoom"]')?.textContent?.trim()).toBe('100%');
    expect(nextViewport.scrollLeft).toBe(0);
    expect(nextViewport.scrollTop).toBe(0);
    expect(nextViewport.className).toContain('bg-[#11111d]');
    expect(image(view.container)?.className).toContain('smooth-render');

    await view.render(preview(asset('first')));
    expect(view.container.querySelector('[aria-label="Image zoom"]')?.textContent?.trim()).toBe('100%');
  });

  it('centers a shrunken image without shrinking its viewport', async () => {
    const view = await mountReact(preview(asset('small')));
    mounted.push(view);
    for (let index = 0; index < 3; index += 1) {
      await click(button(view.container, 'Zoom out'));
    }
    const viewport = view.container.querySelector<HTMLElement>('[role="region"]')!;
    expect(view.container.querySelector('[aria-label="Image zoom"]')?.textContent?.trim()).toBe('25%');
    expect(viewport.firstElementChild?.getAttribute('style')).toContain('width: 100%');
    expect(image(view.container)?.getAttribute('style')).toContain('width: 25%');
    expect(viewport.firstElementChild?.className).toContain('justify-center');
  });
});
