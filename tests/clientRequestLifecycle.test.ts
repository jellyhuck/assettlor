import { describe, expect, it } from 'vitest';
import { createDeferredFetch } from '../client/tests/asyncFixtures.js';
import {
  createRequestGate, expectArray, expectRecord, isAbortError, readJson, requestJson,
} from '../client/src/lib/requestLifecycle.js';

describe('client request lifecycle', () => {
  it('ignores a delayed response from an earlier generation', async () => {
    const { fetcher, requests } = createDeferredFetch();
    const gate = createRequestGate();
    const accepted: string[] = [];

    const oldRequest = gate.begin();
    const oldResult = requestJson('/old', (value) => value as { name: string },
      { signal: oldRequest.signal }, fetcher).then((value) => {
      if (oldRequest.isCurrent()) accepted.push(value.name);
    });
    const newRequest = gate.begin();
    const newResult = requestJson('/new', (value) => value as { name: string },
      { signal: newRequest.signal }, fetcher).then((value) => {
      if (newRequest.isCurrent()) accepted.push(value.name);
    });

    expect(oldRequest.signal.aborted).toBe(true);
    expect(requests.map((request) => request.url)).toEqual(['/old', '/new']);
    requests[1].resolveJson({ name: 'new' });
    await newResult;
    requests[0].resolveJson({ name: 'old' });
    await oldResult;
    expect(accepted).toEqual(['new']);
    gate.dispose();
  });

  it('rejects responses belonging to a different selected identity', () => {
    const gate = createRequestGate();
    const first = gate.begin('asset-a');
    expect(first.isCurrent('asset-a')).toBe(true);
    expect(first.isCurrent('asset-b')).toBe(false);
    expect(first.isCurrent(undefined)).toBe(false);

    const second = gate.begin('asset-b');
    expect(first.isCurrent('asset-a')).toBe(false);
    expect(second.isCurrent('asset-b')).toBe(true);
    gate.dispose();
  });

  it('invalidates pending work on disposal', () => {
    const gate = createRequestGate();
    const request = gate.begin();
    gate.dispose();
    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
    expect(() => gate.begin()).toThrow('closed');
  });

  it('rejects an HTTP failure before its body can enter typed state', async () => {
    const { fetcher, requests } = createDeferredFetch();
    const parser = (value: unknown) => expectRecord(value, 'settings');
    const request = requestJson('/api/settings', parser, undefined, fetcher);
    requests[0].resolveJson({ error: 'Cannot read settings' }, 500);
    await expect(request).rejects.toThrow('Cannot read settings');

    const generic = requestJson('/api/settings', parser, undefined, fetcher);
    requests[1].resolveJson({ unexpected: true }, 503);
    await expect(generic).rejects.toThrow('HTTP 503');
  });

  it('reports malformed JSON and rejected response shapes', async () => {
    const { fetcher, requests } = createDeferredFetch();
    const malformed = requestJson('/api/tags', (value) => expectArray(value,
      (entry): entry is string => typeof entry === 'string', 'tags'), undefined, fetcher);
    requests[0].resolveText('not json');
    await expect(malformed).rejects.toThrow('invalid JSON');

    const wrongShape = requestJson('/api/tags', (value) => expectArray(value,
      (entry): entry is string => typeof entry === 'string', 'tags'), undefined, fetcher);
    requests[1].resolveJson({ error: 'This is not a tag list' });
    await expect(wrongShape).rejects.toThrow('tags response has an unexpected shape');

    expect(() => expectRecord(['not', 'an', 'object'], 'settings')).toThrow('settings response');
    expect(() => expectArray(['tag', 42],
      (entry): entry is string => typeof entry === 'string', 'tags')).toThrow('tags response');
  });

  it('passes AbortSignal to fetch and preserves AbortError during decoding', async () => {
    const { fetcher, requests } = createDeferredFetch();
    const controller = new AbortController();
    const request = requestJson('/api/assets', expectRecord,
      { signal: controller.signal }, fetcher);
    expect(requests[0].init?.signal).toBe(controller.signal);
    controller.abort();
    expect(requests[0].init?.signal?.aborted).toBe(true);
    const abort = new DOMException('The operation was aborted', 'AbortError');
    requests[0].response.reject(abort);
    await expect(request).rejects.toBe(abort);
    expect(isAbortError(abort)).toBe(true);

    const bodyAbort = { ok: true, json: async () => { throw abort; } } as Response;
    await expect(readJson(bodyAbort)).rejects.toBe(abort);
  });
});
