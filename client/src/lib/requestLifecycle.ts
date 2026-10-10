/** A request token stays current only until its scope starts or closes another request. */
export function createRequestGate() {
  let generation = 0;
  let controller: AbortController | null = null;
  let disposed = false;

  const invalidate = () => {
    generation += 1;
    controller?.abort();
    controller = null;
  };

  return {
    begin() {
      if (disposed) throw new Error('Request scope is closed');
      invalidate();
      const currentController = new AbortController();
      controller = currentController;
      const currentGeneration = generation;
      return {
        signal: currentController.signal,
        isCurrent: () => !disposed && generation === currentGeneration
          && controller === currentController && !currentController.signal.aborted,
      };
    },
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}

export type RequestGate = ReturnType<typeof createRequestGate>;

export async function readJson(response: Response): Promise<unknown> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(response.ok
      ? 'The server returned an invalid JSON response'
      : `Request failed (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const message = data !== null && typeof data === 'object' && !Array.isArray(data)
      && 'error' in data && typeof data.error === 'string'
      ? data.error : `Request failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  return data;
}

export async function requestJson<T>(
  url: string,
  parse: (value: unknown) => T,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  return parse(await readJson(await fetcher(url, init)));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}
