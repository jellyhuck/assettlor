import React from 'react';
import { ViewMode, CardZoom } from '../types';
import {
  Search,
  X,
  LayoutGrid,
  List,
  Layers,
  ArrowUpDown,
  ZoomIn,
  Loader2,
} from 'lucide-react';

interface TopBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  isStackedView: boolean;
  onToggleStackedView: () => void;
  cardZoom: CardZoom;
  onCardZoomChange: (zoom: CardZoom) => void;
  sortBy: 'name' | 'size' | 'mtime';
  sortOrder: 'asc' | 'desc';
  onSortChange: (by: 'name' | 'size' | 'mtime', order: 'asc' | 'desc') => void;
  totalItems: number;
  loading?: boolean;
}

export function TopBar({
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  isStackedView,
  onToggleStackedView,
  cardZoom,
  onCardZoomChange,
  sortBy,
  sortOrder,
  onSortChange,
  totalItems,
  loading = false,
}: TopBarProps) {
  return (
    <header className="h-14 shrink-0 bg-[#151524] border-b border-[#242438] px-4 flex items-center justify-between gap-4 text-slate-300">
      {/* Search Bar */}
      <div className="relative flex-1 max-w-md">
        {loading ? (
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin absolute left-3 top-2.5" />
        ) : (
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
        )}
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (searchQuery) {
                e.stopPropagation();
                onSearchChange('');
              } else {
                (e.target as HTMLInputElement).blur();
              }
            }
          }}
          placeholder="Search assets, tags, or paths (e.g. knight, sfx, ui)..."
          className="w-full pl-9 pr-8 py-1.5 text-xs bg-[#12121d] border border-[#27273d] rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40 transition-colors"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            title="Clear search (Esc)"
            className="absolute right-2.5 top-2.5 text-slate-500 hover:text-slate-300 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Middle & Right Controls */}
      <div className="flex items-center gap-3">
        {/* Results Counter */}
        <span className="text-xs font-mono text-slate-400 hidden sm:inline-block">
          {totalItems} {searchQuery ? (totalItems === 1 ? 'match' : 'matches') : (totalItems === 1 ? 'item' : 'items')}
        </span>

        {/* Stack Toggle Button */}
        <button
          onClick={onToggleStackedView}
          title={isStackedView ? 'Stacked View (Grouping sequences) - Click for Flat' : 'Flat View (All files) - Click to Stack'}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer ${
            isStackedView
              ? 'bg-indigo-950/60 border-indigo-500/40 text-indigo-300'
              : 'bg-[#181828] border-[#292940] text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden md:inline">{isStackedView ? 'Stacked' : 'Flat'}</span>
        </button>

        {/* Zoom Slider / Controls */}
        <div className="hidden lg:flex items-center gap-1 bg-[#181828] border border-[#292940] rounded-lg p-1">
          <button
            onClick={() => onCardZoomChange('small')}
            title="Small Cards"
            className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
              cardZoom === 'small' ? 'bg-[#292944] text-white font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            S
          </button>
          <button
            onClick={() => onCardZoomChange('medium')}
            title="Medium Cards"
            className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
              cardZoom === 'medium' ? 'bg-[#292944] text-white font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            M
          </button>
          <button
            onClick={() => onCardZoomChange('large')}
            title="Large Cards"
            className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
              cardZoom === 'large' ? 'bg-[#292944] text-white font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            L
          </button>
        </div>

        {/* View Mode Toggle (Grid / List) */}
        <div className="flex items-center bg-[#181828] border border-[#292940] rounded-lg p-0.5">
          <button
            onClick={() => onViewModeChange('grid')}
            title="Grid View"
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              viewMode === 'grid' ? 'bg-[#27273e] text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onViewModeChange('list')}
            title="List View"
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              viewMode === 'list' ? 'bg-[#27273e] text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <List className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Sort Select */}
        <div className="flex items-center gap-1.5 bg-[#181828] border border-[#292940] rounded-lg px-2.5 py-1 text-xs">
          <ArrowUpDown className="w-3 h-3 text-slate-400" />
          <select
            value={`${sortBy}_${sortOrder}`}
            onChange={(e) => {
              const [b, o] = e.target.value.split('_') as [any, any];
              onSortChange(b, o);
            }}
            className="bg-transparent text-slate-200 focus:outline-hidden cursor-pointer"
          >
            <option value="name_asc" className="bg-[#181828]">Name (A-Z)</option>
            <option value="name_desc" className="bg-[#181828]">Name (Z-A)</option>
            <option value="size_desc" className="bg-[#181828]">Size (Largest)</option>
            <option value="size_asc" className="bg-[#181828]">Size (Smallest)</option>
            <option value="mtime_desc" className="bg-[#181828]">Date (Newest)</option>
            <option value="mtime_asc" className="bg-[#181828]">Date (Oldest)</option>
          </select>
        </div>
      </div>
    </header>
  );
}
