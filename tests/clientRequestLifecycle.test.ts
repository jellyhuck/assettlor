import { describe, expect, it, vi } from 'vitest';
import { createRequestGate, requestJson } from '../client/src/lib/requestLifecycle.js';

describe('client request lifecycle', () => {
  it('ignores a delayed response from an earlier generation', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    })) as unknown as typeof fetch;
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
    resolvers[1](Response.json({ name: 'new' }));
    await newResult;
    resolvers[0](Response.json({ name: 'old' }));
    await oldResult;
    expect(accepted).toEqual(['new']);
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
});
