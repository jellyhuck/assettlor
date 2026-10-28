import { useState, useRef, useEffect } from 'react';
import { ViewMode, CardZoom } from '../types';
import {
  Search,
  X,
  LayoutGrid,
  List,
  Layers,
  ArrowUpDown,
  Loader2,
  HelpCircle,
} from 'lucide-react';

type SortBy = 'name' | 'size' | 'mtime' | 'resolution' | 'duration' | 'bpm' | 'width' | 'height';
type SortOrder = 'asc' | 'desc';

const sortOptions: { by: SortBy; order: SortOrder; label: string }[] = [
  { by: 'name', order: 'asc', label: 'Name (A-Z)' },
  { by: 'name', order: 'desc', label: 'Name (Z-A)' },
  { by: 'size', order: 'desc', label: 'Size (Largest)' },
  { by: 'size', order: 'asc', label: 'Size (Smallest)' },
  { by: 'resolution', order: 'desc', label: 'Resolution (Highest)' },
  { by: 'resolution', order: 'asc', label: 'Resolution (Lowest)' },
  { by: 'width', order: 'desc', label: 'Width (Widest)' },
  { by: 'width', order: 'asc', label: 'Width (Narrowest)' },
  { by: 'height', order: 'desc', label: 'Height (Tallest)' },
  { by: 'height', order: 'asc', label: 'Height (Shortest)' },
  { by: 'duration', order: 'desc', label: 'Duration (Longest)' },
  { by: 'duration', order: 'asc', label: 'Duration (Shortest)' },
  { by: 'bpm', order: 'desc', label: 'BPM (Fastest)' },
  { by: 'bpm', order: 'asc', label: 'BPM (Slowest)' },
  { by: 'mtime', order: 'desc', label: 'Date (Newest)' },
  { by: 'mtime', order: 'asc', label: 'Date (Oldest)' },
];

interface TopBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  isStackedView: boolean;
  onToggleStackedView: () => void;
  cardZoom: CardZoom;
  onCardZoomChange: (zoom: CardZoom) => void;
  sortBy: SortBy;
  sortOrder: SortOrder;
  onSortChange: (by: SortBy, order: SortOrder) => void;
  totalItems: number;
  loadedItems?: number;
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
  loadedItems,
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
    <header className="min-h-14 shrink-0 bg-[#151524] border-b border-[#242438] px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-slate-300">
      {/* Search Bar */}
      <div
        ref={helpRef}
        className="relative w-full min-w-0 sm:w-auto sm:min-w-48 sm:flex-1 sm:max-w-md"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && showHelp) {
            event.stopPropagation();
            setShowHelp(false);
          }
        }}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin absolute left-3 top-2.5" />
        ) : (
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
        )}
        <input
          type="text"
          aria-label="Search assets"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              if (showHelp) {
                setShowHelp(false);
              } else if (searchQuery) {
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
              type="button"
              onClick={() => onSearchChange('')}
              title="Clear search (Esc)"
              aria-label="Clear search"
              className="text-slate-500 hover:text-slate-300 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowHelp((prev) => !prev)}
            title="Search filter syntax guide"
            aria-label="Search filter syntax guide"
            aria-expanded={showHelp}
            aria-controls="search-filter-help"
            className={`p-0.5 rounded cursor-pointer transition-colors ${
              showHelp ? 'text-indigo-400 bg-indigo-950/60' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Floating Syntax Help Popover */}
        {showHelp && (
          <div id="search-filter-help" role="region" aria-label="Search filter syntax" className="absolute left-0 top-full mt-2 w-[min(20rem,calc(100vw-2rem))] bg-[#161626] border border-[#2c2c44] rounded-xl shadow-2xl p-3.5 z-50 text-xs max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-[#242438] mb-2.5">
              <span className="font-semibold text-slate-200">Search Filter Syntax</span>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                aria-label="Close search filter guide"
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
                  {['tag:coin', 'ext:png', 'cat:image', 'type:audio', 'is:model'].map((sample) => (
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
                <div className="text-slate-300 font-medium mb-1">Image Dimensions & Resolution:</div>
                <div className="flex flex-wrap gap-1">
                  {['res:64x64', 'width:>128', 'height:<=64', 'width:[64 TO 512]', 'res:square', 'res:1080p', 'w:tiny'].map((sample) => (
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
                <div className="text-slate-300 font-medium mb-1">Audio BPM & Duration:</div>
                <div className="flex flex-wrap gap-1">
                  {['bpm:120', 'bpm:>120', 'bpm:[80 TO 140]', 'bpm:fast', 'dur:>5s', 'dur:<30s', 'dur:[5s TO 1m]', 'dur:music'].map((sample) => (
                    <button
                      key={sample}
                      onClick={() => handleAddFilter(sample)}
                      className="px-1.5 py-0.5 rounded bg-[#1e1e34] hover:bg-pink-900/50 hover:text-pink-200 text-pink-300 font-mono text-[10px] border border-[#2b2b48] cursor-pointer"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-slate-300 font-medium mb-1">Sprite Archetypes:</div>
                <div className="flex flex-wrap gap-1">
                  {['sprite:character', 'sprite:object', 'sprite:texture', 'sprite:background', 'sprite:unclassified'].map((sample) => (
                    <button
                      key={sample}
                      onClick={() => handleAddFilter(sample)}
                      className="px-1.5 py-0.5 rounded bg-[#1e1e34] hover:bg-purple-900/50 hover:text-purple-200 text-purple-300 font-mono text-[10px] border border-[#2b2b48] cursor-pointer"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-slate-300 font-medium mb-1">Flags & Location:</div>
                <div className="flex flex-wrap gap-1">
                  {['is:archive', 'is:disk', 'in:images', 'path:logo', 'folder:coins', 'folder:none'].map((sample) => (
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
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:gap-3">
        {/* Results Counter */}
        <span role="status" aria-live="polite" className="text-xs font-mono text-slate-400 sr-only sm:not-sr-only">
          {loadedItems !== undefined && loadedItems < totalItems ? `${loadedItems} of ` : ''}{totalItems} {searchQuery ? (totalItems === 1 ? 'match' : 'matches') : (totalItems === 1 ? 'item' : 'items')}
        </span>

        {/* Stack Toggle Button */}
        <button
          type="button"
          onClick={onToggleStackedView}
          title={isStackedView ? 'Stacked View (Grouping sequences) - Click for Flat' : 'Flat View (All files) - Click to Stack'}
          aria-label={isStackedView ? 'Show all files in flat view' : 'Group files into stacks'}
          aria-pressed={isStackedView}
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
            type="button"
            onClick={() => onCardZoomChange('small')}
            title="Small Cards"
            aria-label="Small cards"
            aria-pressed={cardZoom === 'small'}
            className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
              cardZoom === 'small' ? 'bg-[#292944] text-white font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            S
          </button>
          <button
            type="button"
            onClick={() => onCardZoomChange('medium')}
            title="Medium Cards"
            aria-label="Medium cards"
            aria-pressed={cardZoom === 'medium'}
            className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
              cardZoom === 'medium' ? 'bg-[#292944] text-white font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            M
          </button>
          <button
            type="button"
            onClick={() => onCardZoomChange('large')}
            title="Large Cards"
            aria-label="Large cards"
            aria-pressed={cardZoom === 'large'}
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
            type="button"
            onClick={() => onViewModeChange('grid')}
            title="Grid View"
            aria-label="Grid view"
            aria-pressed={viewMode === 'grid'}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              viewMode === 'grid' ? 'bg-[#27273e] text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange('list')}
            title="List View"
            aria-label="List view"
            aria-pressed={viewMode === 'list'}
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
            aria-label="Sort assets"
            value={`${sortBy}_${sortOrder}`}
            onChange={(e) => {
              const option = sortOptions.find(({ by, order }) => `${by}_${order}` === e.currentTarget.value);
              if (option) onSortChange(option.by, option.order);
            }}
            className="bg-transparent text-slate-200 focus:outline-hidden cursor-pointer"
          >
            {sortOptions.map((option) => (
              <option key={`${option.by}_${option.order}`} value={`${option.by}_${option.order}`} className="bg-[#181828]">
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </header>
  );
}
