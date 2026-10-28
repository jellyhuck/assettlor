import { describe, expect, it } from 'vitest';
import { sameDirectories } from '../client/src/lib/settingsDraft.js';

describe('sameDirectories', () => {
  it('ignores order, spelling, and blank entries', () => {
    expect(sameDirectories(['/a', '/b'], ['/b/', '/a/./'])).toBe(true);
    expect(sameDirectories(['C:\\Assets'], ['c:/Assets'])).toBe(true);
    expect(sameDirectories(['/a', ' '], ['/a'])).toBe(true);
    expect(sameDirectories([], [])).toBe(true);
  });

  it('detects added, removed, and replaced directories', () => {
    expect(sameDirectories(['/a'], ['/a', '/b'])).toBe(false);
    expect(sameDirectories(['/a', '/b'], ['/a'])).toBe(false);
    expect(sameDirectories(['/a'], ['/b'])).toBe(false);
    expect(sameDirectories([], ['/a'])).toBe(false);
  });
});
