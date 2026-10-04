import React, { useRef } from 'react';
import { Asset, AssetStack, ViewMode, CardZoom } from '../types';
import { AssetCard } from './AssetCard';
import { Sparkles, Layers, SearchX } from 'lucide-react';

interface AssetGridProps {
  items: (Asset | (AssetStack & { isStack: true }))[];
  selectedItem: Asset | (AssetStack & { isStack: true }) | null;
  onSelectItem: (item: Asset | (AssetStack & { isStack: true })) => void;
  viewMode: ViewMode;
  cardZoom: CardZoom;
  onQuickCopy: (item: Asset | (AssetStack & { isStack: true })) => void;
  loading?: boolean;
}

export function AssetGrid({
  items,
  selectedItem,
  onSelectItem,
  viewMode,
  cardZoom,
  onQuickCopy,
  loading = false,
}: AssetGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  if (items.length === 0 && !loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-slate-500">
        <div className="w-12 h-12 rounded-2xl bg-[#1b1b2c] border border-[#27273d] flex items-center justify-center mb-3">
          <SearchX className="w-6 h-6 text-slate-400" />
        </div>
        <h3 className="text-sm font-semibold text-slate-300">No assets found</h3>
        <p className="text-xs text-slate-500 mt-1 max-w-sm">
          No files match your current filters, category, or search term. Try resetting your search or triggering a library scan.
        </p>
      </div>
    );
  }

  // Grid column sizing based on cardZoom
  let gridCols = 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6';
  if (cardZoom === 'small') {
    gridCols = 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8';
  } else if (cardZoom === 'large') {
    gridCols = 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-4 select-none min-h-0 bg-[#12121e]"
    >
      {viewMode === 'list' ? (
        <div className="flex flex-col gap-1.5 max-w-5xl mx-auto">
          {items.map((item) => {
            const isSelected = selectedItem ? selectedItem.id === item.id : false;
            return (
              <AssetCard
                key={item.id}
                item={item}
                isSelected={isSelected}
                onSelect={() => onSelectItem(item)}
                viewMode="list"
                cardZoom={cardZoom}
                onQuickCopy={() => onQuickCopy(item)}
              />
            );
          })}
        </div>
      ) : (
        <div className={`grid gap-3 ${gridCols}`}>
          {items.map((item) => {
            const isSelected = selectedItem ? selectedItem.id === item.id : false;
            return (
              <AssetCard
                key={item.id}
                item={item}
                isSelected={isSelected}
                onSelect={() => onSelectItem(item)}
                viewMode="grid"
                cardZoom={cardZoom}
                onQuickCopy={() => onQuickCopy(item)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
