import { describe, expect, it } from 'vitest';
import { attachmentContentDisposition } from '../server/src/routes/downloadHeaders.js';

describe('attachmentContentDisposition', () => {
  it('names the attachment after the last path segment', () => {
    expect(attachmentContentDisposition('sfx/hits/hit_a.wav'))
      .toBe(`attachment; filename="hit_a.wav"; filename*=UTF-8''hit_a.wav`);
    expect(attachmentContentDisposition('gfx\\tile.png'))
      .toBe(`attachment; filename="tile.png"; filename*=UTF-8''tile.png`);
  });

  it('keeps the exact UTF-8 name and an ASCII fallback for non-ASCII names', () => {
    expect(attachmentContentDisposition('épée (1).png'))
      .toBe(`attachment; filename="_p_e (1).png"; filename*=UTF-8''%C3%A9p%C3%A9e%20%281%29.png`);
  });

  it('cannot break out of the quoted fallback', () => {
    const header = attachmentContentDisposition('say "hi";\r\nx.png');
    expect(header).toBe(`attachment; filename="say _hi_;__x.png"; filename*=UTF-8''say%20%22hi%22%3B%0D%0Ax.png`);
  });

  it('falls back to a generic name when there is no file name', () => {
    expect(attachmentContentDisposition('folder/')).toBe(`attachment; filename="folder"; filename*=UTF-8''folder`);
    expect(attachmentContentDisposition('')).toBe(`attachment; filename="download"; filename*=UTF-8''download`);
  });
});
