// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, mountReact } from '../client/tests/reactDomHarness.js';
import { isBoolean, oneOf, readStoredValue, usePersistentState } from '../client/src/lib/persistentState.js';

const isZoom = oneOf('small', 'medium', 'large');

function ZoomPicker() {
  const [zoom, setZoom] = usePersistentState('cardZoom', 'medium', isZoom);
  return <button onClick={() => setZoom('large')}>{zoom}</button>;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('persistent view state', () => {
  it('restores a saved value after remounting', async () => {
    const first = await mountReact(<ZoomPicker />);
    expect(first.container.textContent).toBe('medium');
    await click(first.container.querySelector('button')!);
    expect(window.localStorage.getItem('assettlor:cardZoom')).toBe('"large"');
    await first.unmount();

    const second = await mountReact(<ZoomPicker />);
    expect(second.container.textContent).toBe('large');
    await second.unmount();
  });

  it('falls back for missing, malformed, or unknown values', () => {
    expect(readStoredValue('cardZoom', 'medium', isZoom)).toBe('medium');
    window.localStorage.setItem('assettlor:cardZoom', '{not json');
    expect(readStoredValue('cardZoom', 'medium', isZoom)).toBe('medium');
    window.localStorage.setItem('assettlor:cardZoom', '"huge"');
    expect(readStoredValue('cardZoom', 'medium', isZoom)).toBe('medium');
    window.localStorage.setItem('assettlor:stackedView', '"yes"');
    expect(readStoredValue('stackedView', true, isBoolean)).toBe(true);
  });

  it('keeps working when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const view = await mountReact(<ZoomPicker />);
    await click(view.container.querySelector('button')!);
    expect(view.container.textContent).toBe('large');
    await view.unmount();
  });
});
