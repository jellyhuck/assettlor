import { describe, expect, it } from 'vitest';
import { isBackdropPress, tabWrapTarget } from '../client/src/lib/dialogFocus.js';

describe('dialog focus decisions', () => {
  it('wraps Tab only at the dialog boundaries', () => {
    const buttons = ['close', 'scope', 'run'];
    expect(tabWrapTarget(buttons, 'run', false)).toBe('close');
    expect(tabWrapTarget(buttons, 'close', true)).toBe('run');
    expect(tabWrapTarget(buttons, 'scope', false)).toBeUndefined();
    expect(tabWrapTarget([], 'run', false)).toBeUndefined();
  });

  it('dismisses only on the backdrop itself', () => {
    const backdrop = new EventTarget();
    const content = new EventTarget();
    expect(isBackdropPress(backdrop, backdrop)).toBe(true);
    expect(isBackdropPress(content, backdrop)).toBe(false);
    expect(isBackdropPress(null, null)).toBe(false);
  });
});
