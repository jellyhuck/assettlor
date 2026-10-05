import React, { useState } from 'react';
import { Asset, AssetStack } from '../types';
import { Copy, Folder, Layers, File, Check, X } from 'lucide-react';
import { useToast } from './Toast';

interface CopyModalProps {
  isOpen: boolean;
  onClose: () => void;
  asset?: Asset | null;
  stack?: AssetStack | null;
  targetDir?: string;
  projectPaths?: string[];
}

export function CopyModal({
  isOpen,
  onClose,
  asset,
  stack,
  targetDir,
  projectPaths = [],
}: CopyModalProps) {
  const { showToast } = useToast();
  const [copyAll, setCopyAll] = useState(true);
  const [copying, setCopying] = useState(false);

  const projects = projectPaths.length > 0
    ? projectPaths
    : (targetDir ? [targetDir] : []);

  const [selectedDir, setSelectedDir] = useState<string>(() => {
    return targetDir || (projects.length > 0 ? projects[0] : '');
  });

  if (!isOpen) return null;

  const handleCopy = async () => {
    setCopying(true);
    try {
      const payload = stack && copyAll
        ? { stackId: stack.id, copyStackAll: true, targetPath: selectedDir }
        : { assetId: asset?.id || stack?.representativeAssetId, targetPath: selectedDir };

      const res = await fetch('/api/assets/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to copy asset');
      }

      const data = await res.json();
      showToast('success', 'Copied to Game Project', data.message);
      onClose();
    } catch (err: any) {
      showToast('error', 'Copy Failed', err.message);
    } finally {
      setCopying(false);
    }
  };

  const isStack = Boolean(stack);
  const title = stack ? stack.name : asset?.name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div className="bg-[#171727] border border-[#2d2d48] rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden text-slate-200">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#25253c] bg-[#131320]">
          <div className="flex items-center gap-2">
            <Copy className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-semibold text-slate-100">Copy to Game Project</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Item</div>
            <div className="text-sm font-semibold text-white mt-0.5 truncate">{title}</div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Destination Project</div>
              {projects.length > 1 && (
                <span className="text-[10px] text-indigo-400 font-medium">{projects.length} available</span>
              )}
            </div>

            {projects.length > 1 ? (
              <select
                value={selectedDir}
                onChange={(e) => setSelectedDir(e.target.value)}
                className="w-full bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500 cursor-pointer"
              >
                {projects.map((proj, idx) => {
                  const folderName = proj.split('/').filter(Boolean).pop() || proj;
                  return (
                    <option key={proj} value={proj}>
                      {idx === 0 ? `★ ${folderName} (Active)` : folderName} — {proj}
                    </option>
                  );
                })}
              </select>
            ) : null}

            <div className="flex items-center gap-1.5 text-xs font-mono text-cyan-300 mt-1.5 bg-[#11111d] p-2 rounded border border-[#28283e] break-all">
              <Folder className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span>{selectedDir || 'Active Project not set'}</span>
            </div>
          </div>

          {isStack && (
            <div className="space-y-2 pt-1 border-t border-[#25253c]">
              <div className="text-xs font-semibold text-slate-300">Stack Copy Mode</div>
              <label className="flex items-center gap-2.5 p-2 rounded-lg border border-[#2b2b40] hover:bg-[#202034] cursor-pointer">
                <input
                  type="radio"
                  name="copyMode"
                  checked={copyAll}
                  onChange={() => setCopyAll(true)}
                  className="accent-indigo-500"
                />
                <Layers className="w-4 h-4 text-indigo-400 shrink-0" />
                <div className="text-xs">
                  <div className="font-semibold text-slate-200">Copy Complete Stack ({stack?.itemCount} files)</div>
                  <div className="text-slate-400">Copies all frames/variations into a folder</div>
                </div>
              </label>

              <label className="flex items-center gap-2.5 p-2 rounded-lg border border-[#2b2b40] hover:bg-[#202034] cursor-pointer">
                <input
                  type="radio"
                  name="copyMode"
                  checked={!copyAll}
                  onChange={() => setCopyAll(false)}
                  className="accent-indigo-500"
                />
                <File className="w-4 h-4 text-slate-400 shrink-0" />
                <div className="text-xs">
                  <div className="font-semibold text-slate-200">Copy Representative File Only</div>
                  <div className="text-slate-400">Copies only the primary asset</div>
                </div>
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-[#25253c] bg-[#131320]">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#202033] hover:bg-[#2a2a44] rounded-lg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleCopy}
            disabled={copying || !selectedDir}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-sm disabled:opacity-50 cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            {copying ? 'Copying...' : 'Confirm Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
