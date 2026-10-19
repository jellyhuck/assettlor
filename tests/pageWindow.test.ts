import { describe, expect, it } from 'vitest';
import { pageWindow } from '../client/src/lib/pageWindow.js';

describe('pageWindow', () => {
  it('lists every page when there are only a few', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 2)).toEqual([1, 2]);
    expect(pageWindow(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('collapses distant pages into gaps around the current page', () => {
    expect(pageWindow(1, 10)).toEqual([1, 2, null, 10]);
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(10, 10)).toEqual([1, null, 9, 10]);
  });

  it('shows a lone hidden page instead of a gap', () => {
    expect(pageWindow(4, 10)).toEqual([1, 2, 3, 4, 5, null, 10]);
    expect(pageWindow(7, 10)).toEqual([1, null, 6, 7, 8, 9, 10]);
  });
});
