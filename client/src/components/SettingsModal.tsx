import React, { useState, useEffect } from 'react';
import { AppSettings, BpmClassifierSettings, SpriteClassifierSettings, ClassifierInfo } from '../types';
import { Settings, Folder, Check, X, Sparkles, Music, Image as ImageIcon, Sliders } from 'lucide-react';
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
    activeProjectPath: '',
    thumbnailQuality: 80,
    autoStackAnimations: true,
    autoStackAudio: true,
    defaultFps: 12,
  });
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

  const [saving, setSaving] = useState(false);
  const [browserMode, setBrowserMode] = useState<'library' | 'project' | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetch('/api/settings')
        .then((res) => res.json())
        .then((data) => {
          setSettings(data);
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
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      // 1. Save general settings
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
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
                {/* Active Game Project Path */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Active Game Project Destination Path
                  </label>
                  <p className="text-xs text-slate-400">
                    Where assets are copied when you click "Copy to Game Project".
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      type="text"
                      value={settings.activeProjectPath}
                      onChange={(e) => setSettings({ ...settings, activeProjectPath: e.target.value })}
                      placeholder="/Users/name/projects/my-game/assets"
                      className="flex-1 bg-[#12121d] border border-[#2c2c45] rounded-lg px-3.5 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => setBrowserMode('project')}
                      className="flex items-center gap-1.5 px-3 py-2 bg-[#232338] hover:bg-[#2e2e4a] text-slate-200 text-xs font-medium rounded-lg border border-[#343452] transition-colors cursor-pointer"
                    >
                      <Folder className="w-3.5 h-3.5 text-indigo-400" />
                      Browse
                    </button>
                  </div>
                </div>

                {/* Asset Library Path */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Asset Library Source Directory
                  </label>
                  <p className="text-xs text-slate-400">
                    Root directory scanned and indexed by Assettlor.
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      type="text"
                      value={settings.libraryPath}
                      onChange={(e) => setSettings({ ...settings, libraryPath: e.target.value })}
                      placeholder="/Users/name/game-assets"
                      className="flex-1 bg-[#12121d] border border-[#2c2c45] rounded-lg px-3.5 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => setBrowserMode('library')}
                      className="flex items-center gap-1.5 px-3 py-2 bg-[#232338] hover:bg-[#2e2e4a] text-slate-200 text-xs font-medium rounded-lg border border-[#343452] transition-colors cursor-pointer"
                    >
                      <Folder className="w-3.5 h-3.5 text-indigo-400" />
                      Browse
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
          title={browserMode === 'library' ? 'Select Asset Library Directory' : 'Select Active Game Project Directory'}
          initialPath={browserMode === 'library' ? settings.libraryPath : settings.activeProjectPath}
          onSelect={(selectedPath) => {
            if (browserMode === 'library') {
              setSettings((prev) => ({ ...prev, libraryPath: selectedPath }));
            } else {
              setSettings((prev) => ({ ...prev, activeProjectPath: selectedPath }));
            }
          }}
        />
      )}
    </>
  );
}
