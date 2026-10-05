import React, { useState, useEffect, useCallback } from 'react';
import {
  Asset,
  AssetStack,
  AppSettings,
  TagInfo,
  FormatInfo,
  ResolutionInfo,
  BpmInfo,
  ScanProgressEvent,
  ViewMode,
  CardZoom,
  AssetListResponse,
  FilterType,
  parseFiltersFromQuery,
  updateSearchFilter,
} from './types';
import { ToastProvider, useToast } from './components/Toast';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { AssetGrid } from './components/AssetGrid';
import { Inspector } from './components/Inspector';
import { SettingsModal } from './components/SettingsModal';
import { CopyModal } from './components/CopyModal';
import { ClassifierModal } from './components/ClassifierModal';

function MainApp() {
  const { showToast } = useToast();

  // Navigation & Search State
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');

  // Active filters derived directly from search query - ensures 100% consistency with search bar!
  const activeFilters = React.useMemo(() => parseFiltersFromQuery(searchQuery), [searchQuery]);
  const selectedTag = activeFilters.tag;
  const selectedFormat = activeFilters.format;
  const selectedResolution = activeFilters.resolution;
  const selectedWidth = activeFilters.width;
  const selectedHeight = activeFilters.height;
  const selectedDuration = activeFilters.duration;
  const selectedBpm = activeFilters.bpm;

  // View & Sort State
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [isStackedView, setIsStackedView] = useState<boolean>(true);
  const [cardZoom, setCardZoom] = useState<CardZoom>('medium');
  const [sortBy, setSortBy] = useState<
    'name' | 'size' | 'mtime' | 'resolution' | 'duration' | 'bpm' | 'width' | 'height'
  >('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Selection & Inspector State
  const [selectedItem, setSelectedItem] = useState<Asset | (AssetStack & { isStack: true }) | null>(null);
  const [inspectorMode, setInspectorMode] = useState<'stack' | 'assets'>('stack');
  const [copyModalItem, setCopyModalItem] = useState<{
    asset?: Asset;
    stack?: AssetStack;
  } | null>(null);

  // Settings & Classifier Modal State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isClassifierModalOpen, setIsClassifierModalOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    libraryPath: '',
    libraryPaths: [],
    activeProjectPath: '',
    projectPaths: [],
    thumbnailQuality: 80,
    autoStackAnimations: true,
    autoStackAudio: true,
    defaultFps: 12,
  });

  // Data State
  const [items, setItems] = useState<(Asset | (AssetStack & { isStack: true }))[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [formats, setFormats] = useState<FormatInfo[]>([]);
  const [resolutions, setResolutions] = useState<ResolutionInfo[]>([]);
  const [bpms, setBpms] = useState<BpmInfo[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [summary, setSummary] = useState({
    totalAssets: 0,
    totalSize: 0,
    imageCount: 0,
    audioCount: 0,
    animationStackCount: 0,
    audioStackCount: 0,
  });
  const [loading, setLoading] = useState(false);

  // Scan SSE Status
  const [scanStatus, setScanStatus] = useState<ScanProgressEvent>({
    status: 'idle',
    libraryPath: '',
    scannedCount: 0,
    indexedCount: 0,
  });

  // Track active request ID to ignore stale responses
  const activeRequestIdRef = React.useRef(0);

  // Debounce search input (immediate on clear, 200ms debounce on type)
  useEffect(() => {
    if (!searchQuery.trim()) {
      setDebouncedSearch('');
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Handler to toggle, update, or remove a filter in the search bar
  const handleFilterChange = useCallback((filterType: FilterType, value: string | null) => {
    setSearchQuery((prev) => {
      const next = updateSearchFilter(prev, filterType, value);
      setDebouncedSearch(next); // Immediate response on filter clicks
      return next;
    });
  }, []);

  // Handler to toggle a filter: if already active, toggle off (null); otherwise set value
  const toggleOrSetFilter = useCallback(
    (filterType: FilterType, value: string | null) => {
      if (!value) {
        handleFilterChange(filterType, null);
        return;
      }
      const current = activeFilters[filterType];
      if (current && current.toLowerCase() === value.toLowerCase()) {
        handleFilterChange(filterType, null);
      } else {
        handleFilterChange(filterType, value);
      }
    },
    [activeFilters, handleFilterChange]
  );

  // Handler for tag selection (from Sidebar, Inspector, or chips)
  const handleSelectTag = useCallback(
    (tag: string | null) => {
      if (!tag) {
        handleFilterChange('tag', null);
        return;
      }
      const cleanTag = tag.replace(/^#/, '').trim();
      if (selectedTag && selectedTag.toLowerCase() === cleanTag.toLowerCase()) {
        handleFilterChange('tag', null);
      } else {
        handleFilterChange('tag', cleanTag);
      }
    },
    [handleFilterChange, selectedTag]
  );

  // Handler for category selection
  const handleSelectCategory = useCallback(
    (cat: string) => {
      setSelectedCategory(cat);
      if (cat === 'audio' || cat === 'audio_stack') {
        setSearchQuery((prev) => {
          let next = updateSearchFilter(prev, 'resolution', null);
          next = updateSearchFilter(next, 'width', null);
          next = updateSearchFilter(next, 'height', null);
          setDebouncedSearch(next);
          return next;
        });
      } else if (cat === 'image' || cat === 'animation_stack') {
        setSearchQuery((prev) => {
          let next = updateSearchFilter(prev, 'duration', null);
          next = updateSearchFilter(next, 'bpm', null);
          setDebouncedSearch(next);
          return next;
        });
      }
    },
    []
  );

  // Handler for search bar input changes
  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  // Load Settings
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => setSettings(data))
      .catch(() => {});
  }, []);

  // Fetch Tags, Formats & Resolutions
  const refreshFilters = useCallback(() => {
    fetch('/api/tags')
      .then((res) => res.json())
      .then((data) => setTags(data))
      .catch(() => {});

    fetch('/api/formats')
      .then((res) => res.json())
      .then((data) => setFormats(data))
      .catch(() => {});

    fetch('/api/resolutions')
      .then((res) => res.json())
      .then((data) => setResolutions(data))
      .catch(() => {});

    fetch('/api/bpms')
      .then((res) => res.json())
      .then((data) => setBpms(data))
      .catch(() => {});
  }, []);

  // Fetch Assets based on query
  const loadAssets = useCallback(async () => {
    const requestId = ++activeRequestIdRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();

      if (selectedCategory === 'image') params.append('category', 'image');
      if (selectedCategory === 'audio') params.append('category', 'audio');
      if (selectedCategory === 'animation_stack') params.append('stackType', 'animation');
      if (selectedCategory === 'audio_stack') params.append('stackType', 'audio_variation');

      if (debouncedSearch && debouncedSearch.trim()) {
        params.append('search', debouncedSearch.trim());
      }

      params.append('isStackedView', String(isStackedView));
      params.append('sortBy', sortBy);
      params.append('sortOrder', sortOrder);
      params.append('limit', '100');

      const res = await fetch(`/api/assets?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load assets');
      const data: AssetListResponse = await res.json();

      if (requestId !== activeRequestIdRef.current) return;

      setItems(data.items);
      setTotalCount(data.total);
      if (data.summary) {
        setSummary(data.summary);
      }
    } catch (err: any) {
      if (requestId === activeRequestIdRef.current) {
        console.error('Error fetching assets:', err);
      }
    } finally {
      if (requestId === activeRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [
    selectedCategory,
    debouncedSearch,
    isStackedView,
    sortBy,
    sortOrder,
  ]);

  useEffect(() => {
    loadAssets();
    refreshFilters();
  }, [loadAssets, refreshFilters]);

  // SSE Scanner Listener
  useEffect(() => {
    const sse = new EventSource('/api/scan/progress');

    sse.onmessage = (event) => {
      try {
        const payload: ScanProgressEvent = JSON.parse(event.data);
        setScanStatus(payload);

        if (payload.status === 'completed') {
          showToast('success', 'Library Scan Completed', payload.message);
          loadAssets();
          refreshFilters();
        } else if (payload.status === 'error') {
          showToast('error', 'Library Scan Error', payload.error || 'Scan failed');
        }
      } catch {
        // ignore
      }
    };

    return () => {
      sse.close();
    };
  }, [showToast, loadAssets, refreshFilters]);

  // Trigger Scan
  const handleTriggerScan = async () => {
    try {
      const res = await fetch('/api/scan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          libraryPath: settings.libraryPath,
          libraryPaths: settings.libraryPaths,
        }),
      });
      if (!res.ok) throw new Error('Could not start scan');
      const count = settings.libraryPaths?.length || 1;
      showToast(
        'info',
        'Scan Initiated',
        count > 1
          ? `Scanning ${count} asset source libraries...`
          : `Scanning directory: ${settings.libraryPath}`
      );
    } catch (err: any) {
      showToast('error', 'Scan Failed', err.message);
    }
  };

  // Keyboard shortcut Ctrl+K to search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const input = document.querySelector('input[placeholder*="Search"]') as HTMLInputElement;
        if (input) input.focus();
      }
      if (e.key === 'Escape') {
        setSelectedItem(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleQuickCopy = (item: Asset | (AssetStack & { isStack: true })) => {
    if ('isStack' in item && item.isStack) {
      setCopyModalItem({ stack: item as AssetStack });
    } else {
      setCopyModalItem({ asset: item as Asset });
    }
  };

  return (
    <div className="flex h-screen w-screen bg-[#141420] text-slate-100 overflow-hidden font-sans">
      {/* Left Sidebar */}
      <Sidebar
        selectedCategory={selectedCategory}
        onSelectCategory={handleSelectCategory}
        selectedTag={selectedTag}
        onSelectTag={handleSelectTag}
        selectedFormat={selectedFormat}
        onSelectFormat={(f) => handleFilterChange('format', f)}
        selectedResolution={selectedResolution}
        onSelectResolution={(r) => handleFilterChange('resolution', r)}
        selectedWidth={selectedWidth}
        onSelectWidth={(w) => handleFilterChange('width', w)}
        selectedHeight={selectedHeight}
        onSelectHeight={(h) => handleFilterChange('height', h)}
        selectedDuration={selectedDuration}
        onSelectDuration={(dur) => handleFilterChange('duration', dur)}
        selectedBpm={selectedBpm}
        onSelectBpm={(bpm) => handleFilterChange('bpm', bpm)}
        tags={tags}
        formats={formats}
        resolutions={resolutions}
        bpms={bpms}
        scanStatus={scanStatus}
        onTriggerScan={handleTriggerScan}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenClassifiers={() => setIsClassifierModalOpen(true)}
        settings={settings}
        summary={summary}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Top Bar */}
        <TopBar
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          isStackedView={isStackedView}
          onToggleStackedView={() => setIsStackedView(!isStackedView)}
          cardZoom={cardZoom}
          onCardZoomChange={setCardZoom}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSortChange={(b, o) => {
            setSortBy(b);
            setSortOrder(o);
          }}
          totalItems={totalCount}
          loading={loading}
        />

        {/* Gallery Grid */}
        <AssetGrid
          items={items}
          selectedItem={selectedItem}
          onSelectItem={(item, mode = 'stack') => {
            setSelectedItem(item);
            setInspectorMode(mode);
          }}
          onSelectAsset={(asset) => {
            setSelectedItem(asset);
          }}
          onViewStackAssets={(stack) => {
            setSelectedItem(stack);
            setInspectorMode('assets');
          }}
          viewMode={viewMode}
          cardZoom={cardZoom}
          onQuickCopy={handleQuickCopy}
          loading={loading}
          searchQuery={searchQuery}
          onClearSearch={() => handleSearchChange('')}
        />
      </div>

      {/* Right Inspector Panel */}
      {selectedItem && (
        <Inspector
          item={selectedItem}
          initialViewMode={inspectorMode}
          onClose={() => setSelectedItem(null)}
          settings={settings}
          onTagClick={handleSelectTag}
          selectedTag={selectedTag}
          onSelectStack={(stack) => {
            setSelectedItem(stack);
            setInspectorMode('stack');
          }}
          onSelectResolution={(r) => toggleOrSetFilter('resolution', r)}
          onSelectWidth={(w) => toggleOrSetFilter('width', w)}
          onSelectHeight={(h) => toggleOrSetFilter('height', h)}
          onSelectDuration={(dur) => toggleOrSetFilter('duration', dur)}
          onSelectBpm={(bpm) => toggleOrSetFilter('bpm', bpm)}
          onSelectSprite={(sprite) => toggleOrSetFilter('sprite', sprite)}
          onAssetUpdated={(updatedAsset) => {
            setSelectedItem(updatedAsset);
            loadAssets();
            refreshFilters();
          }}
        />
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSettingsSaved={(newSettings) => {
          setSettings(newSettings);
          loadAssets();
        }}
      />

      {/* Classifier Modal */}
      <ClassifierModal
        isOpen={isClassifierModalOpen}
        onClose={() => setIsClassifierModalOpen(false)}
        selectedAsset={
          selectedItem && !('isStack' in selectedItem && selectedItem.isStack)
            ? (selectedItem as Asset)
            : null
        }
        onRunComplete={() => {
          loadAssets();
          refreshFilters();
        }}
      />

      {/* Copy Modal */}
      {copyModalItem && (
        <CopyModal
          isOpen={Boolean(copyModalItem)}
          onClose={() => setCopyModalItem(null)}
          asset={copyModalItem.asset}
          stack={copyModalItem.stack}
          targetDir={settings.activeProjectPath}
          projectPaths={settings.projectPaths}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <MainApp />
    </ToastProvider>
  );
}
