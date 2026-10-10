/** A promise whose completion order is controlled by the test. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export interface PendingFetch {
  url: string;
  init?: RequestInit;
  response: ReturnType<typeof deferred<Response>>;
  resolveJson(value: unknown, status?: number): void;
  resolveText(value: string, status?: number): void;
}

/** A fetch double that deliberately keeps aborted requests pending for race tests. */
export function createDeferredFetch() {
  const requests: PendingFetch[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const response = deferred<Response>();
    const request: PendingFetch = {
      url: input instanceof Request ? input.url : String(input),
      init,
      response,
      resolveJson(value, status = 200) {
        response.resolve(Response.json(value, { status }));
      },
      resolveText(value, status = 200) {
        response.resolve(new Response(value, { status }));
      },
    };
    requests.push(request);
    return response.promise;
  };
  return { fetcher, requests };
}

/** Covers the EventSource surface used by App, including replay and reconnect. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = 0;
  closed = false;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(url: string | URL, options?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = options?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  open() {
    if (this.closed) return;
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  emit(value: unknown) {
    if (this.closed) return;
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  fail() {
    if (this.closed) return;
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  static reset() {
    for (const source of FakeEventSource.instances) source.close();
    FakeEventSource.instances = [];
  }
}
