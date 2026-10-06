import React, { useState, useEffect } from 'react';
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

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved: (settings: AppSettings) => void;
}

export function SettingsModal({ isOpen, onClose, onSettingsSaved }: SettingsModalProps) {
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
  });
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newLibraryPath, setNewLibraryPath] = useState('');

  const [bpmSettings, setBpmSettings] = useState<BpmClassifierSettings>({
    enabled: true,
    minBpm: 60,
    maxBpm: 200,
    minDurationSeconds: 1.0,
    maxAnalysisSeconds: 45.0,
  });
  const [bpmClassifierInfo, setBpmClassifierInfo] = useState<ClassifierInfo | null>(null);

  const [spriteSettings, setSpriteSettings] = useState<SpriteClassifierSettings>({
    enabled: true,
    minConfidence: 0.5,
    enableVisualAnalysis: true,
    enablePathAnalysis: true,
    enableStackAnalysis: true,
  });
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
    applyTag: false,
    tagPrefix: 'pack:',
    targetArchives: [],
    targetDirectories: [],
  });
  const [packClassifierInfo, setPackClassifierInfo] = useState<ClassifierInfo | null>(null);

  const [saving, setSaving] = useState(false);
  const [browserMode, setBrowserMode] = useState<'add_library' | 'add_project' | null>(null);

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

  const addProject = (pathToAdd: string) => {
    const trimmed = pathToAdd.trim();
    if (!trimmed) return;
    setSettings((prev) => {
      const list = [...(prev.projectPaths || [])];
      if (!list.includes(trimmed)) {
        list.push(trimmed);
      }
      return { ...prev, projectPaths: list, activeProjectPath: list[0] || '' };
    });
    setNewProjectPath('');
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

  const makePrimaryLibrary = (index: number) => {
    setSettings((prev) => {
      const list = [...(prev.libraryPaths || [])];
      if (index <= 0 || index >= list.length) return prev;
      const [item] = list.splice(index, 1);
      list.unshift(item);
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

  const addLibrary = (pathToAdd: string) => {
    const trimmed = pathToAdd.trim();
    if (!trimmed) return;
    setSettings((prev) => {
      const list = [...(prev.libraryPaths || [])];
      if (!list.includes(trimmed)) {
        list.push(trimmed);
      }
      return { ...prev, libraryPaths: list, libraryPath: list[0] || '' };
    });
    setNewLibraryPath('');
  };

  const [rescanningLibrary, setRescanningLibrary] = useState<string | null>(null);

  const handleFullRescan = async (libPath: string) => {
    setRescanningLibrary(libPath);
    try {
      const res = await fetch('/api/scan/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ libraryPath: libPath }),
      });
      if (!res.ok) throw new Error('Failed to start full rescan');
      const folderName = libPath.split('/').filter(Boolean).pop() || libPath;
      showToast('info', 'Full Rescan Started', `Removing cached data and re-indexing ${folderName} from scratch...`);
    } catch (err: any) {
      showToast('error', 'Rescan Error', err?.message || 'Failed to start full rescan');
    } finally {
      setRescanningLibrary(null);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetch('/api/settings')
        .then((res) => res.json())
        .then((data) => {
          setSettings({
            ...data,
            libraryPaths: data.libraryPaths || (data.libraryPath ? [data.libraryPath] : []),
            projectPaths: data.projectPaths || (data.activeProjectPath ? [data.activeProjectPath] : []),
          });
        })
        .catch(() => {});

      fetch('/api/classifiers/bpm')
        .then((res) => res.json())
        .then((info: ClassifierInfo) => {
          setBpmClassifierInfo(info);
          if (info.settings) {
            setBpmSettings((prev) => ({
              ...prev,
              ...(info.settings as unknown as Partial<BpmClassifierSettings>),
            }));
          }
        })
        .catch(() => {});

      fetch('/api/classifiers/sprite')
        .then((res) => res.json())
        .then((info: ClassifierInfo) => {
          setSpriteClassifierInfo(info);
          if (info.settings) {
            setSpriteSettings((prev) => ({
              ...prev,
              ...(info.settings as unknown as Partial<SpriteClassifierSettings>),
            }));
          }
        })
        .catch(() => {});

      fetch('/api/classifiers/pack')
        .then((res) => res.json())
        .then((info: ClassifierInfo) => {
          setPackClassifierInfo(info);
          if (info.settings) {
            setPackSettings((prev) => ({
              ...prev,
              ...(info.settings as unknown as Partial<PackClassifierSettings>),
            }));
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const currentProjects = settings.projectPaths && settings.projectPaths.length > 0
        ? settings.projectPaths
        : (settings.activeProjectPath ? [settings.activeProjectPath] : []);
      const currentLibraries = settings.libraryPaths && settings.libraryPaths.length > 0
        ? settings.libraryPaths
        : (settings.libraryPath ? [settings.libraryPath] : []);

      const payload = {
        ...settings,
        projectPaths: currentProjects,
        activeProjectPath: currentProjects[0] || '',
        libraryPaths: currentLibraries,
        libraryPath: currentLibraries[0] || '',
      };

      // 1. Save general settings
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to update app settings');
      const updated = await res.json();
      setSettings(updated);
      onSettingsSaved(updated);

      // 2. Save BPM classifier settings
      const bpmRes = await fetch('/api/classifiers/bpm/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bpmSettings),
      });
      if (!bpmRes.ok) throw new Error('Failed to update BPM classifier settings');

      // 3. Save Sprite classifier settings
      const spriteRes = await fetch('/api/classifiers/sprite/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spriteSettings),
      });
      if (!spriteRes.ok) throw new Error('Failed to update Sprite classifier settings');

      // 4. Save Pack classifier settings
      const packRes = await fetch('/api/classifiers/pack/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packSettings),
      });
      if (!packRes.ok) throw new Error('Failed to update Pack classifier settings');

      showToast('success', 'Settings Saved', 'App and classifier preferences updated');
      onClose();
    } catch (err: any) {
      showToast('error', 'Error Saving Settings', err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
        <div className="bg-[#171727] border border-[#2b2b42] rounded-xl shadow-2xl w-full max-w-xl flex flex-col overflow-hidden text-slate-200">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[#25253c] bg-[#131320]">
            <div className="flex items-center gap-2.5">
              <Settings className="w-5 h-5 text-indigo-400" />
              <h2 className="text-base font-semibold text-slate-100">Assettlor Settings</h2>
            </div>
            <button
              onClick={onClose}
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
          <div className="p-6 space-y-5 overflow-y-auto max-h-[65vh]">
            {activeTab === 'general' ? (
              <>
                {/* Game Project Destinations */}
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                      Game Project Destinations
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
                        No game project directories configured yet. Add one below.
                      </div>
                    )}
                  </div>

                  {/* Add Project Bar */}
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="text"
                      value={newProjectPath}
                      onChange={(e) => setNewProjectPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addProject(newProjectPath);
                        }
                      }}
                      placeholder="Add game project path..."
                      className="flex-1 bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500"
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
                      onClick={() => addProject(newProjectPath)}
                      disabled={!newProjectPath.trim()}
                      className="flex items-center gap-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add
                    </button>
                  </div>
                </div>

                {/* Asset Library Source Directories */}
                <div className="space-y-2 pt-2 border-t border-[#25253c]">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                      Asset Library Source Directories
                    </label>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Source directories scanned and indexed by Assettlor. The primary directory stores the SQLite index and cache.
                    </p>
                  </div>

                  {/* Libraries List */}
                  <div className="space-y-1.5 mt-2">
                    {settings.libraryPaths.map((lib, idx) => {
                      const isFirst = idx === 0;
                      const isLast = idx === settings.libraryPaths.length - 1;
                      const folderName = lib.split('/').filter(Boolean).pop() || lib;

                      return (
                        <div
                          key={`${lib}-${idx}`}
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
                                  <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 shrink-0">
                                    Primary Library
                                  </span>
                                )}
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
                              disabled={rescanningLibrary === lib}
                              title="Completely rescan (remove and full reindex) this library"
                              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-cyan-300 hover:text-cyan-200 bg-cyan-950/40 hover:bg-cyan-900/60 rounded border border-cyan-800/50 transition-colors cursor-pointer disabled:opacity-40"
                            >
                              <RefreshCw className={`w-3 h-3 ${rescanningLibrary === lib ? 'animate-spin' : ''}`} />
                              <span>Rescan</span>
                            </button>
                            {!isFirst && (
                              <button
                                type="button"
                                onClick={() => makePrimaryLibrary(idx)}
                                title="Make this library primary"
                                className="px-2 py-1 text-[11px] font-medium text-indigo-300 hover:text-indigo-200 bg-indigo-950/40 hover:bg-indigo-900/60 rounded border border-indigo-800/50 transition-colors cursor-pointer"
                              >
                                Set Primary
                              </button>
                            )}
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
                      value={newLibraryPath}
                      onChange={(e) => setNewLibraryPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addLibrary(newLibraryPath);
                        }
                      }}
                      placeholder="Add asset library path..."
                      className="flex-1 bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500"
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
                      onClick={() => addLibrary(newLibraryPath)}
                      disabled={!newLibraryPath.trim()}
                      className="flex items-center gap-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add
                    </button>
                  </div>
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
                    min="1"
                    max="60"
                    value={settings.defaultFps}
                    onChange={(e) => setSettings({ ...settings, defaultFps: Number(e.target.value) })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
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
                          checked={packSettings.stripVersionSuffix}
                          onChange={(e) => setPackSettings({ ...packSettings, stripVersionSuffix: e.target.checked })}
                          className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 cursor-pointer"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex items-center justify-between p-2 rounded bg-[#181829] border border-[#25253a]">
                        <div>
                          <span className="font-medium text-slate-200">Apply Database Tag</span>
                          <p className="text-[10px] text-slate-400">Create tag on classified assets</p>
                        </div>
                        <input
                          type="checkbox"
                          checked={packSettings.applyTag}
                          onChange={(e) => setPackSettings({ ...packSettings, applyTag: e.target.checked })}
                          className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 cursor-pointer"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-400 mb-1">Tag Prefix</label>
                        <input
                          type="text"
                          value={packSettings.tagPrefix || ''}
                          onChange={(e) => setPackSettings({ ...packSettings, tagPrefix: e.target.value })}
                          placeholder="e.g. pack: (leave blank for raw name)"
                          className="w-full bg-[#181829] border border-[#2c2c45] rounded-lg px-3 py-1.5 font-mono text-slate-200"
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
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#25253c] bg-[#131320]">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-[#202033] hover:bg-[#2a2a44] rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
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
          title={browserMode === 'add_library' ? 'Select Asset Library Directory' : 'Select Game Project Directory'}
          initialPath={browserMode === 'add_library' ? (settings.libraryPaths[0] || settings.libraryPath) : (settings.projectPaths[0] || settings.activeProjectPath)}
          onSelect={(selectedPath) => {
            if (browserMode === 'add_library') {
              addLibrary(selectedPath);
            } else {
              addProject(selectedPath);
            }
            setBrowserMode(null);
          }}
        />
      )}
    </>
  );
}
