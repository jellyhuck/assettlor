import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

export { act, createElement, Fragment, useEffect, useState } from 'react';
export { createRoot } from 'react-dom/client';
export type { Root } from 'react-dom/client';

/** Mount a component with React's act semantics in a jsdom test. */
export async function mountReact(element: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    root,
    async render(next: ReactNode) {
      await act(async () => { root.render(next); });
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

export async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}
