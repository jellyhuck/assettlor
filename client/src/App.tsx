import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { createRequestGate, errorMessage, isAbortError, requestJson } from './lib/requestLifecycle';

type CatalogItem = Asset | (AssetStack & { isStack: true });
type CatalogPhase = 'loading' | 'ready' | 'error';
type CatalogState = {
  key: string;
  items: CatalogItem[];
  total: number;
  totalPages: number;
  nextPage: number | null;
  phase: CatalogPhase;
  pageError: string | null;
  revision: number;
  refresh: number;
};

const emptySummary = {
  totalAssets: 0,
  totalSize: 0,
  imageCount: 0,
  audioCount: 0,
  animationStackCount: 0,
  audioStackCount: 0,
};

const defaultSettings: AppSettings = {
  libraryPath: '',
  libraryPaths: [],
  activeProjectPath: '',
  projectPaths: [],
  thumbnailQuality: 80,
  autoStackAnimations: true,
  autoStackAudio: true,
  defaultFps: 12,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireList<T>(value: unknown, label: string, valid: (item: unknown) => item is T): T[] {
  if (!Array.isArray(value) || !value.every(valid)) {
    throw new Error(`The server returned invalid ${label}`);
  }
  return value;
}

function isAsset(value: unknown): value is Asset {
  if (!isRecord(value) || !isRecord(value.metadata)) return false;
  const metadata = value.metadata;
  return ['id', 'name', 'path', 'extension', 'fileUrl', 'thumbnailUrl'].every(
    (key) => typeof value[key] === 'string')
    && ['image', 'audio', 'archive', 'other'].includes(String(value.category))
    && typeof value.size === 'number' && Number.isFinite(value.size)
    && typeof value.isArchiveEntry === 'boolean'
    && Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string')
    && ['width', 'height', 'duration', 'bpm'].every((key) =>
      metadata[key] === undefined || typeof metadata[key] === 'number');
}

function isCatalogItem(value: unknown): value is CatalogItem {
  return isRecord(value) && (value.isStack === true
    ? typeof value.id === 'string' && typeof value.name === 'string'
      && typeof value.itemCount === 'number' && isAsset(value.representativeAsset)
      && Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string')
    : isAsset(value));
}

function parseCatalog(value: unknown): AssetListResponse {
  if (!isRecord(value) || !Number.isSafeInteger(value.page) || Number(value.page) < 1
    || !Number.isSafeInteger(value.limit) || Number(value.limit) < 1
    || !Number.isSafeInteger(value.total) || Number(value.total) < 0
    || !Number.isSafeInteger(value.totalPages) || Number(value.totalPages) < 1
    || !isRecord(value.summary)) {
    throw new Error('The server returned an invalid asset catalog');
  }
  const items = requireList(value.items, 'asset catalog', isCatalogItem);
  const summary = value.summary;
  if (!['totalAssets', 'totalSize', 'imageCount', 'audioCount',
    'animationStackCount', 'audioStackCount'].every((key) => typeof summary[key] === 'number')) {
    throw new Error('The server returned invalid catalog totals');
  }
  return value as unknown as AssetListResponse & { items: typeof items };
}

function parseSettings(value: unknown): AppSettings {
  if (!isRecord(value) || typeof value.libraryPath !== 'string'
    || !Array.isArray(value.libraryPaths) || !value.libraryPaths.every((path) => typeof path === 'string')
    || typeof value.activeProjectPath !== 'string'
    || !Array.isArray(value.projectPaths) || !value.projectPaths.every((path) => typeof path === 'string')
    || typeof value.thumbnailQuality !== 'number' || !Number.isFinite(value.thumbnailQuality)
    || typeof value.defaultFps !== 'number' || !Number.isFinite(value.defaultFps)
    || typeof value.autoStackAnimations !== 'boolean' || typeof value.autoStackAudio !== 'boolean') {
    throw new Error('The server returned invalid settings');
  }
  return value as unknown as AppSettings;
}

function catalogIdentity(item: CatalogItem): string {
  return `${'isStack' in item && item.isStack ? 'stack' : 'asset'}:${item.id}`;
}

function uniqueItems(items: CatalogItem[]): CatalogItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = catalogIdentity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseDetail(value: unknown, isStack: boolean): CatalogItem {
  const item = isStack && isRecord(value) ? { ...value, isStack: true } : value;
  if (!isCatalogItem(item)) {
    throw new Error('The server returned invalid asset details');
  }
  return item;
}

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
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);
  const [inspectorMode, setInspectorMode] = useState<'stack' | 'assets'>('stack');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [copyModalItem, setCopyModalItem] = useState<{
    asset?: Asset;
    stack?: AssetStack;
  } | null>(null);

  // Settings & Classifier Modal State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isClassifierModalOpen, setIsClassifierModalOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsRefresh, setSettingsRefresh] = useState(0);

  // Data State
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [formats, setFormats] = useState<FormatInfo[]>([]);
  const [resolutions, setResolutions] = useState<ResolutionInfo[]>([]);
  const [bpms, setBpms] = useState<BpmInfo[]>([]);
  const [summary, setSummary] = useState(emptySummary);
  const [facetsError, setFacetsError] = useState<string | null>(null);
  const [facetsLoading, setFacetsLoading] = useState(false);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [loadingPage, setLoadingPage] = useState<{ key: string; page: number } | null>(null);
  const [catalog, setCatalog] = useState<CatalogState>({
    key: '', items: [], total: 0, totalPages: 1, nextPage: null,
    phase: 'loading', pageError: null, revision: 0, refresh: 0,
  });

  // Scan SSE Status
  const [scanStatus, setScanStatus] = useState<ScanProgressEvent>({
    status: 'idle',
    libraryPath: '',
    scannedCount: 0,
    indexedCount: 0,
  });
  const [scanConnection, setScanConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [scanActionPending, setScanActionPending] = useState<'start' | 'cancel' | null>(null);

  const catalogGate = useRef(createRequestGate());
  const facetsGate = useRef(createRequestGate());
  const settingsGate = useRef(createRequestGate());
  const detailGate = useRef(createRequestGate());
  const selectedIdentityRef = useRef<string | null>(null);
  const scanStatusRef = useRef(scanStatus);
  const scanActionRef = useRef<'start' | 'cancel' | null>(null);
  const observedScansRef = useRef(new Set<number>());
  const notifiedScansRef = useRef(new Set<number>());

  const queryKey = useMemo(() => JSON.stringify({
    selectedCategory, debouncedSearch: debouncedSearch.trim(),
    isStackedView, sortBy, sortOrder,
  }), [selectedCategory, debouncedSearch, isStackedView, sortBy, sortOrder]);
  const queryKeyRef = useRef(queryKey);
  useEffect(() => { queryKeyRef.current = queryKey; }, [queryKey]);
  useEffect(() => { scanStatusRef.current = scanStatus; }, [scanStatus]);
  useEffect(() => {
    selectedIdentityRef.current = selectedItem ? catalogIdentity(selectedItem) : null;
  }, [selectedItem]);
  const currentCatalog = catalog.key === queryKey ? catalog : null;
  const items = currentCatalog?.items ?? [];
  const totalCount = currentCatalog?.total ?? 0;
  const loading = !currentCatalog || currentCatalog.refresh !== catalogRefresh
    || currentCatalog.phase === 'loading'
    || searchQuery.trim() !== debouncedSearch.trim();
  const pageLoading = loadingPage?.key === queryKey && loadingPage.page === currentCatalog?.nextPage;
  const selectedKey = selectedItem ? catalogIdentity(selectedItem) : null;

  // Debounce search input (immediate on clear, 200ms debounce on type)
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Handler to toggle, update, or remove a filter in the search bar
  const handleFilterChange = useCallback((filterType: FilterType, value: string | null) => {
    const next = updateSearchFilter(searchQuery, filterType, value);
    setSearchQuery(next);
    setDebouncedSearch(next);
  }, [searchQuery]);

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
        let next = updateSearchFilter(searchQuery, 'resolution', null);
        next = updateSearchFilter(next, 'width', null);
        next = updateSearchFilter(next, 'height', null);
        setSearchQuery(next);
        setDebouncedSearch(next);
      } else if (cat === 'image' || cat === 'animation_stack') {
        let next = updateSearchFilter(searchQuery, 'duration', null);
        next = updateSearchFilter(next, 'bpm', null);
        setSearchQuery(next);
        setDebouncedSearch(next);
      }
    },
    [searchQuery]
  );

  // Handler for search bar input changes
  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    if (!query.trim()) setDebouncedSearch('');
  }, []);

  useEffect(() => {
    const gate = settingsGate.current;
    const request = gate.begin();
    requestJson('/api/settings', parseSettings, { signal: request.signal })
      .then((value) => {
        if (request.isCurrent()) {
          setSettings(value);
          setSettingsError(null);
        }
      })
      .catch((error: unknown) => {
        if (request.isCurrent() && !isAbortError(error)) setSettingsError(errorMessage(error));
      });
    return () => gate.invalidate();
  }, [settingsRefresh]);

  const refreshFilters = useCallback(() => {
    const request = facetsGate.current.begin();
    setFacetsLoading(true);
    const isTag = (value: unknown): value is TagInfo => isRecord(value)
      && typeof value.name === 'string' && typeof value.count === 'number';
    const isFormat = (value: unknown): value is FormatInfo => isRecord(value)
      && typeof value.extension === 'string' && typeof value.count === 'number';
    const isResolution = (value: unknown): value is ResolutionInfo => isRecord(value)
      && typeof value.width === 'number' && typeof value.height === 'number'
      && typeof value.formatted === 'string' && typeof value.count === 'number';
    const isBpm = (value: unknown): value is BpmInfo => isRecord(value)
      && typeof value.bpm === 'number' && typeof value.formatted === 'string'
      && typeof value.count === 'number';
    Promise.all([
      requestJson('/api/tags', (value) => requireList(value, 'tags', isTag), { signal: request.signal }),
      requestJson('/api/formats', (value) => requireList(value, 'formats', isFormat), { signal: request.signal }),
      requestJson('/api/resolutions', (value) => requireList(value, 'resolutions', isResolution), { signal: request.signal }),
      requestJson('/api/bpms', (value) => requireList(value, 'BPM facets', isBpm), { signal: request.signal }),
    ]).then(([nextTags, nextFormats, nextResolutions, nextBpms]) => {
      if (!request.isCurrent()) return;
      setTags(nextTags);
      setFormats(nextFormats);
      setResolutions(nextResolutions);
      setBpms(nextBpms);
      setFacetsError(null);
    }).catch((error: unknown) => {
      if (request.isCurrent() && !isAbortError(error)) setFacetsError(errorMessage(error));
    }).finally(() => {
      if (request.isCurrent()) setFacetsLoading(false);
    });
  }, []);

  useEffect(() => {
    const gate = facetsGate.current;
    let active = true;
    queueMicrotask(() => { if (active) refreshFilters(); });
    return () => {
      active = false;
      gate.invalidate();
    };
  }, [refreshFilters]);

  const refreshCatalog = useCallback(() => setCatalogRefresh((revision) => revision + 1), []);

  useEffect(() => {
    const gate = catalogGate.current;
    const request = gate.begin(queryKey);

    const params = new URLSearchParams();
    if (selectedCategory === 'image') params.set('category', 'image');
    if (selectedCategory === 'audio') params.set('category', 'audio');
    if (selectedCategory === 'animation_stack') params.set('stackType', 'animation');
    if (selectedCategory === 'audio_stack') params.set('stackType', 'audio_variation');
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    params.set('isStackedView', String(isStackedView));
    params.set('sortBy', sortBy);
    params.set('sortOrder', sortOrder);
    params.set('page', '1');
    params.set('limit', '100');

    requestJson(`/api/assets?${params.toString()}`, parseCatalog, { signal: request.signal })
      .then((data) => {
        if (!request.isCurrent(queryKeyRef.current)) return;
        if (data.page !== 1) throw new Error('The server returned the wrong catalog page');
        setCatalog((previous) => ({
          key: queryKey,
          items: uniqueItems(data.items),
          total: data.total,
          totalPages: data.totalPages,
          nextPage: data.page < data.totalPages && data.items.length > 0 ? data.page + 1 : null,
          phase: 'ready',
          pageError: null,
          revision: previous.revision + 1,
          refresh: catalogRefresh,
        }));
        setSummary(data.summary);
      })
      .catch((error: unknown) => {
        if (!request.isCurrent(queryKeyRef.current) || isAbortError(error)) return;
        setCatalog((previous) => previous.key === queryKey
          ? { ...previous, phase: 'error', pageError: errorMessage(error), refresh: catalogRefresh }
          : { key: queryKey, items: [], total: 0, totalPages: 1, nextPage: null,
            phase: 'error', pageError: errorMessage(error), revision: previous.revision,
            refresh: catalogRefresh });
      });
    return () => gate.invalidate();
  }, [queryKey, catalogRefresh, selectedCategory, debouncedSearch, isStackedView, sortBy, sortOrder]);

  const loadMore = useCallback(() => {
    if (!currentCatalog || loading || currentCatalog.phase !== 'ready'
      || !currentCatalog.nextPage || pageLoading) return;
    const page = currentCatalog.nextPage;
    const request = catalogGate.current.begin(queryKey);
    const params = new URLSearchParams();
    if (selectedCategory === 'image') params.set('category', 'image');
    if (selectedCategory === 'audio') params.set('category', 'audio');
    if (selectedCategory === 'animation_stack') params.set('stackType', 'animation');
    if (selectedCategory === 'audio_stack') params.set('stackType', 'audio_variation');
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    params.set('isStackedView', String(isStackedView));
    params.set('sortBy', sortBy);
    params.set('sortOrder', sortOrder);
    params.set('page', String(page));
    params.set('limit', '100');
    setLoadingPage({ key: queryKey, page });
    setCatalog((previous) => ({ ...previous, pageError: null }));
    requestJson(`/api/assets?${params.toString()}`, parseCatalog, { signal: request.signal })
      .then((data) => {
        if (!request.isCurrent(queryKeyRef.current)) return;
        if (data.page !== page) throw new Error('The server returned the wrong catalog page');
        if (data.page > data.totalPages || data.total < currentCatalog.items.length) {
          refreshCatalog();
          return;
        }
        setCatalog((previous) => {
          if (previous.key !== queryKey || previous.nextPage !== page) return previous;
          return {
            ...previous,
            items: uniqueItems([...previous.items, ...data.items]),
            total: data.total,
            totalPages: data.totalPages,
            nextPage: data.page < data.totalPages && data.items.length > 0 ? data.page + 1 : null,
          };
        });
      })
      .catch((error: unknown) => {
        if (!request.isCurrent(queryKeyRef.current) || isAbortError(error)) return;
        setCatalog((previous) => previous.key === queryKey
          ? { ...previous, pageError: errorMessage(error) } : previous);
      })
      .finally(() => {
        if (request.isCurrent(queryKeyRef.current)) setLoadingPage(null);
      });
  }, [currentCatalog, loading, pageLoading, queryKey, selectedCategory, debouncedSearch, isStackedView, sortBy, sortOrder, refreshCatalog]);

  useEffect(() => {
    if (!selectedKey || catalog.revision === 0) return;
    const gate = detailGate.current;
    const request = gate.begin(selectedKey);
    const isStack = selectedKey.startsWith('stack:');
    const id = selectedKey.slice(selectedKey.indexOf(':') + 1);
    const url = `${isStack ? '/api/stacks' : '/api/assets'}/${encodeURIComponent(id)}`;
    requestJson(url, (value) => parseDetail(value, isStack), { signal: request.signal })
      .then((value) => {
        if (!request.isCurrent(selectedIdentityRef.current ?? undefined)) return;
        setSelectedItem(value);
        setDetailError(null);
      })
      .catch((error: unknown) => {
        if (!request.isCurrent(selectedIdentityRef.current ?? undefined) || isAbortError(error)) return;
        if (errorMessage(error) === 'Asset not found' || errorMessage(error) === 'Stack not found') {
          setSelectedItem(null);
          setDetailError(null);
        } else {
          setDetailError(errorMessage(error));
        }
      });
    return () => gate.invalidate();
  }, [selectedKey, catalog.revision]);

  const liveCallbacks = useRef({ refreshCatalog, refreshFilters, showToast });
  useEffect(() => {
    liveCallbacks.current = { refreshCatalog, refreshFilters, showToast };
  }, [refreshCatalog, refreshFilters, showToast]);

  // EventSource replays the current status at every connection. A terminal
  // status is a new notification only after this client saw that scan running.
  useEffect(() => {
    const source = new EventSource('/api/scan/progress');
    source.onopen = () => setScanConnection('connected');
    source.onerror = () => setScanConnection('disconnected');
    source.onmessage = (event) => {
      let payload: ScanProgressEvent;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!isRecord(value) || !['idle', 'scanning', 'completed', 'error'].includes(String(value.status))
          || typeof value.libraryPath !== 'string'
          || typeof value.scannedCount !== 'number' || typeof value.indexedCount !== 'number') return;
        payload = value as unknown as ScanProgressEvent;
      } catch {
        return;
      }
      setScanConnection('connected');
      setScanStatus(payload);
      if (payload.status === 'scanning') {
        if (typeof payload.startTime === 'number') observedScansRef.current.add(payload.startTime);
        if (scanActionRef.current === 'start') {
          scanActionRef.current = null;
          setScanActionPending(null);
        }
        return;
      }
      scanActionRef.current = null;
      setScanActionPending(null);
      const start = payload.startTime;
      if (typeof start !== 'number' || !observedScansRef.current.has(start)
        || notifiedScansRef.current.has(start)) return;
      notifiedScansRef.current.add(start);
      if (payload.status === 'completed') {
        const partial = Boolean(payload.failedScopes?.length);
        liveCallbacks.current.showToast(partial ? 'warning' : 'success',
          partial ? 'Library Scan Partially Completed' : 'Library Scan Completed', payload.message);
        liveCallbacks.current.refreshCatalog();
        liveCallbacks.current.refreshFilters();
      } else if (payload.status === 'error') {
        liveCallbacks.current.showToast('error', 'Library Scan Error', payload.error || payload.message);
        liveCallbacks.current.refreshCatalog();
        liveCallbacks.current.refreshFilters();
      } else if (payload.status === 'idle' && payload.message?.toLowerCase().includes('cancel')) {
        liveCallbacks.current.showToast('info', 'Library Scan Cancelled', payload.message);
        liveCallbacks.current.refreshCatalog();
        liveCallbacks.current.refreshFilters();
      }
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    const gates = [catalogGate.current, facetsGate.current, settingsGate.current, detailGate.current];
    return () => gates.forEach((gate) => gate.invalidate());
  }, []);

  const handleTriggerScan = useCallback(async (explicitLibraryPaths?: string[]) => {
    if (scanActionRef.current || scanStatusRef.current.status === 'scanning') return;
    const paths = (explicitLibraryPaths ?? (settings.libraryPaths.length > 0
      ? settings.libraryPaths : [settings.libraryPath])).filter((path) => path.trim());
    if (paths.length === 0) {
      showToast('warning', 'No Library Configured', 'Add an asset library in Settings before scanning.');
      return;
    }
    scanActionRef.current = 'start';
    setScanActionPending('start');
    try {
      await requestJson('/api/scan/start', (value) => {
        if (!isRecord(value) || typeof value.message !== 'string') {
          throw new Error('The server returned an invalid scan response');
        }
        return value;
      }, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          libraryPath: paths[0],
          libraryPaths: paths,
        }),
      });
      showToast(
        'info',
        'Scan Initiated',
        paths.length > 1
          ? `Scanning ${paths.length} asset source libraries...`
          : `Scanning directory: ${paths[0]}`
      );
      if (scanActionRef.current === 'start') {
        const next = { ...scanStatusRef.current, status: 'scanning' as const,
          libraryPath: paths[0], libraryPaths: paths, message: 'Starting scan...' };
        scanStatusRef.current = next;
        setScanStatus(next);
      }
    } catch (error: unknown) {
      showToast('error', 'Scan Failed', errorMessage(error));
    } finally {
      if (scanActionRef.current === 'start') {
        scanActionRef.current = null;
        setScanActionPending(null);
      }
    }
  }, [settings.libraryPath, settings.libraryPaths, showToast]);

  const handleCancelScan = useCallback(async () => {
    if (scanActionRef.current || scanStatusRef.current.status !== 'scanning') return;
    scanActionRef.current = 'cancel';
    setScanActionPending('cancel');
    try {
      await requestJson('/api/scan/cancel', (value) => {
        if (!isRecord(value) || typeof value.message !== 'string') {
          throw new Error('The server returned an invalid cancellation response');
        }
        return value;
      }, { method: 'POST' });
    } catch (error: unknown) {
      scanActionRef.current = null;
      setScanActionPending(null);
      showToast('error', 'Cancellation Failed', errorMessage(error));
    }
  }, [showToast]);

  const selectItem = useCallback((item: CatalogItem, mode: 'stack' | 'assets' = 'stack') => {
    selectedIdentityRef.current = catalogIdentity(item);
    setSelectedItem(item);
    setInspectorMode(mode);
    setDetailError(null);
  }, []);

  const closeInspector = useCallback(() => {
    selectedIdentityRef.current = null;
    setSelectedItem(null);
    setDetailError(null);
  }, []);

  // Keyboard shortcut Ctrl+K to search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const input = document.querySelector('input[placeholder*="Search"]') as HTMLInputElement;
        if (input) input.focus();
      }
      if (e.key === 'Escape' && !e.defaultPrevented && !isSettingsOpen
        && !isClassifierModalOpen && !copyModalItem
        && !(e.target instanceof Element && e.target.closest('[role="dialog"]'))
        && !(e.target instanceof HTMLInputElement)) {
        closeInspector();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeInspector, isSettingsOpen, isClassifierModalOpen, copyModalItem]);

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
      {sidebarOpen && <button type="button" aria-label="Close library and filters" onClick={() => setSidebarOpen(false)}
        className="fixed inset-0 z-40 bg-black/60 lg:hidden" />}
      <div className={`${sidebarOpen ? 'fixed' : 'hidden'} inset-y-0 left-0 z-50 w-64 lg:contents`}>
      <button type="button" onClick={() => setSidebarOpen(false)}
        className="absolute right-2 top-2 z-10 rounded bg-[#252538] px-2 py-1 text-xs lg:hidden">
        Close filters
      </button>
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
        onTriggerScan={() => { void handleTriggerScan(); }}
        onCancelScan={() => { void handleCancelScan(); }}
        scanActionPending={scanActionPending}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenClassifiers={() => setIsClassifierModalOpen(true)}
        settings={settings}
        summary={summary}
      />
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <button type="button" onClick={() => setSidebarOpen(true)}
          className="lg:hidden shrink-0 self-start px-4 py-2 text-xs font-medium text-indigo-200"
          aria-label="Open library and filters">Library and filters</button>
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
          loadedItems={items.length}
          loading={loading}
        />

        {(settingsError || facetsError || scanConnection === 'disconnected') && (
          <div className="px-4 py-2 border-b border-amber-500/30 bg-amber-950/30 text-xs text-amber-100 flex flex-wrap items-center gap-3" role="status">
            {settingsError && <span>Settings unavailable: {settingsError}</span>}
            {settingsError && <button type="button" className="underline" onClick={() => setSettingsRefresh((value) => value + 1)}>Retry settings</button>}
            {facetsError && <span>Filters unavailable: {facetsError}</span>}
            {facetsError && <button type="button" className="underline" onClick={refreshFilters}>Retry filters</button>}
            {scanConnection === 'disconnected' && <span>Scan updates disconnected. Reconnecting…</span>}
          </div>
        )}
        {facetsLoading && (tags.length > 0 || formats.length > 0) && (
          <div className="sr-only" role="status">Refreshing filters</div>
        )}

        {currentCatalog?.phase === 'error' && !loading && (
          <div className="px-4 py-2 border-b border-rose-500/30 bg-rose-950/30 text-xs text-rose-100 flex items-center gap-3" role="alert">
            <span>Could not load results: {currentCatalog.pageError}. {items.length > 0 ? 'Showing previous results.' : ''}</span>
            <button type="button" className="underline" onClick={refreshCatalog}>Retry results</button>
          </div>
        )}
        {loading && items.length > 0 && (
          <div className="px-4 py-1.5 text-xs text-slate-300 bg-[#202033]" role="status">
            Updating results. Showing previous results until the request finishes.
          </div>
        )}

        {/* Gallery Grid */}
        <AssetGrid
          items={items}
          selectedItem={selectedItem}
          onSelectItem={selectItem}
          onSelectAsset={(asset) => selectItem(asset)}
          onViewStackAssets={(stack) => selectItem(stack, 'assets')}
          viewMode={viewMode}
          cardZoom={cardZoom}
          onQuickCopy={handleQuickCopy}
          loading={loading}
          searchQuery={searchQuery}
          onClearSearch={() => handleSearchChange('')}
          queryKey={queryKey}
        />
        {currentCatalog && currentCatalog.phase === 'ready' && !loading && (currentCatalog.nextPage || currentCatalog.pageError) && (
          <div className="shrink-0 border-t border-[#242438] bg-[#151524] px-4 py-2 flex items-center justify-center gap-3 text-xs" role="status">
            <span className="text-slate-400">{items.length} of {totalCount} results loaded</span>
            {currentCatalog.pageError && <span className="text-rose-300">Page failed: {currentCatalog.pageError}</span>}
            <button type="button" onClick={loadMore} disabled={pageLoading}
              className="px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50">
              {pageLoading ? 'Loading…' : currentCatalog.pageError ? 'Retry page' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {/* Right Inspector Panel */}
      {selectedItem && (
        <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col min-h-0 bg-[#161626] lg:static lg:z-auto lg:w-96 lg:max-w-[50vw] lg:shrink-0 [&>div]:w-full">
          {detailError && <div className="text-xs px-3 py-2 bg-amber-950/50 text-amber-200" role="status">Details may be out of date: {detailError}</div>}
        <Inspector
          item={selectedItem}
          initialViewMode={inspectorMode}
          onClose={closeInspector}
          settings={settings}
          onTagClick={handleSelectTag}
          selectedTag={selectedTag}
          onSelectStack={(stack) => selectItem(stack)}
          onSelectResolution={(r) => toggleOrSetFilter('resolution', r)}
          onSelectWidth={(w) => toggleOrSetFilter('width', w)}
          onSelectHeight={(h) => toggleOrSetFilter('height', h)}
          onSelectDuration={(dur) => toggleOrSetFilter('duration', dur)}
          onSelectBpm={(bpm) => toggleOrSetFilter('bpm', bpm)}
          onSelectSprite={(sprite) => toggleOrSetFilter('sprite', sprite)}
          availableTags={tags}
          onAssetUpdated={(updatedAsset) => {
            if (selectedIdentityRef.current === `asset:${updatedAsset.id}`) {
              setSelectedItem(updatedAsset);
              setDetailError(null);
            }
            refreshCatalog();
            refreshFilters();
          }}
          onStackUpdated={(updatedStack) => {
            if (selectedIdentityRef.current === `stack:${updatedStack.id}`) {
              setSelectedItem({ ...updatedStack, isStack: true });
              setDetailError(null);
            }
            refreshCatalog();
            refreshFilters();
          }}
        />
        </div>
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSettingsSaved={(newSettings) => {
          setSettings(newSettings);
          if (newSettings.libraryPaths && newSettings.libraryPaths.length > 0) {
            void handleTriggerScan(newSettings.libraryPaths);
          }
          refreshCatalog();
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
          refreshCatalog();
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
