import React, { useState, useEffect, useCallback } from 'react';
import {
  Asset,
  AssetStack,
  AppSettings,
  TagInfo,
  FormatInfo,
  ScanProgressEvent,
  ViewMode,
  CardZoom,
  AssetListResponse,
} from './types';
import { ToastProvider, useToast } from './components/Toast';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { AssetGrid } from './components/AssetGrid';
import { Inspector } from './components/Inspector';
import { SettingsModal } from './components/SettingsModal';
import { CopyModal } from './components/CopyModal';

function MainApp() {
  const { showToast } = useToast();

  // Navigation & Filter State
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');

  // View & Sort State
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [isStackedView, setIsStackedView] = useState<boolean>(true);
  const [cardZoom, setCardZoom] = useState<CardZoom>('medium');
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'mtime'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Selection & Inspector State
  const [selectedItem, setSelectedItem] = useState<Asset | (AssetStack & { isStack: true }) | null>(null);
  const [copyModalItem, setCopyModalItem] = useState<{
    asset?: Asset;
    stack?: AssetStack;
  } | null>(null);

  // Settings State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    libraryPath: '',
    activeProjectPath: '',
    thumbnailQuality: 80,
    autoStackAnimations: true,
    autoStackAudio: true,
    defaultFps: 12,
  });

  // Data State
  const [items, setItems] = useState<(Asset | (AssetStack & { isStack: true }))[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [formats, setFormats] = useState<FormatInfo[]>([]);
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

  // Load Settings
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => setSettings(data))
      .catch(() => {});
  }, []);

  // Fetch Tags & Formats
  const refreshFilters = useCallback(() => {
    fetch('/api/tags')
      .then((res) => res.json())
      .then((data) => setTags(data))
      .catch(() => {});

    fetch('/api/formats')
      .then((res) => res.json())
      .then((data) => setFormats(data))
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

      if (selectedTag) params.append('tag', selectedTag);
      if (selectedFormat) params.append('format', selectedFormat);
      if (debouncedSearch) params.append('search', debouncedSearch);

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
    selectedTag,
    selectedFormat,
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
        body: JSON.stringify({ libraryPath: settings.libraryPath }),
      });
      if (!res.ok) throw new Error('Could not start scan');
      showToast('info', 'Scan Initiated', `Scanning directory: ${settings.libraryPath}`);
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
        onSelectCategory={(cat) => {
          setSelectedCategory(cat);
          setSelectedTag(null);
        }}
        selectedTag={selectedTag}
        onSelectTag={(t) => setSelectedTag(t)}
        selectedFormat={selectedFormat}
        onSelectFormat={(f) => setSelectedFormat(f)}
        tags={tags}
        formats={formats}
        scanStatus={scanStatus}
        onTriggerScan={handleTriggerScan}
        onOpenSettings={() => setIsSettingsOpen(true)}
        settings={settings}
        summary={summary}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Top Bar */}
        <TopBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
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
          onSelectItem={(item) => setSelectedItem(item)}
          viewMode={viewMode}
          cardZoom={cardZoom}
          onQuickCopy={handleQuickCopy}
          loading={loading}
          searchQuery={searchQuery}
          onClearSearch={() => setSearchQuery('')}
        />
      </div>

      {/* Right Inspector Panel */}
      {selectedItem && (
        <Inspector
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          settings={settings}
          onTagClick={(tag) => setSelectedTag(tag)}
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

      {/* Copy Modal */}
      {copyModalItem && (
        <CopyModal
          isOpen={Boolean(copyModalItem)}
          onClose={() => setCopyModalItem(null)}
          asset={copyModalItem.asset}
          stack={copyModalItem.stack}
          targetDir={settings.activeProjectPath}
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
