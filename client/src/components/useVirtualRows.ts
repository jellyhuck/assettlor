import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type Range,
  type Rect,
  type VirtualItem,
} from '@tanstack/react-virtual';

interface VirtualRowsOptions {
  count: number;
  getScrollElement: () => HTMLDivElement | null;
  estimateSize: (index: number) => number;
  getItemKey: (index: number) => string;
  rangeExtractor: (range: Range) => number[];
  overscan: number;
  initialRect: Rect;
}

interface VirtualRowsSnapshot {
  rows: VirtualItem[];
  totalSize: number;
}

/** Exposes immutable render data from TanStack's mutable core virtualizer. */
class VirtualRowsStore {
  private readonly virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  private readonly listeners = new Set<() => void>();
  private sourceRows: VirtualItem[];
  private snapshot: VirtualRowsSnapshot;

  constructor(options: VirtualRowsOptions) {
    this.virtualizer = new Virtualizer({
      ...options,
      observeElementRect,
      observeElementOffset,
      scrollToFn: elementScroll,
      onChange: this.publish,
    });
    this.sourceRows = this.virtualizer.getVirtualItems();
    this.snapshot = {
      rows: this.sourceRows.map((row) => ({ ...row })),
      totalSize: this.virtualizer.getTotalSize(),
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  private publish = () => {
    const rows = this.virtualizer.getVirtualItems();
    const totalSize = this.virtualizer.getTotalSize();
    if (rows === this.sourceRows && totalSize === this.snapshot.totalSize) return;
    this.sourceRows = rows;
    this.snapshot = { rows: rows.map((row) => ({ ...row })), totalSize };
    for (const listener of this.listeners) listener();
  };

  mount = () => this.virtualizer._didMount();

  updateOptions = (options: VirtualRowsOptions) => {
    this.virtualizer.setOptions({
      ...options,
      observeElementRect,
      observeElementOffset,
      scrollToFn: elementScroll,
      onChange: this.publish,
    });
    this.virtualizer._willUpdate();
    this.publish();
  };

  measureElement = (node: HTMLDivElement | null) => this.virtualizer.measureElement(node);
  measure = () => this.virtualizer.measure();
  scrollToOffset = (offset: number) => this.virtualizer.scrollToOffset(offset);
  scrollToIndex = (index: number) => this.virtualizer.scrollToIndex(index, { align: 'start' });
  getVirtualItems = () => this.virtualizer.getVirtualItems();
}

export function useVirtualRows(options: VirtualRowsOptions) {
  const [store] = useState(() => new VirtualRowsStore(options));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useLayoutEffect(() => store.mount(), [store]);
  useLayoutEffect(() => { store.updateOptions(options); }, [store, options]);

  return {
    ...snapshot,
    measureElement: store.measureElement,
    measure: store.measure,
    scrollToOffset: store.scrollToOffset,
    scrollToIndex: store.scrollToIndex,
    getVirtualItems: store.getVirtualItems,
  };
}
