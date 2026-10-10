import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { defaultRangeExtractor } from '@tanstack/react-virtual';
import { Asset, AssetStack, ViewMode, CardZoom } from '../types';
import { AssetCard } from './AssetCard';
import { SearchX, Loader2 } from 'lucide-react';
import { useVirtualRows } from './useVirtualRows';

type GridItem = Asset | (AssetStack & { isStack: true });

interface AssetGridProps {
  items: GridItem[];
  selectedItem: GridItem | null;
  onSelectItem: (item: GridItem, mode?: 'stack' | 'assets') => void;
  viewMode: ViewMode;
  cardZoom: CardZoom;
  onQuickCopy: (item: GridItem) => void;
  loading?: boolean;
  searchQuery?: string;
  onClearSearch?: () => void;
  onSelectAsset?: (asset: Asset) => void;
  onViewStackAssets?: (stack: AssetStack & { isStack: true }) => void;
  /** Changes only when the catalog query changes, not when a page is appended. */
  queryKey?: string | number;
}

const GRID_GAP = 12;
const LIST_GAP = 6;

function getColumnCount(width: number, zoom: CardZoom): number {
  const minWidth = zoom === 'small' ? 128 : zoom === 'large' ? 232 : 176;
  const maxColumns = zoom === 'small' ? 8 : zoom === 'large' ? 5 : 6;
  return Math.min(maxColumns, Math.max(1, Math.floor((width + GRID_GAP) / (minWidth + GRID_GAP))));
}

function estimatedRowHeight(viewMode: ViewMode, zoom: CardZoom): number {
  if (viewMode === 'list') return 62;
  return (zoom === 'small' ? 191 : zoom === 'large' ? 271 : 223) + GRID_GAP;
}

export function AssetGrid({
  items,
  selectedItem,
  onSelectItem,
  viewMode,
  cardZoom,
  onQuickCopy,
  loading = false,
  searchQuery = '',
  onClearSearch,
  onSelectAsset,
  onViewStackAssets,
  queryKey,
}: AssetGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const columns = viewMode === 'list' ? 1 : getColumnCount(containerWidth, cardZoom);
  const rowCount = Math.ceil(items.length / columns);
  const focusedItemIndex = focusedItemId === null
    ? -1
    : items.findIndex((item) => item.id === focusedItemId);
  const focusedRowIndex = focusedItemIndex < 0 ? -1 : Math.floor(focusedItemIndex / columns);
  const activeQueryKey = queryKey ?? searchQuery;
  const isEmpty = items.length === 0;
  const visibleItemIndexRef = useRef(0);
  const getScrollElement = useCallback(() => containerRef.current, []);
  const getItemKey = useCallback(
    (index: number) => `${viewMode}:${cardZoom}:${columns}:${items[index * columns]?.id ?? index}`,
    [viewMode, cardZoom, columns, items],
  );
  const estimateSize = useCallback(() => estimatedRowHeight(viewMode, cardZoom), [viewMode, cardZoom]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const rows = defaultRangeExtractor(range);
    if (focusedRowIndex >= 0 && !rows.includes(focusedRowIndex)) {
      rows.push(focusedRowIndex);
      rows.sort((a, b) => a - b);
    }
    return rows;
  }, [focusedRowIndex]);

  const virtualOptions = useMemo(() => ({
    count: rowCount,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan: 3,
    // A focused action must remain mounted while the user scrolls elsewhere.
    rangeExtractor,
    initialRect: { width: 0, height: 600 },
  }), [rowCount, getScrollElement, estimateSize, getItemKey, rangeExtractor]);
  const {
    rows,
    totalSize,
    measureElement,
    measure,
    scrollToOffset,
    scrollToIndex,
    getVirtualItems,
  } = useVirtualRows(virtualOptions);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    if (typeof ResizeObserver === 'undefined') {
      const updateWidth = () => setContainerWidth(Math.max(0, element.clientWidth - 32));
      window.addEventListener('resize', updateWidth);
      const frame = requestAnimationFrame(updateWidth);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', updateWidth);
      };
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isEmpty]);

  const previousLayoutRef = useRef({ activeQueryKey, columns, viewMode, cardZoom });
  useLayoutEffect(() => {
    const previous = previousLayoutRef.current;
    if (previous.activeQueryKey !== activeQueryKey) {
      visibleItemIndexRef.current = 0;
      scrollToOffset(0);
    } else if (
      previous.columns !== columns ||
      previous.viewMode !== viewMode ||
      previous.cardZoom !== cardZoom
    ) {
      // Keep the first visible asset in view when zoom or inspector width changes.
      measure();
      scrollToIndex(Math.floor(visibleItemIndexRef.current / columns));
    }
    previousLayoutRef.current = { activeQueryKey, columns, viewMode, cardZoom };
  }, [activeQueryKey, columns, viewMode, cardZoom, measure, scrollToIndex, scrollToOffset]);

  const handleScroll = () => {
    const scrollTop = containerRef.current?.scrollTop ?? 0;
    const firstVisible = getVirtualItems().find((row) => row.end > scrollTop);
    if (firstVisible) visibleItemIndexRef.current = firstVisible.index * columns;
  };

  const getFocusedId = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>('[data-virtual-item-id]')?.dataset.virtualItemId ?? null;
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    setFocusedItemId(getFocusedId(event.relatedTarget));
  };

  if (isEmpty) {
    if (loading) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-slate-500">
          <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-3" />
          <h3 className="text-sm font-semibold text-slate-300">Searching assets...</h3>
          <p className="text-xs text-slate-500 mt-1">Filtering asset library</p>
        </div>
      );
    }
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-slate-500">
        <div className="w-12 h-12 rounded-2xl bg-[#1b1b2c] border border-[#27273d] flex items-center justify-center mb-3">
          <SearchX className="w-6 h-6 text-slate-400" />
        </div>
        <h3 className="text-sm font-semibold text-slate-300">No assets found</h3>
        <p className="text-xs text-slate-500 mt-1 max-w-sm">
          {searchQuery
            ? `No assets match "${searchQuery}". Check for typos or try searching by category or tags.`
            : 'No files match your current filters or category. Try resetting your search or triggering a library scan.'}
        </p>
        {searchQuery && onClearSearch && (
          <button
            onClick={onClearSearch}
            className="mt-4 px-3 py-1.5 text-xs font-medium bg-[#202033] hover:bg-indigo-600 hover:text-white text-slate-300 border border-[#2f2f48] rounded-lg transition-colors cursor-pointer"
          >
            Clear search
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-4 select-none min-h-0 bg-[#12121e]"
      onScroll={handleScroll}
      onFocusCapture={(event) => setFocusedItemId(getFocusedId(event.target))}
      onBlurCapture={handleBlur}
    >
      <div className={viewMode === 'list' ? 'relative max-w-5xl mx-auto' : 'relative'}
        style={{ height: totalSize }}>
        {rows.map((row) => (
          <div
            key={row.key}
            ref={measureElement}
            data-index={row.index}
            data-virtual-row=""
            className="absolute top-0 left-0 w-full"
            style={{
              transform: `translateY(${row.start}px)`,
              paddingBottom: viewMode === 'list' ? LIST_GAP : GRID_GAP,
              display: viewMode === 'list' ? 'flex' : 'grid',
              flexDirection: viewMode === 'list' ? 'column' : undefined,
              gridTemplateColumns: viewMode === 'grid' ? `repeat(${columns}, minmax(0, 1fr))` : undefined,
              gap: viewMode === 'grid' ? GRID_GAP : undefined,
            }}
          >
            {items.slice(row.index * columns, (row.index + 1) * columns).map((item) => (
              <div key={item.id} data-virtual-item-id={item.id} className="min-w-0">
                <AssetCard
                  item={item}
                  isSelected={selectedItem?.id === item.id}
                  onSelect={() => onSelectItem(item)}
                  viewMode={viewMode}
                  cardZoom={cardZoom}
                  onQuickCopy={() => onQuickCopy(item)}
                  onSelectAsset={onSelectAsset}
                  onViewStackAssets={() => {
                    if ('isStack' in item && item.isStack) {
                      if (onViewStackAssets) onViewStackAssets(item);
                      else onSelectItem(item, 'assets');
                    }
                  }}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
