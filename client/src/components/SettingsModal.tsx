import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppSettings, BpmClassifierSettings, SpriteClassifierSettings, PackClassifierSettings, ClassifierInfo } from '../types';
import {
  Settings,
  Folder,
  Check,
  X,
  Sparkles,
  Music,
  Image as ImageIcon,
  Package,
  Sliders,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  Star,
  RefreshCw,
} from 'lucide-react';
import { useToast } from './Toast';
import { FolderBrowserModal } from './FolderBrowserModal';
import { createRequestGate, errorMessage, expectRecord, readJson, requestJson } from '../lib/requestLifecycle';
import { bindDialogFocus } from '../lib/dialogFocus';
import { directoryKey, validateSettingsDraft } from '../lib/settingsDraft';
import { useScanStatus } from '../lib/useScanStatus';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved: (settings: AppSettings) => void;
}

type SettingsSection = 'app' | 'bpm' | 'sprite' | 'pack';
type LoadState = 'loading' | 'ready' | 'error';
const sections: SettingsSection[] = ['app', 'bpm', 'sprite', 'pack'];

function parseAppSettings(value: unknown): AppSettings {
  const data = expectRecord(value, 'app settings');
  if (typeof data.libraryPath !== 'string' || typeof data.activeProjectPath !== 'string'
    || !Array.isArray(data.libraryPaths) || !data.libraryPaths.every((path) => typeof path === 'string')
    || !Array.isArray(data.projectPaths) || !data.projectPaths.every((path) => typeof path === 'string')
    || typeof data.thumbnailQuality !== 'number' || typeof data.defaultFps !== 'number'
    || typeof data.autoStackAnimations !== 'boolean' || typeof data.autoStackAudio !== 'boolean'
    || (data.catalogPaging !== 'load-more' && data.catalogPaging !== 'pages')) {
    throw new Error('The app settings response has an unexpected shape');
  }
  return data as unknown as AppSettings;
}

function parseClassifierInfo(value: unknown, id: string): ClassifierInfo {
  const data = expectRecord(value, `${id} classifier`);
  const settings = expectRecord(data.settings, `${id} classifier settings`);
  const required: Record<string, Record<string, 'boolean' | 'number' | 'string'>> = {
    bpm: { enabled: 'boolean', minBpm: 'number', maxBpm: 'number',
      minDurationSeconds: 'number', maxAnalysisSeconds: 'number' },
    sprite: { enabled: 'boolean', minConfidence: 'number', enableVisualAnalysis: 'boolean',
      enablePathAnalysis: 'boolean', enableStackAnalysis: 'boolean' },
    pack: { enabled: 'boolean', inferFromArchive: 'boolean', inferFromDirectory: 'boolean',
      directoryStrategy: 'string', directoryDepth: 'number', cleanSeparators: 'boolean',
      stripVersionSuffix: 'boolean', stripAffixes: 'boolean', caseConvention: 'string' },
  };
  if (data.id !== id || !Array.isArray(data.steps)
    || !data.steps.every((step) => {
      const entry = step !== null && typeof step === 'object' ? step as Record<string, unknown> : null;
      return entry && typeof entry.id === 'string' && typeof entry.name === 'string'
        && typeof entry.description === 'string';
    }) || Object.entries(required[id] ?? {}).some(([key, type]) => typeof settings[key] !== type
      || type === 'number' && !Number.isFinite(settings[key]))) {
    throw new Error(`The ${id} classifier response has an unexpected shape`);
  }
  return { ...data, settings } as unknown as ClassifierInfo;
}

export function SettingsModal({ isOpen, onClose, onSettingsSaved }: SettingsModalProps) {
  if (!isOpen) return null;
  return <OpenSettingsModal onClose={onClose} onSettingsSaved={onSettingsSaved} />;
}

function OpenSettingsModal({ onClose, onSettingsSaved }: Omit<SettingsModalProps, 'isOpen'>) {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<'general' | 'classifiers'>('general');
  const [settings, setSettings] = useState<AppSettings>({
    libraryPath: '',
    libraryPaths: [],
    activeProjectPath: '',
    projectPaths: [],
    thumbnailQuality: 80,
    autoStackAnimations: true,
    autoStackAudio: true,
    defaultFps: 12,
    catalogPaging: 'load-more',
  });
  const [persistedSettings, setPersistedSettings] = useState<AppSettings | null>(null);
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newLibraryPath, setNewLibraryPath] = useState('');
  const [pathError, setPathError] = useState<{ library?: string; project?: string }>({});
  const [validatingPath, setValidatingPath] = useState({ library: false, project: false });
  const [projectCandidate, setProjectCandidate] = useState<string | null>(null);
  const pathGates = useRef({ library: createRequestGate(), project: createRequestGate() });

  const [bpmSettings, setBpmSettings] = useState<BpmClassifierSettings>({
    enabled: true,
    minBpm: 60,
    maxBpm: 200,
    minDurationSeconds: 1.0,
    maxAnalysisSeconds: 45.0,
  });
  const [persistedBpmSettings, setPersistedBpmSettings] = useState<BpmClassifierSettings | null>(null);
  const [bpmClassifierInfo, setBpmClassifierInfo] = useState<ClassifierInfo | null>(null);

  const [spriteSettings, setSpriteSettings] = useState<SpriteClassifierSettings>({
    enabled: true,
    minConfidence: 0.5,
    enableVisualAnalysis: true,
    enablePathAnalysis: true,
    enableStackAnalysis: true,
  });
  const [persistedSpriteSettings, setPersistedSpriteSettings] = useState<SpriteClassifierSettings | null>(null);
  const [spriteClassifierInfo, setSpriteClassifierInfo] = useState<ClassifierInfo | null>(null);

  const [packSettings, setPackSettings] = useState<PackClassifierSettings>({
    enabled: true,
    inferFromArchive: true,
    inferFromDirectory: true,
    directoryStrategy: 'top',
    directoryDepth: 1,
    cleanSeparators: true,
    stripVersionSuffix: true,
    stripAffixes: false,
    caseConvention: 'as-is',
    targetArchives: [],
    targetDirectories: [],
  });
  const [persistedPackSettings, setPersistedPackSettings] = useState<PackClassifierSettings | null>(null);
  const [packClassifierInfo, setPackClassifierInfo] = useState<ClassifierInfo | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [browserMode, setBrowserMode] = useState<'add_library' | 'add_project' | null>(null);
  const [loadState, setLoadState] = useState<Record<SettingsSection, LoadState>>({
    app: 'loading', bpm: 'loading', sprite: 'loading', pack: 'loading',
  });
  const [loadErrors, setLoadErrors] = useState<Partial<Record<SettingsSection, string>>>({});
  const loadGates = useRef({
    app: createRequestGate(), bpm: createRequestGate(),
    sprite: createRequestGate(), pack: createRequestGate(),
  });
  const activeRef = useRef(true);
  const openSessionRef = useRef(0);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const ready = sections.every((section) => loadState[section] === 'ready');
  const draftErrors = ready ? validateSettingsDraft(settings, bpmSettings, spriteSettings, packSettings) : [];
  const dirty = ready && (JSON.stringify(settings) !== JSON.stringify(persistedSettings)
    || JSON.stringify(bpmSettings) !== JSON.stringify(persistedBpmSettings)
    || JSON.stringify(spriteSettings) !== JSON.stringify(persistedSpriteSettings)
    || JSON.stringify(packSettings) !== JSON.stringify(persistedPackSettings));

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const handleClose = useCallback(() => {
    if (!savingRef.current) onCloseRef.current();
  }, []);
  useEffect(() => {
    if (!dialogRef.current) return;
    return bindDialogFocus(dialogRef.current, closeButtonRef.current, handleClose,
      { labelledBy: 'settings-dialog-title' });
  }, [handleClose]);

  const moveProject = (index: number, direction: 'up' | 'down') => {
    setSettings((prev) => {
      const list = [...(prev.projectPaths || [])];
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= list.length) return prev;
      const [item] = list.splice(index, 1);
      list.splice(targetIndex, 0, item);
      return { ...prev, projectPaths: list, activeProjectPath: list[0] || '' };
    });
  };

  const makeActiveProject = (index: number) => {
    setSettings((prev) => {
      const list = [...(prev.projectPaths || [])];
      if (index <= 0 || index >= list.length) return prev;
      const [item] = list.splice(index, 1);
      list.unshift(item);
      return { ...prev, projectPaths: list, activeProjectPath: list[0] || '' };
    });
  };

  const removeProject = (index: number) => {
    setSettings((prev) => {
      const list = [...(prev.projectPaths || [])];
      list.splice(index, 1);
      return { ...prev, projectPaths: list, activeProjectPath: list[0] || '' };
    });
  };

  const appendProject = (pathToAdd: string) => {
    const trimmed = pathToAdd.trim();
    if (!trimmed) return;
    if (settings.projectPaths.some((path) => directoryKey(path) === directoryKey(trimmed))) {
      setPathError((prev) => ({ ...prev, project: 'This project destination is already in the list' }));
      return;
    }
    setSettings((prev) => {
      const list = [...(prev.projectPaths || [])];
      list.push(trimmed);
      return { ...prev, projectPaths: list, activeProjectPath: list[0] || '' };
    });
    setNewProjectPath('');
    setProjectCandidate(null);
    setPathError((prev) => ({ ...prev, project: undefined }));
  };

  const moveLibrary = (index: number, direction: 'up' | 'down') => {
    setSettings((prev) => {
      const list = [...(prev.libraryPaths || [])];
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= list.length) return prev;
      const [item] = list.splice(index, 1);
      list.splice(targetIndex, 0, item);
      return { ...prev, libraryPaths: list, libraryPath: list[0] || '' };
    });
  };


  const removeLibrary = (index: number) => {
    setSettings((prev) => {
      const list = [...(prev.libraryPaths || [])];
      list.splice(index, 1);
      return { ...prev, libraryPaths: list, libraryPath: list[0] || '' };
    });
  };

  const appendLibrary = (pathToAdd: string) => {
    const trimmed = pathToAdd.trim();
    if (!trimmed) return;
    if (settings.libraryPaths.some((path) => directoryKey(path) === directoryKey(trimmed))) {
      setPathError((prev) => ({ ...prev, library: 'This asset library is already in the list' }));
      return;
    }
    setSettings((prev) => {
      const list = [...(prev.libraryPaths || [])];
      list.push(trimmed);
      return { ...prev, libraryPaths: list, libraryPath: list[0] || '' };
    });
    setNewLibraryPath('');
    setPathError((prev) => ({ ...prev, library: undefined }));
  };

  const addPath = async (kind: 'library' | 'project', rawPath: string) => {
    const trimmed = rawPath.trim();
    setPathError((prev) => ({ ...prev, [kind]: undefined }));
    setProjectCandidate(null);
    if (!trimmed) {
      setPathError((prev) => ({ ...prev, [kind]: 'Enter a directory path first' }));
      return;
    }
    const request = pathGates.current[kind].begin();
    setValidatingPath((current) => ({ ...current, [kind]: true }));
    try {
      const result = await requestJson('/api/fs/validate', (value) => {
        const data = expectRecord(value, 'directory validation');
        if (typeof data.exists !== 'boolean' || typeof data.isDirectory !== 'boolean'
          || typeof data.resolvedPath !== 'string' || !data.resolvedPath.trim()) {
          throw new Error('The directory validation response has an unexpected shape');
        }
        return data as { exists: boolean; isDirectory: boolean; resolvedPath: string };
      }, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trimmed }), signal: request.signal,
      });
      if (!request.isCurrent()) return;
      if (kind === 'library') {
        if (!result.exists || !result.isDirectory) throw new Error('Asset libraries must be existing directories');
        appendLibrary(result.resolvedPath);
      } else if (result.exists && result.isDirectory) {
        appendProject(result.resolvedPath);
      } else if (!result.exists) {
        setProjectCandidate(result.resolvedPath);
      } else {
        throw new Error('Project destination must be a directory');
      }
    } catch (error) {
      if (request.isCurrent()) setPathError((prev) => ({ ...prev, [kind]: errorMessage(error) }));
    } finally {
      if (request.isCurrent()) setValidatingPath((current) => ({ ...current, [kind]: false }));
    }
  };

  const [rescanningLibrary, setRescanningLibrary] = useState<string | null>(null);
  const [rescanStartedAt, setRescanStartedAt] = useState<number | null>(null);
  const [rescanError, setRescanError] = useState('');
  const rescanStartRef = useRef(false);
  const { status: scanStatus, error: scanStatusError, refresh: refreshScanStatus } = useScanStatus(true);
  const awaitingStartedJob = rescanStartedAt !== null
    && (!scanStatus?.startTime || scanStatus.startTime < rescanStartedAt);
  const scanBusy = Boolean(rescanningLibrary || scanStatus?.status === 'scanning' || awaitingStartedJob);

  const handleFullRescan = async (libPath: string) => {
    if (rescanStartRef.current || scanBusy || !scanStatus || scanStatusError
      || !persistedSettings?.libraryPaths.some((path) => directoryKey(path) === directoryKey(libPath))) {
      setRescanError('Save this library and wait for the current scan status before rescanning');
      return;
    }
    rescanStartRef.current = true;
    setRescanningLibrary(libPath);
    setRescanError('');
    try {
      const startedAt = Date.now();
      const res = await fetch('/api/scan/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ libraryPath: libPath }),
      });
      try {
        await readJson(res);
      } catch (error) {
        const reason = errorMessage(error);
        if (res.status === 409) throw new Error(`A scan is already running: ${reason}`);
        if (res.status === 400) throw new Error(`Cannot rescan this directory: ${reason}`);
        throw error;
      }
      if (!activeRef.current) return;
      setRescanStartedAt(startedAt);
      await refreshScanStatus();
      if (!activeRef.current) return;
      const folderName = libPath.split('/').filter(Boolean).pop() || libPath;
      showToast('info', 'Full Rescan Started', `Reprocessing ${folderName} and regenerating derived previews. Saved curation is retained.`);
    } catch (error: unknown) {
      await refreshScanStatus();
      if (!activeRef.current) return;
      const message = errorMessage(error);
      setRescanError(message);
      showToast('error', 'Rescan Error', message);
    } finally {
      if (activeRef.current) setRescanningLibrary(null);
      rescanStartRef.current = false;
    }
  };

  const loadSection = useCallback(async (section: SettingsSection) => {
    const request = loadGates.current[section].begin();
    setLoadState((prev) => ({ ...prev, [section]: 'loading' }));
    setLoadErrors((prev) => ({ ...prev, [section]: undefined }));
    try {
      if (section === 'app') {
        const data = await requestJson('/api/settings', parseAppSettings, { signal: request.signal });
        if (!request.isCurrent()) return;
        setSettings(data);
        setPersistedSettings(data);
      } else {
        const info = await requestJson(`/api/classifiers/${section}`,
          (value) => parseClassifierInfo(value, section), { signal: request.signal });
        if (!request.isCurrent()) return;
        if (section === 'bpm') {
          setBpmClassifierInfo(info);
          setBpmSettings(info.settings as unknown as BpmClassifierSettings);
          setPersistedBpmSettings(info.settings as unknown as BpmClassifierSettings);
        } else if (section === 'sprite') {
          setSpriteClassifierInfo(info);
          setSpriteSettings(info.settings as unknown as SpriteClassifierSettings);
          setPersistedSpriteSettings(info.settings as unknown as SpriteClassifierSettings);
        } else {
          setPackClassifierInfo(info);
          setPackSettings(info.settings as unknown as PackClassifierSettings);
          setPersistedPackSettings(info.settings as unknown as PackClassifierSettings);
        }
      }
      setLoadState((prev) => ({ ...prev, [section]: 'ready' }));
    } catch (error) {
      if (!request.isCurrent()) return;
      setLoadErrors((prev) => ({ ...prev, [section]: errorMessage(error) }));
      setLoadState((prev) => ({ ...prev, [section]: 'error' }));
    }
  }, []);

  useEffect(() => {
    const gates = {
      app: createRequestGate(), bpm: createRequestGate(),
      sprite: createRequestGate(), pack: createRequestGate(),
    };
    const directoryGates = { library: createRequestGate(), project: createRequestGate() };
    loadGates.current = gates;
    pathGates.current = directoryGates;
    activeRef.current = true;
    const session = ++openSessionRef.current;
    queueMicrotask(() => {
      if (activeRef.current && openSessionRef.current === session) {
        for (const section of sections) void loadSection(section);
      }
    });
    return () => {
      activeRef.current = false;
      for (const section of sections) gates[section].dispose();
      directoryGates.library.dispose();
      directoryGates.project.dispose();
    };
  }, [loadSection]);

  const handleSave = async () => {
    if (!ready || savingRef.current || validatingPath.library || validatingPath.project
      || projectCandidate) return;
    setValidationAttempted(true);
    if (draftErrors.length > 0) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    let savedSections = 0;
    try {
      const payload = {
        ...settings,
        activeProjectPath: settings.projectPaths[0] || '',
        libraryPath: settings.libraryPaths[0] || '',
      };

      // 1. Save general settings
      const updated = await requestJson('/api/settings', parseAppSettings, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      savedSections++;
      // 2. Save BPM classifier settings
      await requestJson('/api/classifiers/bpm/settings', expectRecord, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bpmSettings),
      });
      savedSections++;

      // 3. Save Sprite classifier settings
      await requestJson('/api/classifiers/sprite/settings', expectRecord, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spriteSettings),
      });
      savedSections++;

      // 4. Save Pack classifier settings
      await requestJson('/api/classifiers/pack/settings', expectRecord, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packSettings),
      });
      savedSections++;

      if (!activeRef.current) return;
      setSettings(updated);
      onSettingsSaved(updated);
      showToast('success', 'Settings Saved', 'App and classifier preferences updated');
      savingRef.current = false;
      onCloseRef.current();
    } catch (err: unknown) {
      if (!activeRef.current) return;
      const detail = err instanceof Error ? err.message : 'Failed to save settings';
      const message = savedSections > 0
        ? `${detail}. ${savedSections} section${savedSections === 1 ? '' : 's'} confirmed saved. Other requests may have persisted; review and retry. No scan started.`
        : `${detail}. No sections confirmed saved. The request may have persisted; review and retry. No scan started.`;
      setSaveError(message);
      showToast('error', 'Error Saving Settings', message);
    } finally {
      savingRef.current = false;
      if (activeRef.current) setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
        <div ref={dialogRef} className="bg-[#171727] border border-[#2b2b42] rounded-xl shadow-2xl w-full max-w-xl max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden text-slate-200">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[#25253c] bg-[#131320]">
            <div className="flex items-center gap-2.5">
              <Settings className="w-5 h-5 text-indigo-400" />
              <h2 id="settings-dialog-title" className="text-base font-semibold text-slate-100">Assettlor Settings</h2>
            </div>
            <button
              ref={closeButtonRef}
              onClick={handleClose}
              disabled={saving}
              aria-label="Close settings"
              className="p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation Tabs */}
          <div className="flex border-b border-[#25253c] bg-[#151524] px-6 pt-2">
            <button
              type="button"
              onClick={() => setActiveTab('general')}
              className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                activeTab === 'general'
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              General & Stacking
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('classifiers')}
              className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'classifiers'
                  ? 'border-pink-500 text-pink-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Asset Classifiers
            </button>
          </div>

          {/* Form */}
          <div className="min-h-0 p-6 space-y-5 overflow-y-auto">
            {!ready ? (
              <div className="space-y-3 text-sm" aria-live="polite">
                <p className="text-slate-300">Loading settings before editing…</p>
                {sections.map((section) => (
                  <div key={section} className="flex items-center justify-between gap-3">
                    <span className="capitalize text-slate-400">{section === 'app' ? 'General' : section} settings</span>
                    {loadState[section] === 'error' ? (
                      <span className="flex items-center gap-2">
                        <span role="alert" className="text-rose-300">{loadErrors[section]}</span>
                        <button type="button" onClick={() => void loadSection(section)}
                          className="rounded bg-indigo-600 px-2 py-1 text-xs text-white">
                          Retry {section}
                        </button>
                      </span>
                    ) : <span>{loadState[section] === 'ready' ? 'Ready' : 'Loading…'}</span>}
                  </div>
                ))}
              </div>
            ) : (
            <fieldset disabled={saving} className="min-w-0 w-full space-y-5">
            {activeTab === 'general' ? (
              <>
                {/* Project Destinations */}
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                      Project Destinations
                    </label>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Target directories where assets can be copied. The first directory in the list is the Active Project.
                    </p>
                  </div>

                  {/* Projects List */}
                  <div className="space-y-1.5 mt-2">
                    {settings.projectPaths.map((proj, idx) => {
                      const isFirst = idx === 0;
                      const isLast = idx === settings.projectPaths.length - 1;
                      const folderName = proj.split('/').filter(Boolean).pop() || proj;

                      return (
                        <div
                          key={`${proj}-${idx}`}
                          className={`flex items-center justify-between p-2 rounded-lg border text-xs transition-colors ${
                            isFirst
                              ? 'bg-[#181a30] border-indigo-500/50 text-slate-100'
                              : 'bg-[#12121d] border-[#25253c] text-slate-300'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                            <span
                              className={`w-5 h-5 flex items-center justify-center rounded text-[10px] font-mono shrink-0 ${
                                isFirst
                                  ? 'bg-indigo-600 text-white font-bold'
                                  : 'bg-[#202034] text-slate-400'
                              }`}
                            >
                              {idx + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-slate-200 truncate">{folderName}</span>
                                {isFirst && (
                                  <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1 shrink-0">
                                    <Star className="w-2.5 h-2.5 fill-emerald-400 text-emerald-400" />
                                    Active Project
                                  </span>
                                )}
                              </div>
                              <span className="font-mono text-[11px] text-slate-400 truncate block mt-0.5" title={proj}>
                                {proj}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {!isFirst && (
                              <button
                                type="button"
                                onClick={() => makeActiveProject(idx)}
                                title="Set as Active Project (move to top)"
                                className="px-2 py-1 text-[11px] font-medium text-emerald-300 hover:text-emerald-200 bg-emerald-950/40 hover:bg-emerald-900/60 rounded border border-emerald-800/50 transition-colors flex items-center gap-1 cursor-pointer"
                              >
                                <Star className="w-3 h-3 text-emerald-400" />
                                <span>Make Active</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => moveProject(idx, 'up')}
                              disabled={isFirst}
                              title="Move Up"
                              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#25253c] disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveProject(idx, 'down')}
                              disabled={isLast}
                              title="Move Down"
                              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#25253c] disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeProject(idx)}
                              title="Remove"
                              className="p-1 rounded text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {settings.projectPaths.length === 0 && (
                      <div className="p-3 text-center text-xs text-slate-500 bg-[#12121d] rounded-lg border border-[#25253c] border-dashed">
                        No project directories configured yet. Add one below.
                      </div>
                    )}
                  </div>

                  {/* Add Project Bar */}
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="text"
                      aria-label="Add project path"
                      value={newProjectPath}
                      onChange={(e) => {
                        pathGates.current.project.invalidate();
                        setValidatingPath((current) => ({ ...current, project: false }));
                        setNewProjectPath(e.target.value);
                        setProjectCandidate(null);
                        setPathError((prev) => ({ ...prev, project: undefined }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void addPath('project', newProjectPath);
                        }
                      }}
                      placeholder="Add project path..."
                      className="min-w-0 flex-1 bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => setBrowserMode('add_project')}
                      className="flex items-center gap-1.5 px-3 py-2 bg-[#232338] hover:bg-[#2e2e4a] text-slate-200 text-xs font-medium rounded-lg border border-[#343452] transition-colors cursor-pointer shrink-0"
                    >
                      <Folder className="w-3.5 h-3.5 text-indigo-400" />
                      Browse
                    </button>
                    <button
                      type="button"
                      onClick={() => void addPath('project', newProjectPath)}
                      disabled={!newProjectPath.trim() || validatingPath.project}
                      className="flex items-center gap-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add
                    </button>
                  </div>
                  {pathError.project && <p role="alert" className="text-xs text-rose-300">{pathError.project}</p>}
                  {projectCandidate && (
                    <div className="rounded border border-amber-700/60 p-2 text-xs text-amber-200">
                      <p>{projectCandidate} does not exist. Copying can create this destination. Confirm it before saving.</p>
                      <button type="button" onClick={() => appendProject(projectCandidate)}
                        className="mt-2 rounded bg-amber-700 px-2 py-1 text-white">
                        Add new destination
                      </button>
                    </div>
                  )}
                </div>

                {/* Asset Library Source Directories */}
                <div className="space-y-2 pt-2 border-t border-[#25253c]">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                      Asset Library Source Directories
                    </label>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Source directories scanned and indexed by Assettlor. All assets across all configured sources are included in the viewer.
                    </p>
                  </div>
                  <div role="status" className="text-xs text-cyan-200">
                    {!scanStatus ? 'Loading scan status…' : scanStatus.status === 'scanning'
                      ? `Scan running: ${scanStatus.message || scanStatus.libraryPath}`
                      : awaitingStartedJob ? 'Waiting for the new scan status…'
                        : scanStatus.message || `Scan status: ${scanStatus.status}`}
                  </div>
                  {scanStatusError && (
                    <p role="alert" className="text-xs text-rose-300">
                      Cannot read scan status: {scanStatusError}{' '}
                      <button type="button" onClick={() => void refreshScanStatus()}
                        className="underline text-rose-100">Retry status</button>
                    </p>
                  )}
                  {rescanError && <p role="alert" className="text-xs text-rose-300">{rescanError}</p>}
                  {dirty && <p className="text-xs text-amber-200">Rescan uses saved paths and settings. Save these changes first if you want them included.</p>}

                  {/* Libraries List */}
                  <div className="space-y-1.5 mt-2">
                    {settings.libraryPaths.map((lib, idx) => {
                      const isFirst = idx === 0;
                      const isLast = idx === settings.libraryPaths.length - 1;
                      const folderName = lib.split('/').filter(Boolean).pop() || lib;
                      const persisted = persistedSettings?.libraryPaths.some((path) => directoryKey(path) === directoryKey(lib));
                      const scanningThisLibrary = scanStatus?.status === 'scanning'
                        && (scanStatus.libraryPaths ?? [scanStatus.libraryPath]).some((path) => directoryKey(path) === directoryKey(lib));

                      return (
                        <div
                          key={`${lib}-${idx}`}
                          className="flex items-center justify-between p-2 rounded-lg border text-xs transition-colors bg-[#12121d] border-[#25253c] text-slate-300"
                        >
                          <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                            <span className="w-5 h-5 flex items-center justify-center rounded text-[10px] font-mono shrink-0 bg-[#202034] text-slate-400">
                              {idx + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-slate-200 truncate">{folderName}</span>
                              </div>
                              <span className="font-mono text-[11px] text-slate-400 truncate block mt-0.5" title={lib}>
                                {lib}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleFullRescan(lib)}
                              disabled={!persisted || !scanStatus || Boolean(scanStatusError) || scanBusy}
                              title={persisted ? 'Reprocess this saved library and regenerate derived previews'
                                : 'Save this library before rescanning'}
                              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-cyan-300 hover:text-cyan-200 bg-cyan-950/40 hover:bg-cyan-900/60 rounded border border-cyan-800/50 transition-colors cursor-pointer disabled:opacity-40"
                            >
                              <RefreshCw className={`w-3 h-3 ${scanningThisLibrary || rescanningLibrary === lib ? 'animate-spin' : ''}`} />
                              <span>{rescanningLibrary === lib ? 'Starting…' : scanningThisLibrary ? 'Scanning…' : 'Rescan'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => moveLibrary(idx, 'up')}
                              disabled={isFirst}
                              title="Move Up"
                              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#25253c] disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveLibrary(idx, 'down')}
                              disabled={isLast}
                              title="Move Down"
                              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#25253c] disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeLibrary(idx)}
                              title="Remove"
                              className="p-1 rounded text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {settings.libraryPaths.length === 0 && (
                      <div className="p-3 text-center text-xs text-slate-500 bg-[#12121d] rounded-lg border border-[#25253c] border-dashed">
                        No asset library directories configured yet. Add one below.
                      </div>
                    )}
                  </div>

                  {/* Add Library Bar */}
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="text"
                      aria-label="Add asset library path"
                      value={newLibraryPath}
                      onChange={(e) => {
                        pathGates.current.library.invalidate();
                        setValidatingPath((current) => ({ ...current, library: false }));
                        setNewLibraryPath(e.target.value);
                        setPathError((prev) => ({ ...prev, library: undefined }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void addPath('library', newLibraryPath);
                        }
                      }}
                      placeholder="Add asset library path..."
                      className="min-w-0 flex-1 bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => setBrowserMode('add_library')}
                      className="flex items-center gap-1.5 px-3 py-2 bg-[#232338] hover:bg-[#2e2e4a] text-slate-200 text-xs font-medium rounded-lg border border-[#343452] transition-colors cursor-pointer shrink-0"
                    >
                      <Folder className="w-3.5 h-3.5 text-indigo-400" />
                      Browse
                    </button>
                    <button
                      type="button"
                      onClick={() => void addPath('library', newLibraryPath)}
                      disabled={!newLibraryPath.trim() || validatingPath.library}
                      className="flex items-center gap-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add
                    </button>
                  </div>
                  {pathError.library && <p role="alert" className="text-xs text-rose-300">{pathError.library}</p>}
                </div>

                {/* Stacking Options */}
                <div className="pt-2 border-t border-[#25253c] space-y-3">
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Automatic Stacking Engine
                  </label>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-slate-200">Stack Animation Sequences</span>
                      <p className="text-xs text-slate-400">Group numbered sprite frames into single animation cards</p>
                    </div>
                    <input
                      type="checkbox"
                      aria-label="Stack animation sequences"
                      checked={settings.autoStackAnimations}
                      onChange={(e) => setSettings({ ...settings, autoStackAnimations: e.target.checked })}
                      className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-slate-200">Stack Audio Variations</span>
                      <p className="text-xs text-slate-400">Group audio variations (e.g. Footstep_01, 02) into single cards</p>
                    </div>
                    <input
                      type="checkbox"
                      aria-label="Stack audio variations"
                      checked={settings.autoStackAudio}
                      onChange={(e) => setSettings({ ...settings, autoStackAudio: e.target.checked })}
                      className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                  </div>
                </div>

                {/* Animation Defaults */}
                <div className="pt-2 border-t border-[#25253c] space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                      Default Animation Playback FPS
                    </label>
                    <span className="text-xs font-mono font-bold text-indigo-400">{settings.defaultFps} FPS</span>
                  </div>
                  <input
                    type="range"
                    aria-label="Default animation playback FPS"
                    min="1"
                    max="60"
                    value={settings.defaultFps}
                    onChange={(e) => setSettings({ ...settings, defaultFps: Number(e.target.value) })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                </div>

                {/* Catalog Display */}
                <div className="pt-2 border-t border-[#25253c] space-y-2">
                  <span className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Catalog Results
                  </span>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label htmlFor="catalog-paging" className="text-sm font-medium text-slate-200">Paging</label>
                      <p className="text-xs text-slate-400">Load more results in one list, or browse numbered pages of 100</p>
                    </div>
                    <select
                      id="catalog-paging"
                      value={settings.catalogPaging}
                      onChange={(e) => setSettings({ ...settings, catalogPaging: e.target.value as AppSettings['catalogPaging'] })}
                      className="shrink-0 bg-[#181829] border border-[#2c2c45] rounded-lg px-2 py-1.5 text-xs text-slate-200 cursor-pointer"
                    >
                      <option value="load-more">Load more</option>
                      <option value="pages">Numbered pages</option>
                    </select>
                  </div>
                </div>
              </>
            ) : (
              /* Classifiers Tab */
              <div className="space-y-5">
                {/* BPM Classifier Card */}
                <div className="bg-[#12121e] border border-[#2b2b42] rounded-xl p-4 space-y-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="p-2 rounded-lg bg-pink-950/60 border border-pink-500/40 text-pink-400">
                        <Music className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-slate-100">BPM & Tempo Classifier</h3>
                        <p className="text-xs text-slate-400">
                          Automated multi-step beat detection and tempo categorization for music tracks
                        </p>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <span className="text-xs font-medium text-slate-300">Auto-scan</span>
                      <input
                        type="checkbox"
                        aria-label="Auto-scan BPM classifier"
                        checked={bpmSettings.enabled}
                        onChange={(e) => setBpmSettings({ ...bpmSettings, enabled: e.target.checked })}
                        className="w-4 h-4 rounded text-pink-600 focus:ring-pink-500 cursor-pointer"
                      />
                    </label>
                  </div>

                  {/* Multi-step Pipeline View */}
                  {bpmClassifierInfo && (
                    <div className="bg-[#181829] border border-[#25253a] rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                        <Sliders className="w-3.5 h-3.5 text-pink-400" />
                        4-Step Pipeline Stages
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        {bpmClassifierInfo.steps.map((st, i) => (
                          <div key={st.id} className="p-2 rounded bg-[#131320] border border-[#222238]">
                            <div className="text-[10px] font-mono text-pink-400 font-bold">Step {i + 1}</div>
                            <div className="font-semibold text-slate-200">{st.name}</div>
                            <div className="text-[10px] text-slate-400">{st.description}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Classifier Settings Form */}
                  <div className="space-y-3 pt-2 text-xs">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-slate-400 mb-1">Min BPM Threshold</label>
                        <input
                          type="number"
                          aria-label="Min BPM threshold"
                          value={bpmSettings.minBpm}
                          onChange={(e) => setBpmSettings({ ...bpmSettings, minBpm: Number(e.target.value) })}
                          min={30}
                          max={150}
                          className="w-full bg-[#181829] border border-[#2c2c45] rounded-lg px-3 py-1.5 font-mono text-slate-200"
                        />
                      </div>
                      <div>
                        <label className="block text-slate-400 mb-1">Max BPM Threshold</label>
                        <input
                          type="number"
                          aria-label="Max BPM threshold"
                          value={bpmSettings.maxBpm}
                          onChange={(e) => setBpmSettings({ ...bpmSettings, maxBpm: Number(e.target.value) })}
                          min={100}
                          max={300}
                          className="w-full bg-[#181829] border border-[#2c2c45] rounded-lg px-3 py-1.5 font-mono text-slate-200"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-slate-400 mb-1">Min Audio Duration (sec)</label>
                        <input
                          type="number"
                          aria-label="Min audio duration in seconds"
                          step="0.5"
                          value={bpmSettings.minDurationSeconds}
                          onChange={(e) =>
                            setBpmSettings({ ...bpmSettings, minDurationSeconds: Number(e.target.value) })
                          }
                          min={0.5}
                          max={10}
                          className="w-full bg-[#181829] border border-[#2c2c45] rounded-lg px-3 py-1.5 font-mono text-slate-200"
                        />
                        <span className="text-[10px] text-slate-500">Skips short sound effects</span>
                      </div>
                      <div>
                        <label className="block text-slate-400 mb-1">Max Analysis Window (sec)</label>
                        <input
                          type="number"
                          aria-label="Max analysis window in seconds"
                          value={bpmSettings.maxAnalysisSeconds}
                          onChange={(e) =>
                            setBpmSettings({ ...bpmSettings, maxAnalysisSeconds: Number(e.target.value) })
                          }
                          min={10}
                          max={120}
                          className="w-full bg-[#181829] border border-[#2c2c45] rounded-lg px-3 py-1.5 font-mono text-slate-200"
                        />
                        <span className="text-[10px] text-slate-500">Limits CPU usage</span>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[#232338]">
                      <div className="p-2.5 rounded-lg bg-[#181829] border border-[#25253a] text-slate-400 text-[11px] leading-relaxed">
                        <span className="font-semibold text-pink-300">Search Keywords:</span> BPM results are accessible using special search queries like <code className="text-pink-400 font-mono">bpm:120</code>, <code className="text-pink-400 font-mono">bpm:&gt;120</code>, or <code className="text-pink-400 font-mono">bpm:fast</code>. No tags are assigned.
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sprite Classifier Section */}
                <div className="bg-[#12121e] border border-[#232338] rounded-xl p-4 space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-[#202033]">
                    <div className="flex items-center gap-2.5">
                      <div className="p-2 rounded-lg bg-purple-950/60 border border-purple-500/40 text-purple-400">
                        <ImageIcon className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-slate-200">Sprite Classifier</h4>
                        <p className="text-xs text-slate-400">
                          Classifies 2D game images into character, object, texture, background archetypes
                        </p>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <span className="text-xs font-medium text-slate-300">Auto-scan</span>
                      <input
                        type="checkbox"
                        aria-label="Auto-scan sprite classifier"
                        checked={spriteSettings.enabled}
                        onChange={(e) => setSpriteSettings({ ...spriteSettings, enabled: e.target.checked })}
                        className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 cursor-pointer"
                      />
                    </label>
                  </div>

                  {/* Multi-step Pipeline View */}
                  {spriteClassifierInfo && (
                    <div className="bg-[#181829] border border-[#25253a] rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                        <Sliders className="w-3.5 h-3.5 text-purple-400" />
                        5-Step Pipeline Stages
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
                        {spriteClassifierInfo.steps.map((st, i) => (
                          <div key={st.id} className="p-2 rounded bg-[#131320] border border-[#222238]">
                            <div className="text-[10px] font-mono text-purple-400 font-bold">Step {i + 1}</div>
                            <div className="font-semibold text-slate-200">{st.name}</div>
                            <div className="text-[10px] text-slate-400">{st.description}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Classifier Settings Form */}
                  <div className="space-y-3 pt-2 text-xs">
                    <div>
                      <label className="block text-slate-400 mb-1">
                        Min Confidence: {Math.round(spriteSettings.minConfidence * 100)}%
                      </label>
                      <input
                        type="range"
                        aria-label="Min sprite confidence"
                        min={0.3}
                        max={0.9}
                        step={0.05}
                        value={spriteSettings.minConfidence}
                        onChange={(e) => setSpriteSettings({ ...spriteSettings, minConfidence: Number(e.target.value) })}
                        className="w-full max-w-sm accent-purple-500 cursor-pointer"
                      />
                      <span className="text-[10px] text-slate-500">Lower for more matches, higher for strict precision</span>
                    </div>

                    <div className="space-y-2 pt-2 border-t border-[#232338]">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium text-slate-200">Enable Visual Pixel Analysis</span>
                          <p className="text-[11px] text-slate-400">Inspects alpha coverage, trim bounds, and seamless edge continuity</p>
                        </div>
                        <input
                          type="checkbox"
                          aria-label="Enable visual pixel analysis"
                          checked={spriteSettings.enableVisualAnalysis}
                          onChange={(e) => setSpriteSettings({ ...spriteSettings, enableVisualAnalysis: e.target.checked })}
                          className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 cursor-pointer"
                        />
                      </div>

                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium text-slate-200">Enable Path & Filename Keywords</span>
                          <p className="text-[11px] text-slate-400">Matches folder names and filenames against game taxonomy</p>
                        </div>
                        <input
                          type="checkbox"
                          aria-label="Enable path and filename keywords"
                          checked={spriteSettings.enablePathAnalysis}
                          onChange={(e) => setSpriteSettings({ ...spriteSettings, enablePathAnalysis: e.target.checked })}
                          className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 cursor-pointer"
                        />
                      </div>

                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium text-slate-200">Enable Animation Stack Analysis</span>
                          <p className="text-[11px] text-slate-400">Uses walk/run/jump/spin frame patterns from detected stacks</p>
                        </div>
                        <input
                          type="checkbox"
                          aria-label="Enable animation stack analysis"
                          checked={spriteSettings.enableStackAnalysis}
                          onChange={(e) => setSpriteSettings({ ...spriteSettings, enableStackAnalysis: e.target.checked })}
                          className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 cursor-pointer"
                        />
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[#232338]">
                      <div className="p-2.5 rounded-lg bg-[#181829] border border-[#25253a] text-slate-400 text-[11px] leading-relaxed">
                        <span className="font-semibold text-purple-300">Search Keywords:</span> Archetypes are accessible using special search queries like <code className="text-purple-400 font-mono">sprite:character</code>, <code className="text-purple-400 font-mono">sprite:texture</code>, <code className="text-purple-400 font-mono">sprite:object</code>, or <code className="text-purple-400 font-mono">sprite:background</code>. No tags are assigned.
                      </div>
                    </div>
                  </div>
                </div>

                {/* Pack Classifier Section */}
                <div className="bg-[#12121e] border border-[#232338] rounded-xl p-4 space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-[#202033]">
                    <div className="flex items-center gap-2.5">
                      <div className="p-2 rounded-lg bg-amber-950/60 border border-amber-500/40 text-amber-400">
                        <Package className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-slate-200">Pack Classifier</h4>
                        <p className="text-xs text-slate-400">
                          Identifies asset pack names from archive names or directory hierarchy
                        </p>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <span className="text-xs font-medium text-slate-300">Auto-scan</span>
                      <input
                        type="checkbox"
                        aria-label="Auto-scan pack classifier"
                        checked={packSettings.enabled}
                        onChange={(e) => setPackSettings({ ...packSettings, enabled: e.target.checked })}
                        className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 cursor-pointer"
                      />
                    </label>
                  </div>

                  {/* Multi-step Pipeline View */}
                  {packClassifierInfo && (
                    <div className="bg-[#181829] border border-[#25253a] rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                        <Sliders className="w-3.5 h-3.5 text-amber-400" />
                        4-Step Pipeline Stages
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                        {packClassifierInfo.steps.map((st, i) => (
                          <div key={st.id} className="p-2 rounded bg-[#131320] border border-[#222238]">
                            <div className="text-[10px] font-mono text-amber-400 font-bold">Step {i + 1}</div>
                            <div className="font-semibold text-slate-200">{st.name}</div>
                            <div className="text-[10px] text-slate-400">{st.description}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Classifier Settings Form */}
                  <div className="space-y-3 pt-2 text-xs">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex items-center justify-between p-2 rounded bg-[#181829] border border-[#25253a]">
                        <div>
                          <span className="font-medium text-slate-200">Infer from Archives</span>
                          <p className="text-[10px] text-slate-400">Extracts pack name from zip filename</p>
                        </div>
                        <input
                          type="checkbox"
                          aria-label="Infer from archives"
                          checked={packSettings.inferFromArchive}
                          onChange={(e) => setPackSettings({ ...packSettings, inferFromArchive: e.target.checked })}
                          className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 cursor-pointer"
                        />
                      </div>

                      <div className="flex items-center justify-between p-2 rounded bg-[#181829] border border-[#25253a]">
                        <div>
                          <span className="font-medium text-slate-200">Infer from Directories</span>
                          <p className="text-[10px] text-slate-400">Extracts pack name from folder structure</p>
                        </div>
                        <input
                          type="checkbox"
                          aria-label="Infer from directories"
                          checked={packSettings.inferFromDirectory}
                          onChange={(e) => setPackSettings({ ...packSettings, inferFromDirectory: e.target.checked })}
                          className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 cursor-pointer"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-slate-400 mb-1">Directory Strategy</label>
                        <select
                          aria-label="Directory strategy"
                          value={packSettings.directoryStrategy}
                          onChange={(e) =>
                            setPackSettings({
                              ...packSettings,
                              directoryStrategy: e.target.value as 'top' | 'enclosing' | 'pattern',
                            })
                          }
                          className="w-full bg-[#181829] border border-[#2c2c45] rounded-lg px-3 py-1.5 font-mono text-slate-200 cursor-pointer"
                        >
                          <option value="top">Top Folder (Library Subfolder)</option>
                          <option value="enclosing">Enclosing Folder (Immediate Parent)</option>
                          <option value="pattern">Pattern (Detect 'pack'/'bundle' in Path)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-slate-400 mb-1">Case Convention</label>
                        <select
                          aria-label="Case convention"
                          value={packSettings.caseConvention}
                          onChange={(e) =>
                            setPackSettings({
                              ...packSettings,
                              caseConvention: e.target.value as 'as-is' | 'title' | 'lower' | 'upper',
                            })
                          }
                          className="w-full bg-[#181829] border border-[#2c2c45] rounded-lg px-3 py-1.5 font-mono text-slate-200 cursor-pointer"
                        >
                          <option value="as-is">As-Is (Preserve Original Casing)</option>
                          <option value="title">Title Case (Capitalize Words)</option>
                          <option value="lower">Lowercase</option>
                          <option value="upper">UPPERCASE</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex items-center justify-between p-2 rounded bg-[#181829] border border-[#25253a]">
                        <div>
                          <span className="font-medium text-slate-200">Clean Separators</span>
                          <p className="text-[10px] text-slate-400">Convert underscores and dashes to spaces</p>
                        </div>
                        <input
                          type="checkbox"
                          aria-label="Clean separators"
                          checked={packSettings.cleanSeparators}
                          onChange={(e) => setPackSettings({ ...packSettings, cleanSeparators: e.target.checked })}
                          className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 cursor-pointer"
                        />
                      </div>

                      <div className="flex items-center justify-between p-2 rounded bg-[#181829] border border-[#25253a]">
                        <div>
                          <span className="font-medium text-slate-200">Strip Version Suffixes</span>
                          <p className="text-[10px] text-slate-400">Remove _v1.0, -v2, etc.</p>
                        </div>
                        <input
                          type="checkbox"
                          aria-label="Strip version suffixes"
                          checked={packSettings.stripVersionSuffix}
                          onChange={(e) => setPackSettings({ ...packSettings, stripVersionSuffix: e.target.checked })}
                          className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 cursor-pointer"
                        />
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[#232338]">
                      <div className="p-2.5 rounded-lg bg-[#181829] border border-[#25253a] text-slate-400 text-[11px] leading-relaxed">
                        <span className="font-semibold text-amber-300">Search Keywords:</span> Asset packs are accessible using special search queries like <code className="text-amber-400 font-mono">pack:RetroPack</code>, <code className="text-amber-400 font-mono">pack:retro*</code>, or <code className="text-amber-400 font-mono">pack:none</code>.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            </fieldset>
            )}
          </div>

          {/* Footer */}
          {ready && <p role="status" className="px-6 pt-2 text-xs text-slate-400">
            {dirty ? 'Unsaved changes' : 'Settings loaded'}
          </p>}
          {validationAttempted && draftErrors.length > 0 && (
            <ul role="alert" className="px-6 pt-3 text-xs text-rose-300 list-disc list-inside">
              {draftErrors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          )}
          {saveError && <p role="alert" className="px-6 pt-3 text-xs text-rose-300">{saveError}</p>}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#25253c] bg-[#131320]">
            <button
              onClick={handleClose}
              disabled={saving}
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-[#202033] hover:bg-[#2a2a44] rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !ready || validatingPath.library || validatingPath.project
                || Boolean(projectCandidate)}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-md disabled:opacity-50 cursor-pointer"
            >
              <Check className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      </div>

      {/* Directory Browser Modal */}
      {browserMode && (
        <FolderBrowserModal
          isOpen={Boolean(browserMode)}
          onClose={() => setBrowserMode(null)}
          title={browserMode === 'add_library' ? 'Select Asset Library Directory' : 'Select Project Directory'}
          initialPath={browserMode === 'add_library' ? (settings.libraryPaths[0] || settings.libraryPath) : (settings.projectPaths[0] || settings.activeProjectPath)}
          onSelect={(selectedPath) => {
            if (browserMode === 'add_library') {
              void addPath('library', selectedPath);
            } else {
              void addPath('project', selectedPath);
            }
            setBrowserMode(null);
          }}
        />
      )}
    </>
  );
}
