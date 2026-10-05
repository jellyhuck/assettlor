import React, { useState, useRef, useEffect } from 'react';
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
  HelpCircle,
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
  const [showHelp, setShowHelp] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (helpRef.current && !helpRef.current.contains(event.target as Node)) {
        setShowHelp(false);
      }
    }
    if (showHelp) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showHelp]);

  const handleAddFilter = (snippet: string) => {
    const trimmed = searchQuery.trim();
    const next = trimmed ? `${trimmed} ${snippet}` : snippet;
    onSearchChange(next);
    setShowHelp(false);
  };

  return (
    <header className="h-14 shrink-0 bg-[#151524] border-b border-[#242438] px-4 flex items-center justify-between gap-4 text-slate-300">
      {/* Search Bar */}
      <div ref={helpRef} className="relative flex-1 max-w-md">
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
              if (showHelp) {
                setShowHelp(false);
              } else if (searchQuery) {
                e.stopPropagation();
                onSearchChange('');
              } else {
                (e.target as HTMLInputElement).blur();
              }
            }
          }}
          placeholder="Search assets (e.g. tag:coin, size:<2MB, ext:png, is:archive)..."
          className="w-full pl-9 pr-16 py-1.5 text-xs bg-[#12121d] border border-[#27273d] rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40 transition-colors"
        />

        {/* Action icons inside Search Bar */}
        <div className="absolute right-2 top-2 flex items-center gap-1.5">
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              title="Clear search (Esc)"
              className="text-slate-500 hover:text-slate-300 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => setShowHelp((prev) => !prev)}
            title="Search filter syntax guide"
            className={`p-0.5 rounded cursor-pointer transition-colors ${
              showHelp ? 'text-indigo-400 bg-indigo-950/60' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Floating Syntax Help Popover */}
        {showHelp && (
          <div className="absolute left-0 top-full mt-2 w-80 bg-[#161626] border border-[#2c2c44] rounded-xl shadow-2xl p-3.5 z-50 text-xs">
            <div className="flex items-center justify-between pb-2 border-b border-[#242438] mb-2.5">
              <span className="font-semibold text-slate-200">Search Filter Syntax</span>
              <button
                onClick={() => setShowHelp(false)}
                className="text-slate-500 hover:text-slate-300 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="space-y-2.5 text-[11px] text-slate-400">
              <div>
                <div className="text-slate-300 font-medium mb-1">File Size:</div>
                <div className="flex flex-wrap gap-1">
                  {['size:<2MB', 'size:>500KB', 'size:[100KB TO 2MB]'].map((sample) => (
                    <button
                      key={sample}
                      onClick={() => handleAddFilter(sample)}
                      className="px-1.5 py-0.5 rounded bg-[#1e1e34] hover:bg-indigo-900/50 hover:text-indigo-200 text-indigo-300 font-mono text-[10px] border border-[#2b2b48] cursor-pointer"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-slate-300 font-medium mb-1">Tags & Formats:</div>
                <div className="flex flex-wrap gap-1">
                  {['tag:coin', 'ext:png', 'cat:image', 'type:audio'].map((sample) => (
                    <button
                      key={sample}
                      onClick={() => handleAddFilter(sample)}
                      className="px-1.5 py-0.5 rounded bg-[#1e1e34] hover:bg-indigo-900/50 hover:text-indigo-200 text-indigo-300 font-mono text-[10px] border border-[#2b2b48] cursor-pointer"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-slate-300 font-medium mb-1">Boolean & Negation:</div>
                <div className="flex flex-wrap gap-1">
                  {['tag:coin OR tag:gem', 'NOT ext:wav', '-tag:ui'].map((sample) => (
                    <button
                      key={sample}
                      onClick={() => handleAddFilter(sample)}
                      className="px-1.5 py-0.5 rounded bg-[#1e1e34] hover:bg-indigo-900/50 hover:text-indigo-200 text-indigo-300 font-mono text-[10px] border border-[#2b2b48] cursor-pointer"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-slate-300 font-medium mb-1">Flags & Metadata:</div>
                <div className="flex flex-wrap gap-1">
                  {['is:archive', 'is:disk', 'width:>128', 'dur:>5s'].map((sample) => (
                    <button
                      key={sample}
                      onClick={() => handleAddFilter(sample)}
                      className="px-1.5 py-0.5 rounded bg-[#1e1e34] hover:bg-indigo-900/50 hover:text-indigo-200 text-indigo-300 font-mono text-[10px] border border-[#2b2b48] cursor-pointer"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
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
