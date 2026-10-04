import React, { useState } from 'react';
import {
  TagInfo,
  FormatInfo,
  ScanProgressEvent,
  AppSettings,
} from '../types';
import {
  Folder,
  Layers,
  Image as ImageIcon,
  Volume2,
  Tag,
  Settings,
  RefreshCw,
  Search,
  Filter,
  Check,
  Disc3,
  Sparkles,
} from 'lucide-react';

interface SidebarProps {
  selectedCategory: string;
  onSelectCategory: (cat: string) => void;
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
  selectedFormat: string | null;
  onSelectFormat: (format: string | null) => void;
  tags: TagInfo[];
  formats: FormatInfo[];
  scanStatus: ScanProgressEvent;
  onTriggerScan: () => void;
  onOpenSettings: () => void;
  settings: AppSettings;
  summary: {
    totalAssets: number;
    imageCount: number;
    audioCount: number;
    animationStackCount: number;
    audioStackCount: number;
  };
}

export function Sidebar({
  selectedCategory,
  onSelectCategory,
  selectedTag,
  onSelectTag,
  selectedFormat,
  onSelectFormat,
  tags,
  formats,
  scanStatus,
  onTriggerScan,
  onOpenSettings,
  settings,
  summary,
}: SidebarProps) {
  const [tagSearch, setTagSearch] = useState('');

  const isScanning = scanStatus.status === 'scanning';

  const filteredTags = tags.filter((t) =>
    t.name.toLowerCase().includes(tagSearch.toLowerCase())
  );

  return (
    <aside className="w-64 shrink-0 h-full bg-[#151524] border-r border-[#242438] flex flex-col overflow-hidden text-slate-300">
      {/* Brand Header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-[#242438] bg-[#12121e]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-linear-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center shadow-md">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <span className="text-sm font-bold tracking-tight text-white block leading-tight">
              Assettlor
            </span>
            <span className="text-[10px] text-slate-400 font-mono">Local Asset Hoard</span>
          </div>
        </div>
        <button
          onClick={onOpenSettings}
          title="App Settings"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-[#202033] transition-colors cursor-pointer"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* Library Source & Scanner Section */}
      <div className="p-3.5 border-b border-[#242438] bg-[#181829]/60 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Asset Library
          </span>
          <button
            onClick={onTriggerScan}
            disabled={isScanning}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
          >
            <RefreshCw className={`w-3 h-3 ${isScanning ? 'animate-spin' : ''}`} />
            {isScanning ? 'Scanning...' : 'Scan'}
          </button>
        </div>

        <div
          onClick={onOpenSettings}
          title={`Library: ${settings.libraryPath}`}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#12121d] border border-[#26263a] text-xs font-mono text-slate-300 hover:border-indigo-500/50 cursor-pointer truncate"
        >
          <Folder className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          <span className="truncate">{settings.libraryPath || 'No folder selected'}</span>
        </div>

        {/* Scan Status Progress */}
        {isScanning && (
          <div className="space-y-1.5 pt-1">
            <div className="flex justify-between text-[11px] font-mono text-slate-400">
              <span className="text-cyan-400">Indexing...</span>
              <span>{scanStatus.scannedCount} files</span>
            </div>
            <div className="w-full bg-[#202033] h-1.5 rounded-full overflow-hidden">
              <div className="bg-indigo-500 h-full animate-pulse rounded-full w-full" />
            </div>
          </div>
        )}
      </div>

      {/* Navigation Sections */}
      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        {/* Categories */}
        <div className="space-y-1">
          <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Categories
          </span>

          <button
            onClick={() => onSelectCategory('all')}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              selectedCategory === 'all'
                ? 'bg-indigo-600 text-white font-semibold shadow-xs'
                : 'text-slate-300 hover:bg-[#202033] hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <Disc3 className="w-3.5 h-3.5 text-indigo-300" />
              <span>All Assets</span>
            </div>
            <span className="text-[11px] font-mono opacity-80">{summary.totalAssets}</span>
          </button>

          <button
            onClick={() => onSelectCategory('image')}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              selectedCategory === 'image'
                ? 'bg-indigo-600 text-white font-semibold shadow-xs'
                : 'text-slate-300 hover:bg-[#202033] hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <ImageIcon className="w-3.5 h-3.5 text-cyan-400" />
              <span>Images & Sprites</span>
            </div>
            <span className="text-[11px] font-mono opacity-80">{summary.imageCount}</span>
          </button>

          <button
            onClick={() => onSelectCategory('audio')}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              selectedCategory === 'audio'
                ? 'bg-indigo-600 text-white font-semibold shadow-xs'
                : 'text-slate-300 hover:bg-[#202033] hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <Volume2 className="w-3.5 h-3.5 text-rose-400" />
              <span>Audio & Sound</span>
            </div>
            <span className="text-[11px] font-mono opacity-80">{summary.audioCount}</span>
          </button>

          <button
            onClick={() => onSelectCategory('animation_stack')}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              selectedCategory === 'animation_stack'
                ? 'bg-indigo-600 text-white font-semibold shadow-xs'
                : 'text-slate-300 hover:bg-[#202033] hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-amber-400" />
              <span>Animation Stacks</span>
            </div>
            <span className="text-[11px] font-mono opacity-80">{summary.animationStackCount}</span>
          </button>

          <button
            onClick={() => onSelectCategory('audio_stack')}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              selectedCategory === 'audio_stack'
                ? 'bg-indigo-600 text-white font-semibold shadow-xs'
                : 'text-slate-300 hover:bg-[#202033] hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-purple-400" />
              <span>Audio Variations</span>
            </div>
            <span className="text-[11px] font-mono opacity-80">{summary.audioStackCount}</span>
          </button>
        </div>

        {/* Formats Filter */}
        {formats.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Formats
              </span>
              {selectedFormat && (
                <button
                  onClick={() => onSelectFormat(null)}
                  className="text-[10px] text-indigo-400 hover:underline cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1 px-1">
              {formats.map((fmt) => {
                const isSelected = selectedFormat === fmt.extension;
                return (
                  <button
                    key={fmt.extension}
                    onClick={() => onSelectFormat(isSelected ? null : fmt.extension)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-600 border-indigo-400 text-white font-semibold'
                        : 'bg-[#1b1b2d] border-[#292940] text-slate-400 hover:text-slate-200 hover:border-slate-500'
                    }`}
                  >
                    {fmt.extension.replace('.', '')} ({fmt.count})
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Tags Filter */}
        {tags.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Tags
              </span>
              {selectedTag && (
                <button
                  onClick={() => onSelectTag(null)}
                  className="text-[10px] text-indigo-400 hover:underline cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Tag search input */}
            <div className="relative px-1">
              <Search className="w-3 h-3 text-slate-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder="Filter tags..."
                className="w-full pl-7 pr-2 py-1 text-xs bg-[#12121d] border border-[#27273d] rounded-md text-slate-200 placeholder-slate-500 focus:outline-hidden focus:border-indigo-500"
              />
            </div>

            {/* Tag list */}
            <div className="max-h-48 overflow-y-auto space-y-0.5 px-1">
              {filteredTags.map((tag) => {
                const isSelected = selectedTag
                  ? selectedTag.toLowerCase().replace(/^#/, '') === tag.name.toLowerCase()
                  : false;
                return (
                  <button
                    key={tag.name}
                    onClick={() => onSelectTag(isSelected ? null : tag.name)}
                    className={`w-full flex items-center justify-between px-2 py-1 rounded text-xs transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-600/80 text-white font-semibold'
                        : 'text-slate-400 hover:bg-[#202033] hover:text-slate-200'
                    }`}
                  >
                    <span className="truncate">#{tag.name}</span>
                    <span className="text-[10px] font-mono opacity-70 ml-1">{tag.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer / Project Path display */}
      <div className="p-3 border-t border-[#242438] bg-[#12121e]">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 p-2 rounded-lg bg-[#181828] hover:bg-[#222238] border border-[#26263a] text-slate-300 hover:text-white text-xs transition-colors cursor-pointer"
        >
          <Folder className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <div className="min-w-0 text-left">
            <span className="text-[10px] text-slate-500 block leading-none">Active Game Project</span>
            <span className="truncate block font-mono text-[11px] text-slate-300 mt-0.5">
              {settings.activeProjectPath ? settings.activeProjectPath.split('/').pop() : 'Configure...'}
            </span>
          </div>
        </button>
      </div>
    </aside>
  );
}
