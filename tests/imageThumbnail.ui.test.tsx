// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Asset } from '../shared/types.js';
import { act, mountReact } from '../client/tests/reactDomHarness.js';
import { ImageThumbnail } from '../client/src/components/ImageThumbnail.js';

function asset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id, path: `${id}.png`, absolutePath: `/tmp/${id}.png`, name: id,
    extension: '.png', category: 'image', size: 256, mtime: 1, hash: id,
    isArchiveEntry: false, thumbnailUrl: `/thumb/${id}`, fileUrl: `/file/${id}`,
    metadata: { width: 16, height: 16 }, tags: [], createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

function image(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img');
}

function path(container: HTMLElement): string | null {
  const src = image(container)?.getAttribute('src');
  return src ? new URL(src, 'http://local').pathname : null;
}

describe('ImageThumbnail source fallback', () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(mounted.splice(0).map((view) => view.unmount()));
  });

  it('tries thumbnail then native file, then renders an accessible placeholder', async () => {
    const view = await mountReact(<ImageThumbnail asset={asset('hero')} />);
    mounted.push(view);
    expect(path(view.container)).toBe('/thumb/hero');
    await act(async () => { image(view.container)?.dispatchEvent(new Event('error')); });
    expect(path(view.container)).toBe('/file/hero');
    await act(async () => { image(view.container)?.dispatchEvent(new Event('error')); });
    expect(image(view.container)).toBeNull();
    expect(view.container.querySelector('[role="img"]')?.getAttribute('aria-label'))
      .toBe('Preview unavailable for hero');
  });

  it('never sends a raw TGA file to an image element', async () => {
    const raw = asset('raw', { extension: '.tga', fileUrl: '/file/raw' });
    const view = await mountReact(<ImageThumbnail asset={raw} />);
    mounted.push(view);
    expect(path(view.container)).toBe('/thumb/raw');
    await act(async () => { image(view.container)?.dispatchEvent(new Event('error')); });
    expect(image(view.container)).toBeNull();
    expect(view.container.querySelector('[role="img"]')).not.toBeNull();

    await view.render(<ImageThumbnail asset={{ ...raw, thumbnailUrl: '' }} />);
    expect(image(view.container)).toBeNull();
    expect(view.container.querySelector('[role="img"]')).not.toBeNull();
  });

  it('uses the native file when the thumbnail is absent and preserves URL queries', async () => {
    const current = asset('fallback', {
      thumbnailUrl: '', fileUrl: '/api/assets/fallback/file?download=1',
    });
    const view = await mountReact(<ImageThumbnail asset={current} pixelated={false} />);
    mounted.push(view);
    expect(path(view.container)).toBe('/api/assets/fallback/file');
    const src = image(view.container)?.getAttribute('src') ?? '';
    const parsed = new URL(src, 'http://local');
    expect(parsed.searchParams.get('download')).toBe('1');
    expect(parsed.searchParams.get('_thumbnail')).toBeTruthy();
    expect(image(view.container)?.className).toContain('smooth-render');
  });

  it('retries the thumbnail with a new URL after same-ID updates and explicit revisions', async () => {
    const first = asset('sprite');
    const view = await mountReact(<ImageThumbnail asset={first} />);
    mounted.push(view);
    const firstUrl = image(view.container)?.getAttribute('src');
    await act(async () => { image(view.container)?.dispatchEvent(new Event('error')); });
    expect(path(view.container)).toBe('/file/sprite');
    await act(async () => { image(view.container)?.dispatchEvent(new Event('error')); });
    expect(image(view.container)).toBeNull();

    await view.render(<ImageThumbnail asset={{ ...first, updatedAt: 2 }} />);
    expect(path(view.container)).toBe('/thumb/sprite');
    const updatedUrl = image(view.container)?.getAttribute('src');
    expect(updatedUrl).not.toBe(firstUrl);

    await view.render(<ImageThumbnail asset={first} revision={3} />);
    expect(path(view.container)).toBe('/thumb/sprite');
    expect(image(view.container)?.getAttribute('src')).not.toBe(updatedUrl);
  });
});
