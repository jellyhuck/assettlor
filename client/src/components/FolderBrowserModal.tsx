import React, { useState, useEffect } from 'react';
import { Folder, ChevronRight, CornerLeftUp, Check, X, Loader2 } from 'lucide-react';

interface FolderBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (selectedPath: string) => void;
  initialPath?: string;
  title: string;
}

export function FolderBrowserModal({
  isOpen,
  onClose,
  onSelect,
  initialPath,
  title,
}: FolderBrowserModalProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || '');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = async (targetPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const q = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
      const res = await fetch(`/api/fs/browse${q}`);
      if (!res.ok) throw new Error('Failed to browse directory');
      const data = await res.json();
      setCurrentPath(data.currentPath);
      setParentPath(data.parentPath);
      setDirectories(data.directories || []);
    } catch (err: any) {
      setError(err.message || 'Cannot access path');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadDirectory(initialPath || undefined);
    }
  }, [isOpen, initialPath]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="bg-[#181828] border border-[#2e2e48] rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh] overflow-hidden text-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a44] bg-[#141422]">
          <div className="flex items-center gap-2.5">
            <Folder className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base font-semibold text-slate-100">{title}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Current Path Bar */}
        <div className="px-5 py-3 border-b border-[#25253c] bg-[#1a1a2e] flex items-center gap-2">
          {parentPath && (
            <button
              onClick={() => loadDirectory(parentPath)}
              title="Go to parent directory"
              className="p-1.5 rounded bg-[#25253e] hover:bg-[#323254] text-slate-300 hover:text-white transition-colors cursor-pointer"
            >
              <CornerLeftUp className="w-4 h-4" />
            </button>
          )}
          <div className="flex-1 bg-[#12121e] border border-[#2d2d48] rounded px-3 py-1.5 text-xs font-mono text-slate-300 truncate select-text">
            {currentPath}
          </div>
        </div>

        {/* Directory List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1 min-h-[300px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
              <span className="text-xs">Reading directories...</span>
            </div>
          ) : error ? (
            <div className="p-4 text-xs text-rose-400 bg-rose-950/20 border border-rose-900/40 rounded-lg">
              {error}
            </div>
          ) : directories.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No subdirectories found in this folder.
            </div>
          ) : (
            directories.map((dir) => (
              <button
                key={dir.path}
                onClick={() => loadDirectory(dir.path)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-[#232338] text-slate-300 hover:text-white transition-colors text-left group cursor-pointer"
              >
                <div className="flex items-center gap-2.5 truncate">
                  <Folder className="w-4 h-4 text-indigo-400/80 group-hover:text-indigo-400 shrink-0" />
                  <span className="text-sm font-medium truncate">{dir.name}</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-slate-400 transition-colors shrink-0" />
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-[#25253c] bg-[#141422]">
          <span className="text-xs text-slate-400 truncate max-w-xs">
            Selected: <span className="text-slate-200 font-mono">{currentPath}</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#202033] hover:bg-[#2b2b44] rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onSelect(currentPath);
                onClose();
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-sm cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Choose Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
