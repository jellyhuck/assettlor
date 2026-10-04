import React, { useState, useEffect } from 'react';
import { AppSettings } from '../types';
import { Settings, Folder, Check, X, HardDrive, RefreshCw } from 'lucide-react';
import { useToast } from './Toast';
import { FolderBrowserModal } from './FolderBrowserModal';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved: (settings: AppSettings) => void;
}

export function SettingsModal({ isOpen, onClose, onSettingsSaved }: SettingsModalProps) {
  const { showToast } = useToast();
  const [settings, setSettings] = useState<AppSettings>({
    libraryPath: '',
    activeProjectPath: '',
    thumbnailQuality: 80,
    autoStackAnimations: true,
    autoStackAudio: true,
    defaultFps: 12,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [browserMode, setBrowserMode] = useState<'library' | 'project' | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      fetch('/api/settings')
        .then((res) => res.json())
        .then((data) => {
          setSettings(data);
        })
        .catch((err) => {
          showToast('error', 'Failed to load settings', err.message);
        })
        .finally(() => setLoading(false));
    }
  }, [isOpen, showToast]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error('Failed to update settings');
      const updated = await res.json();
      setSettings(updated);
      onSettingsSaved(updated);
      showToast('success', 'Settings Saved', 'Active project and library preferences updated');
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

          {/* Form */}
          <div className="p-6 space-y-5 overflow-y-auto max-h-[70vh]">
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
