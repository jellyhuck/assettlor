// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../client/tests/asyncFixtures.js';
import { act, click, mountReact, useEffect, useState } from '../client/tests/reactDomHarness.js';

function LiveStatus() {
  const [status, setStatus] = useState('waiting');
  const [clicks, setClicks] = useState(0);

  useEffect(() => {
    const source = new EventSource('/api/scan/progress');
    source.onmessage = (event) => setStatus((JSON.parse(event.data) as { status: string }).status);
    source.onerror = () => setStatus('disconnected');
    source.onopen = () => setStatus('connected');
    return () => source.close();
  }, []);

  return <div>
    <output role="status">{status}</output>
    <button onClick={() => setClicks((count) => count + 1)}>Clicked {clicks}</button>
  </div>;
}

describe('client DOM and stream fixtures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.reset();
  });

  it('drives EventSource replay, recovery, interaction, and unmount cleanup', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const view = await mountReact(<LiveStatus />);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe('/api/scan/progress');
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('waiting');

    await act(async () => { source.open(); });
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('connected');
    await act(async () => { source.emit({ status: 'completed' }); });
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('completed');
    await act(async () => { source.fail(); });
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('disconnected');
    await act(async () => { source.open(); });
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('connected');

    await click(view.container.querySelector('button')!);
    expect(view.container.querySelector('button')?.textContent).toBe('Clicked 1');
    await view.unmount();
    expect(source.closed).toBe(true);
  });
});
