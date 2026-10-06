import React, { useState, useEffect, useRef } from 'react';
import { Asset, AssetStack, AppSettings, TagInfo } from '../types';
import {
  X,
  Copy,
  Folder,
  Layers,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid,
  Volume2,
  Image as ImageIcon,
  Tag,
  Play,
  ChevronLeft,
  ChevronRight,
  Activity,
  RefreshCw,
  Sparkles,
  Package,
  Plus,
  Check,
  Loader2,
} from 'lucide-react';
import { FlipbookPlayer } from './FlipbookPlayer';
import { AudioWaveformPlayer } from './AudioWaveformPlayer';
import { SoundIcon, MusicPlateIcon } from './AudioIcons';
import { useToast } from './Toast';
import { CopyModal } from './CopyModal';

interface InspectorProps {
  item: Asset | (AssetStack & { isStack: true }) | null;
  onClose: () => void;
  settings: AppSettings;
  onTagClick?: (tag: string) => void;
  selectedTag?: string | null;
  initialViewMode?: 'stack' | 'assets';
  onSelectStack?: (stack: AssetStack & { isStack: true }) => void;
  onSelectResolution?: (res: string | null) => void;
  onSelectWidth?: (width: string | null) => void;
  onSelectHeight?: (height: string | null) => void;
  onSelectDuration?: (duration: string | null) => void;
  onSelectBpm?: (bpm: string | null) => void;
  onSelectSprite?: (sprite: string | null) => void;
  onAssetUpdated?: (updatedAsset: Asset) => void;
  onStackUpdated?: (updatedStack: AssetStack & { isStack: true }) => void;
  availableTags?: TagInfo[];
}

export function Inspector({
  item,
  onClose,
  settings,
  onTagClick,
  selectedTag,
  initialViewMode = 'stack',
  onSelectStack,
  onSelectResolution,
  onSelectWidth,
  onSelectHeight,
  onSelectDuration,
  onSelectBpm,
  onSelectSprite,
  onAssetUpdated,
  onStackUpdated,
  availableTags,
}: InspectorProps) {
  const { showToast } = useToast();

  const [pixelated, setPixelated] = useState(true);
  const [checkerboard, setCheckerboard] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [stackAssets, setStackAssets] = useState<Asset[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<Asset | null>(null);
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);
  const [stackViewMode, setStackViewMode] = useState<'stack' | 'assets'>(initialViewMode);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [parentStack, setParentStack] = useState<(AssetStack & { isStack: true }) | null>(null);
  const [analyzingBpm, setAnalyzingBpm] = useState(false);
  const [classifyingSprite, setClassifyingSprite] = useState(false);
  const [classifyingPack, setClassifyingPack] = useState(false);
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagInput, setNewTagInput] = useState('');
  const [isTagSubmitting, setIsTagSubmitting] = useState(false);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [applyTagsToStack, setApplyTagsToStack] = useState(false);
  const [tagSuggestionsOpen, setTagSuggestionsOpen] = useState(false);
  const [localAvailableTags, setLocalAvailableTags] = useState<TagInfo[]>([]);
  const tagInputRef = useRef<HTMLInputElement | null>(null);

  const isStack = Boolean(item && 'isStack' in item && item.isStack);
  const stack = isStack ? (item as AssetStack & { isStack: true }) : null;

  // Sync initial view mode when prop changes
  useEffect(() => {
    if (initialViewMode) {
      setStackViewMode(initialViewMode);
    }
  }, [initialViewMode]);

  // Load stack frames / variations if item is a stack
  useEffect(() => {
    setZoomLevel(1);
    setSelectedFrameIndex(0);

    if (stack) {
      fetch(`/api/stacks/${stack.id}/assets`)
        .then((res) => res.json())
        .then((assets: Asset[]) => {
          setStackAssets(assets);
          if (assets.length > 0) {
            setSelectedVariant(assets[0]);
          }
        })
        .catch((err) => {
          console.warn('Failed to load stack assets:', err);
        });
    } else {
      setStackAssets([]);
      setSelectedVariant(null);
    }
  }, [item?.id, stack?.id]);

  // If item is an individual asset that has a stackId, fetch its parent stack details
  useEffect(() => {
    if (!isStack && item && (item as Asset).stackId) {
      fetch(`/api/stacks/${(item as Asset).stackId}`)
        .then((res) => res.json())
        .then((data) => {
          if (data && data.id) {
            setParentStack({ ...data, isStack: true });
          }
        })
        .catch(() => setParentStack(null));
    } else {
      setParentStack(null);
    }
  }, [item?.id, isStack]);

  useEffect(() => {
    if (!availableTags || availableTags.length === 0) {
      fetch('/api/tags')
        .then((res) => res.json())
        .then((data) => {
          if (Array.isArray(data)) {
            setLocalAvailableTags(data);
          }
        })
        .catch(() => {});
    }
  }, [availableTags]);

  useEffect(() => {
    if (isAddingTag && tagInputRef.current) {
      tagInputRef.current.focus();
    }
  }, [isAddingTag]);

  if (!item) return null;

  // Active content asset when browsing stack members separately or viewing selected frame
  const currentSeparateAsset =
    isStack && stackAssets.length > 0
      ? stackAssets[selectedFrameIndex] || stackAssets[0]
      : selectedVariant || stack?.representativeAsset || (item as Asset);

  // Asset to display in metadata section and single preview
  const displayedAsset =
    !isStack
      ? (item as Asset)
      : currentSeparateAsset || selectedVariant || stack?.representativeAsset;

  if (!displayedAsset) return null;

  const isDisplayedImage = displayedAsset.category === 'image';
  const isDisplayedAudio = displayedAsset.category === 'audio';

  const formatBytes = (bytes?: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const copyPathToClipboard = () => {
    navigator.clipboard.writeText(displayedAsset.absolutePath);
    showToast('success', 'Path Copied', displayedAsset.absolutePath);
  };

  const handleAnalyzeBpm = async () => {
    if (!displayedAsset || displayedAsset.category !== 'audio') return;
    setAnalyzingBpm(true);
    try {
      const res = await fetch('/api/classifiers/bpm/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'asset',
          targetValue: displayedAsset.id,
        }),
      });
      if (!res.ok) throw new Error('Failed to run BPM classifier');
      const runRes = await res.json();
      const detail = runRes.details?.[0];
      if (detail && detail.success && detail.result?.bpm) {
        showToast(
          'success',
          'BPM Detected',
          `${displayedAsset.name}: ${detail.result.bpm} BPM (${detail.result.tempoDescription || 'classified'})`
        );
        const updatedAsset: Asset = {
          ...displayedAsset,
          metadata: {
            ...displayedAsset.metadata,
            bpm: detail.result.bpm,
            tempoDescription: detail.result.tempoDescription,
          },
          tags: displayedAsset.tags.filter(
            (t) => !t.startsWith('bpm:') && t !== displayedAsset.metadata.tempoDescription && t !== detail.result.tempoDescription
          ),
        };
        if (selectedVariant) {
          setSelectedVariant(updatedAsset);
        }
        onAssetUpdated?.(updatedAsset);
      } else {
        showToast('info', 'No Rhythmic Beats', detail?.error || 'Could not detect rhythmic tempo');
      }
    } catch (err: any) {
      showToast('error', 'BPM Analysis Error', err?.message || 'Failed to detect BPM');
    } finally {
      setAnalyzingBpm(false);
    }
  };

  const handleClassifySprite = async () => {
    if (!displayedAsset || displayedAsset.category !== 'image') return;
    setClassifyingSprite(true);
    try {
      const res = await fetch('/api/classifiers/sprite/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'asset',
          targetValue: displayedAsset.id,
        }),
      });
      if (!res.ok) throw new Error('Failed to run Sprite classifier');
      const runRes = await res.json();
      const detail = runRes.details?.[0];
      if (detail && detail.success && detail.result?.spriteType) {
        const typeStr = String(detail.result.spriteType);
        const confStr = detail.result.confidence !== undefined ? ` (${Math.round(Number(detail.result.confidence) * 100)}%)` : '';
        showToast(
          'success',
          'Sprite Classified',
          `${displayedAsset.name}: ${typeStr}${confStr}`
        );
        const updatedAsset: Asset = {
          ...displayedAsset,
          metadata: {
            ...displayedAsset.metadata,
            spriteType: detail.result.spriteType,
            spriteConfidence: detail.result.confidence,
          },
          tags: displayedAsset.tags.filter((t) => !t.startsWith('sprite:')),
        };
        if (selectedVariant) {
          setSelectedVariant(updatedAsset);
        }
        onAssetUpdated?.(updatedAsset);
      } else {
        showToast('info', 'Sprite Classification', detail?.error || 'Could not classify sprite');
      }
    } catch (err: any) {
      showToast('error', 'Sprite Classification Error', err?.message || 'Failed to classify sprite');
    } finally {
      setClassifyingSprite(false);
    }
  };

  const handleClassifyPack = async () => {
    if (!displayedAsset) return;
    setClassifyingPack(true);
    try {
      const res = await fetch('/api/classifiers/pack/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'asset',
          targetValue: displayedAsset.id,
        }),
      });
      if (!res.ok) throw new Error('Failed to run Pack classifier');
      const runRes = await res.json();
      const detail = runRes.details?.[0];
      if (detail && detail.success && detail.result?.pack) {
        const packName = String(detail.result.pack);
        showToast(
          'success',
          'Pack Classified',
          `${displayedAsset.name}: ${packName}`
        );
        const updatedAsset: Asset = {
          ...displayedAsset,
          metadata: {
            ...displayedAsset.metadata,
            pack: packName,
          },
          tags: [
            ...displayedAsset.tags.filter((t) => !t.startsWith('pack:')),
            ...(detail.tagsAdded || []),
          ],
        };
        if (selectedVariant) {
          setSelectedVariant(updatedAsset);
        }
        onAssetUpdated?.(updatedAsset);
      } else {
        showToast('info', 'Pack Classification', detail?.error || 'Could not classify pack');
      }
    } catch (err: any) {
      showToast('error', 'Pack Classification Error', err?.message || 'Failed to classify pack');
    } finally {
      setClassifyingPack(false);
    }
  };

  const tagsList = availableTags && availableTags.length > 0 ? availableTags : localAvailableTags;

  const currentAssetTags = displayedAsset.tags || [];
  const existingTagsLower = new Set(
    currentAssetTags.map((t) => t.replace(/^#/, '').toLowerCase())
  );

  const searchWord = newTagInput.replace(/^#/, '').trim().toLowerCase();

  const filteredSuggestions = tagsList
    .filter((t) => !existingTagsLower.has(t.name.toLowerCase()))
    .filter((t) => (searchWord ? t.name.toLowerCase().includes(searchWord) : true))
    .slice(0, 8);

  const quickSuggestions = tagsList
    .filter((t) => !existingTagsLower.has(t.name.toLowerCase()))
    .slice(0, 4);

  const handleAddSpecificTag = async (tagName: string) => {
    const clean = tagName.replace(/^#/, '').trim();
    if (!clean || !displayedAsset) return;

    const currentTags = displayedAsset.tags || [];
    if (currentTags.some((t) => t.replace(/^#/, '').toLowerCase() === clean.toLowerCase())) {
      showToast('info', 'Tag Exists', `#${clean} is already assigned to this asset`);
      return;
    }

    setIsTagSubmitting(true);
    try {
      if (applyTagsToStack && isStack && stack) {
        const res = await fetch(`/api/stacks/${stack.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag: clean }),
        });
        if (!res.ok) throw new Error('Failed to add tag to stack');
        const data = await res.json();
        showToast('success', 'Tag Added', `Added #${clean} to stack`);

        const updatedTags = Array.from(new Set([...currentTags, clean]));
        const updatedAsset = { ...displayedAsset, tags: updatedTags };
        if (selectedVariant) setSelectedVariant(updatedAsset);
        setStackAssets((prev) =>
          prev.map((a) => ({
            ...a,
            tags: Array.from(new Set([...(a.tags || []), clean])),
          }))
        );
        if (data.stack) {
          onStackUpdated?.({ ...data.stack, isStack: true });
        }
        onAssetUpdated?.(updatedAsset);
      } else {
        const res = await fetch(`/api/assets/${displayedAsset.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag: clean }),
        });
        if (!res.ok) throw new Error('Failed to add tag to asset');
        const data = await res.json();
        showToast('success', 'Tag Added', `Added #${clean}`);

        const updatedAsset: Asset = data.asset || {
          ...displayedAsset,
          tags: Array.from(new Set([...currentTags, clean])),
        };
        if (selectedVariant) setSelectedVariant(updatedAsset);
        if (isStack) {
          setStackAssets((prev) =>
            prev.map((a) => (a.id === updatedAsset.id ? updatedAsset : a))
          );
        }
        onAssetUpdated?.(updatedAsset);
      }

      setNewTagInput('');
      setIsAddingTag(false);
      setTagSuggestionsOpen(false);
    } catch (err: any) {
      showToast('error', 'Tag Error', err?.message || 'Could not add tag');
    } finally {
      setIsTagSubmitting(false);
    }
  };

  const handleAddTag = async () => {
    if (!newTagInput.trim() || !displayedAsset) return;

    const tagsToAdd = newTagInput
      .split(',')
      .map((t) => t.replace(/^#/, '').trim())
      .filter((t) => t.length > 0);

    if (tagsToAdd.length === 0) return;

    const currentTags = displayedAsset.tags || [];
    const currentLower = new Set(currentTags.map((t) => t.replace(/^#/, '').toLowerCase()));
    const uniqueToAdd = tagsToAdd.filter((t) => !currentLower.has(t.toLowerCase()));

    if (uniqueToAdd.length === 0) {
      showToast('info', 'Tags Exist', 'All entered tags are already assigned');
      return;
    }

    setIsTagSubmitting(true);
    try {
      if (applyTagsToStack && isStack && stack) {
        const res = await fetch(`/api/stacks/${stack.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: uniqueToAdd }),
        });
        if (!res.ok) throw new Error('Failed to add tags to stack');
        const data = await res.json();
        showToast('success', 'Tags Added', `Added ${uniqueToAdd.map((t) => `#${t}`).join(', ')} to stack`);

        const updatedTags = Array.from(new Set([...currentTags, ...uniqueToAdd]));
        const updatedAsset = { ...displayedAsset, tags: updatedTags };
        if (selectedVariant) setSelectedVariant(updatedAsset);
        setStackAssets((prev) =>
          prev.map((a) => ({
            ...a,
            tags: Array.from(new Set([...(a.tags || []), ...uniqueToAdd])),
          }))
        );
        if (data.stack) {
          onStackUpdated?.({ ...data.stack, isStack: true });
        }
        onAssetUpdated?.(updatedAsset);
      } else {
        const res = await fetch(`/api/assets/${displayedAsset.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: uniqueToAdd }),
        });
        if (!res.ok) throw new Error('Failed to add tags to asset');
        const data = await res.json();
        showToast('success', 'Tags Added', `Added ${uniqueToAdd.map((t) => `#${t}`).join(', ')}`);

        const updatedAsset: Asset = data.asset || {
          ...displayedAsset,
          tags: Array.from(new Set([...currentTags, ...uniqueToAdd])),
        };
        if (selectedVariant) setSelectedVariant(updatedAsset);
        if (isStack) {
          setStackAssets((prev) =>
            prev.map((a) => (a.id === updatedAsset.id ? updatedAsset : a))
          );
        }
        onAssetUpdated?.(updatedAsset);
      }

      setNewTagInput('');
      setIsAddingTag(false);
      setTagSuggestionsOpen(false);
    } catch (err: any) {
      showToast('error', 'Tag Error', err?.message || 'Could not add tags');
    } finally {
      setIsTagSubmitting(false);
    }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!displayedAsset) return;
    const cleanTag = tagToRemove.replace(/^#/, '').trim();
    setDeletingTag(tagToRemove);

    try {
      if (applyTagsToStack && isStack && stack) {
        const res = await fetch(`/api/stacks/${stack.id}/tags/${encodeURIComponent(cleanTag)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error('Failed to remove tag from stack');
        const data = await res.json();
        showToast('success', 'Tag Removed', `Removed #${cleanTag} from stack`);

        const updatedTags = (displayedAsset.tags || []).filter(
          (t) => t.replace(/^#/, '').toLowerCase() !== cleanTag.toLowerCase()
        );
        const updatedAsset = { ...displayedAsset, tags: updatedTags };
        if (selectedVariant) setSelectedVariant(updatedAsset);
        setStackAssets((prev) =>
          prev.map((a) => ({
            ...a,
            tags: (a.tags || []).filter(
              (t) => t.replace(/^#/, '').toLowerCase() !== cleanTag.toLowerCase()
            ),
          }))
        );
        if (data.stack) {
          onStackUpdated?.({ ...data.stack, isStack: true });
        }
        onAssetUpdated?.(updatedAsset);
      } else {
        const res = await fetch(`/api/assets/${displayedAsset.id}/tags/${encodeURIComponent(cleanTag)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error('Failed to remove tag from asset');
        const data = await res.json();
        showToast('success', 'Tag Removed', `Removed #${cleanTag}`);

        const updatedAsset: Asset = data.asset || {
          ...displayedAsset,
          tags: (displayedAsset.tags || []).filter(
            (t) => t.replace(/^#/, '').toLowerCase() !== cleanTag.toLowerCase()
          ),
        };
        if (selectedVariant) setSelectedVariant(updatedAsset);
        if (isStack) {
          setStackAssets((prev) =>
            prev.map((a) => (a.id === updatedAsset.id ? updatedAsset : a))
          );
        }
        onAssetUpdated?.(updatedAsset);
      }
    } catch (err: any) {
      showToast('error', 'Tag Removal Error', err?.message || 'Could not remove tag');
    } finally {
      setDeletingTag(null);
    }
  };

  return (
    <>
      <div className="w-96 shrink-0 h-full bg-[#161626] border-l border-[#26263c] flex flex-col overflow-hidden text-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#242438] bg-[#131320]">
          <div className="flex items-center gap-2 truncate">
            {isStack ? (
              <Layers className="w-4 h-4 text-indigo-400 shrink-0" />
            ) : isDisplayedImage ? (
              <ImageIcon className="w-4 h-4 text-cyan-400 shrink-0" />
            ) : displayedAsset.metadata.duration !== undefined && displayedAsset.metadata.duration <= 5 ? (
              <SoundIcon className="w-4 h-4 text-cyan-400 shrink-0" />
            ) : (
              <MusicPlateIcon className="w-4 h-4 shrink-0" />
            )}
            <span className="text-xs font-semibold text-slate-100 truncate">
              {isStack && stackViewMode === 'stack' ? stack?.name : displayedAsset.name}
            </span>
            {isStack && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-950/70 text-indigo-300 border border-indigo-500/30 shrink-0">
                {stack?.itemCount} items
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Parent stack breadcrumb link for individual asset */}
        {parentStack && (
          <div className="px-4 py-2 border-b border-[#242438] bg-indigo-950/30 flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 truncate">
              <Layers className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="text-slate-300 truncate">
                Part of: <strong className="text-white">{parentStack.name}</strong>
              </span>
            </div>
            <button
              onClick={() => onSelectStack && onSelectStack(parentStack)}
              className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium transition-colors cursor-pointer shrink-0 ml-2"
            >
              View Stack
            </button>
          </div>
        )}

        {/* Stack Mode Switcher Tabs */}
        {isStack && (
          <div className="px-4 pt-3 pb-1 border-b border-[#242438] bg-[#141423]">
            <div className="flex items-center p-1 bg-[#10101b] rounded-lg border border-[#232338] text-xs">
              <button
                onClick={() => setStackViewMode('stack')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md font-medium transition-all cursor-pointer ${
                  stackViewMode === 'stack'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#1a1a2e]'
                }`}
              >
                {stack?.type === 'animation' ? (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>Animation Controls</span>
                  </>
                ) : (
                  <>
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Audio Player</span>
                  </>
                )}
              </button>
              <button
                onClick={() => setStackViewMode('assets')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md font-medium transition-all cursor-pointer ${
                  stackViewMode === 'assets'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#1a1a2e]'
                }`}
              >
                <Grid className="w-3.5 h-3.5" />
                <span>
                  {stack?.type === 'animation' ? 'Content Frames' : 'Content Assets'} (
                  {stackAssets.length || stack?.itemCount})
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Stack View: Animation Flipbook controls */}
          {isStack && stackViewMode === 'stack' && stack?.type === 'animation' && stackAssets.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">Animation Flipbook</span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPixelated(!pixelated)}
                    title={pixelated ? 'Pixel Art: Nearest Neighbor' : 'Bilinear Filtered'}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                      pixelated
                        ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                        : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                    }`}
                  >
                    {pixelated ? 'Pixelated' : 'Smooth'}
                  </button>
                  <button
                    onClick={() => setCheckerboard(!checkerboard)}
                    title="Toggle Checkerboard Background"
                    className={`p-1 rounded border transition-colors cursor-pointer ${
                      checkerboard
                        ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                        : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                    }`}
                  >
                    <Grid className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <FlipbookPlayer
                frames={stackAssets}
                pixelated={pixelated}
                checkerboard={checkerboard}
                initialFps={settings.defaultFps}
                initialFrameIndex={selectedFrameIndex}
                selectedFrameIndex={selectedFrameIndex}
                onSelectFrame={(idx, frame) => {
                  setSelectedFrameIndex(idx);
                  setSelectedVariant(frame);
                }}
                onViewFrameSeparately={(frame, idx) => {
                  setSelectedFrameIndex(idx);
                  setSelectedVariant(frame);
                  setStackViewMode('assets');
                }}
              />
            </div>
          ) : isStack && stackViewMode === 'stack' && stack?.type === 'audio_variation' ? (
            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-300">Audio Waveform</span>
              <AudioWaveformPlayer
                asset={displayedAsset}
                variants={stackAssets}
                onSelectVariant={(v) => {
                  setSelectedVariant(v);
                  const idx = stackAssets.findIndex((a) => a.id === v.id);
                  if (idx >= 0) setSelectedFrameIndex(idx);
                }}
              />
            </div>
          ) : isStack && stackViewMode === 'assets' ? (
            /* Separate Content Assets View */
            <div className="space-y-3">
              {/* Frame navigation & carousel strip */}
              <div className="space-y-2 bg-[#12121e] p-2.5 rounded-lg border border-[#252538]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-semibold text-slate-200 shrink-0">
                      {stack?.type === 'animation' ? 'Frame' : 'Asset'} {selectedFrameIndex + 1} of{' '}
                      {stackAssets.length}
                    </span>
                    <span
                      className="text-[11px] font-mono text-indigo-300 truncate"
                      title={currentSeparateAsset.name}
                    >
                      • {currentSeparateAsset.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => {
                        const nextIdx =
                          selectedFrameIndex > 0 ? selectedFrameIndex - 1 : stackAssets.length - 1;
                        setSelectedFrameIndex(nextIdx);
                        setSelectedVariant(stackAssets[nextIdx]);
                      }}
                      title="Previous asset"
                      className="p-1 rounded bg-[#202033] hover:bg-[#2b2b44] text-slate-400 hover:text-white border border-[#2d2d46] transition-colors cursor-pointer"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        const nextIdx =
                          selectedFrameIndex + 1 < stackAssets.length ? selectedFrameIndex + 1 : 0;
                        setSelectedFrameIndex(nextIdx);
                        setSelectedVariant(stackAssets[nextIdx]);
                      }}
                      title="Next asset"
                      className="p-1 rounded bg-[#202033] hover:bg-[#2b2b44] text-slate-400 hover:text-white border border-[#2d2d46] transition-colors cursor-pointer"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Thumbnails strip */}
                <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-0.5">
                  {stackAssets.map((assetItem, index) => {
                    const isCurrent = index === selectedFrameIndex;
                    return (
                      <button
                        key={assetItem.id}
                        onClick={() => {
                          setSelectedFrameIndex(index);
                          setSelectedVariant(assetItem);
                        }}
                        className={`relative shrink-0 w-12 h-12 rounded-lg border overflow-hidden p-0.5 transition-all cursor-pointer ${
                          isCurrent
                            ? 'border-indigo-500 ring-2 ring-indigo-500/50 bg-[#25253e]'
                            : 'border-[#2d2d44] hover:border-slate-500 bg-[#161625]'
                        }`}
                        title={`${assetItem.name} (${formatBytes(assetItem.size)})`}
                      >
                        <img
                          src={assetItem.thumbnailUrl || assetItem.fileUrl}
                          alt={assetItem.name}
                          className={`w-full h-full object-contain ${
                            pixelated ? 'pixelated' : 'smooth-render'
                          }`}
                        />
                        <span className="absolute bottom-0 right-0 px-1 text-[9px] font-mono bg-black/85 text-slate-200 rounded-tl">
                          {index + 1}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Single visual or audio preview for this separate asset */}
              {isDisplayedImage ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">Asset Preview</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setZoomLevel((z) => Math.max(0.25, z - 0.25))}
                        title="Zoom Out"
                        className="p-1 rounded hover:bg-[#252538] text-slate-400 hover:text-white cursor-pointer"
                      >
                        <ZoomOut className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-[10px] font-mono text-slate-400 w-8 text-center">
                        {Math.round(zoomLevel * 100)}%
                      </span>
                      <button
                        onClick={() => setZoomLevel((z) => Math.min(4, z + 0.25))}
                        title="Zoom In"
                        className="p-1 rounded hover:bg-[#252538] text-slate-400 hover:text-white cursor-pointer"
                      >
                        <ZoomIn className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setZoomLevel(1)}
                        title="Reset Zoom"
                        className="p-1 rounded hover:bg-[#252538] text-slate-400 hover:text-white cursor-pointer"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setPixelated(!pixelated)}
                        title={pixelated ? 'Pixel Art: Nearest Neighbor' : 'Bilinear Filtered'}
                        className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                          pixelated
                            ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                            : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                        }`}
                      >
                        {pixelated ? 'Pixel' : 'Smooth'}
                      </button>
                      <button
                        onClick={() => setCheckerboard(!checkerboard)}
                        title="Toggle Checkerboard"
                        className={`p-1 rounded border transition-colors cursor-pointer ${
                          checkerboard
                            ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                            : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                        }`}
                      >
                        <Grid className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <div
                    className={`relative flex items-center justify-center rounded-lg overflow-auto border border-[#2b2b42] h-60 p-2 ${
                      checkerboard ? 'checkerboard-bg' : 'bg-[#11111d]'
                    }`}
                  >
                    <img
                      src={currentSeparateAsset.fileUrl || currentSeparateAsset.thumbnailUrl}
                      alt={currentSeparateAsset.name}
                      style={{ transform: `scale(${zoomLevel})` }}
                      className={`max-w-full max-h-full object-contain origin-center transition-transform ${
                        pixelated ? 'pixelated' : 'smooth-render'
                      }`}
                    />
                  </div>
                </div>
              ) : isDisplayedAudio ? (
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-300">Audio Preview</span>
                  <AudioWaveformPlayer asset={currentSeparateAsset} variants={[]} />
                </div>
              ) : null}
            </div>
          ) : isDisplayedImage ? (
            /* Standalone image preview */
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">Preview</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setZoomLevel((z) => Math.max(0.25, z - 0.25))}
                    title="Zoom Out"
                    className="p-1 rounded hover:bg-[#252538] text-slate-400 hover:text-white cursor-pointer"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[10px] font-mono text-slate-400 w-8 text-center">
                    {Math.round(zoomLevel * 100)}%
                  </span>
                  <button
                    onClick={() => setZoomLevel((z) => Math.min(4, z + 0.25))}
                    title="Zoom In"
                    className="p-1 rounded hover:bg-[#252538] text-slate-400 hover:text-white cursor-pointer"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setZoomLevel(1)}
                    title="Reset Zoom"
                    className="p-1 rounded hover:bg-[#252538] text-slate-400 hover:text-white cursor-pointer"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setPixelated(!pixelated)}
                    title={pixelated ? 'Pixel Art: Nearest Neighbor' : 'Bilinear Filtered'}
                    className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                      pixelated
                        ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                        : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                    }`}
                  >
                    {pixelated ? 'Pixel' : 'Smooth'}
                  </button>
                  <button
                    onClick={() => setCheckerboard(!checkerboard)}
                    title="Toggle Checkerboard"
                    className={`p-1 rounded border transition-colors cursor-pointer ${
                      checkerboard
                        ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                        : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                    }`}
                  >
                    <Grid className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div
                className={`relative flex items-center justify-center rounded-lg overflow-auto border border-[#2b2b42] h-60 p-2 ${
                  checkerboard ? 'checkerboard-bg' : 'bg-[#11111d]'
                }`}
              >
                <img
                  src={displayedAsset.fileUrl || displayedAsset.thumbnailUrl}
                  alt={displayedAsset.name}
                  style={{ transform: `scale(${zoomLevel})` }}
                  className={`max-w-full max-h-full object-contain origin-center transition-transform ${
                    pixelated ? 'pixelated' : 'smooth-render'
                  }`}
                />
              </div>
            </div>
          ) : isDisplayedAudio ? (
            /* Standalone audio waveform */
            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-300">Audio Waveform</span>
              <AudioWaveformPlayer asset={displayedAsset} variants={[]} />
            </div>
          ) : null}

          {/* Quick Action Buttons */}
          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              onClick={() => setShowCopyModal(true)}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-all cursor-pointer truncate"
            >
              <Copy className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">
                {isStack && stackViewMode === 'assets'
                  ? 'Copy Frame'
                  : isStack
                  ? 'Copy Stack'
                  : 'Copy to Project'}
              </span>
            </button>
            <button
              onClick={copyPathToClipboard}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-[#202033] hover:bg-[#2b2b44] text-slate-200 border border-[#30304a] rounded-lg text-xs font-medium transition-all cursor-pointer truncate"
            >
              <Folder className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="truncate">Copy Path</span>
            </button>
          </div>

          {/* Metadata Section */}
          <div className="space-y-3 pt-3 border-t border-[#25253c]">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {isStack ? 'Frame Metadata' : 'Asset Metadata'}
              </h4>
              {isStack && stackAssets.length > 0 && (
                <span className="text-[10px] font-mono text-indigo-400">
                  Frame {selectedFrameIndex + 1}/{stackAssets.length}
                </span>
              )}
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400">File Name</span>
                <span
                  className="font-mono text-slate-200 select-text truncate max-w-[200px]"
                  title={displayedAsset.name}
                >
                  {displayedAsset.name}
                </span>
              </div>

              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400">Format</span>
                <span className="font-mono uppercase font-semibold text-indigo-400">
                  {displayedAsset.extension.replace('.', '')}
                </span>
              </div>

              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400">File Size</span>
                <span className="font-mono text-slate-200">{formatBytes(displayedAsset.size)}</span>
              </div>

              {isDisplayedImage &&
                displayedAsset.metadata.width &&
                displayedAsset.metadata.height && (
                  <div className="flex justify-between py-1 border-b border-[#202033] items-center">
                    <span className="text-slate-400">Dimensions</span>
                    <div className="flex items-center gap-1 font-mono text-xs">
                      <button
                        onClick={() =>
                          onSelectWidth &&
                          onSelectWidth(String(displayedAsset.metadata.width))
                        }
                        title={`Filter library by width = ${displayedAsset.metadata.width}px`}
                        className="font-medium text-cyan-300 hover:text-cyan-100 hover:underline cursor-pointer"
                      >
                        {displayedAsset.metadata.width}w
                      </button>
                      <span className="text-slate-500">×</span>
                      <button
                        onClick={() =>
                          onSelectHeight &&
                          onSelectHeight(String(displayedAsset.metadata.height))
                        }
                        title={`Filter library by height = ${displayedAsset.metadata.height}px`}
                        className="font-medium text-cyan-300 hover:text-cyan-100 hover:underline cursor-pointer"
                      >
                        {displayedAsset.metadata.height}h
                      </button>
                      <button
                        onClick={() =>
                          onSelectResolution &&
                          onSelectResolution(`${displayedAsset.metadata.width}x${displayedAsset.metadata.height}`)
                        }
                        title={`Filter library by resolution ${displayedAsset.metadata.width}x${displayedAsset.metadata.height}`}
                        className="ml-1 text-[10px] text-slate-400 hover:text-slate-200 px-1 py-0.5 rounded bg-[#202033] hover:bg-[#282842] border border-[#2b2b40] cursor-pointer"
                      >
                        px
                      </button>
                    </div>
                  </div>
                )}

              {isDisplayedImage && displayedAsset.metadata.colorSpace && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Color Space</span>
                  <span className="font-mono text-slate-300">
                    {displayedAsset.metadata.colorSpace}
                  </span>
                </div>
              )}

              {isDisplayedImage && (
                <div className="flex justify-between py-1 border-b border-[#202033] items-center">
                  <span className="text-slate-400 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                    Sprite Type
                  </span>
                  <div className="flex items-center gap-1.5">
                    {displayedAsset.metadata.spriteType ? (
                      <button
                        type="button"
                        onClick={() =>
                          onSelectSprite &&
                          onSelectSprite(displayedAsset.metadata.spriteType || null)
                        }
                        title={`Filter library by sprite:${displayedAsset.metadata.spriteType}`}
                        className={`font-mono font-bold px-1.5 py-0.5 rounded text-[11px] capitalize border cursor-pointer hover:opacity-80 transition-opacity ${
                          displayedAsset.metadata.spriteType === 'character'
                            ? 'text-purple-300 bg-purple-950/40 border-purple-500/40'
                            : displayedAsset.metadata.spriteType === 'object'
                            ? 'text-amber-300 bg-amber-950/40 border-amber-500/40'
                            : displayedAsset.metadata.spriteType === 'texture'
                            ? 'text-emerald-300 bg-emerald-950/40 border-emerald-500/40'
                            : displayedAsset.metadata.spriteType === 'background'
                            ? 'text-sky-300 bg-sky-950/40 border-sky-500/40'
                            : 'text-slate-400 bg-slate-800/40 border-slate-600/40'
                        }`}
                      >
                        {displayedAsset.metadata.spriteType}
                        {displayedAsset.metadata.spriteConfidence !== undefined
                          ? ` (${Math.round(displayedAsset.metadata.spriteConfidence * 100)}%)`
                          : ''}
                      </button>
                    ) : (
                      <span className="text-slate-500 italic text-[11px]">Not classified</span>
                    )}
                    <button
                      type="button"
                      onClick={handleClassifySprite}
                      disabled={classifyingSprite}
                      className="flex items-center gap-1 px-2 py-0.5 bg-[#202035] hover:bg-purple-950/40 text-purple-300 border border-[#3b3b5c] hover:border-purple-500/50 rounded text-[10px] font-medium transition-all cursor-pointer disabled:opacity-50"
                      title="Run Sprite Classifier on this image asset"
                    >
                      {classifyingSprite ? (
                        <>
                          <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                          Classifying
                        </>
                      ) : displayedAsset.metadata.spriteType ? (
                        'Re-classify'
                      ) : (
                        'Classify'
                      )}
                    </button>
                  </div>
                </div>
              )}

              {isDisplayedAudio && displayedAsset.metadata.duration && (
                <div className="flex justify-between py-1 border-b border-[#202033] items-center">
                  <span className="text-slate-400">Duration</span>
                  <button
                    onClick={() =>
                      onSelectDuration &&
                      onSelectDuration(String(Math.round(displayedAsset.metadata.duration!)))
                    }
                    title={`Filter library by duration ≈ ${Math.round(displayedAsset.metadata.duration)}s`}
                    className="font-mono font-medium text-cyan-300 hover:text-cyan-100 hover:underline cursor-pointer"
                  >
                    {displayedAsset.metadata.duration.toFixed(2)} seconds
                  </button>
                </div>
              )}

              {isDisplayedAudio && displayedAsset.metadata.sampleRate && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Sample Rate</span>
                  <span className="font-mono text-slate-300">
                    {(displayedAsset.metadata.sampleRate / 1000).toFixed(1)} kHz
                  </span>
                </div>
              )}

              {isDisplayedAudio && displayedAsset.metadata.numberOfChannels && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Channels</span>
                  <span className="font-mono text-slate-300">
                    {displayedAsset.metadata.numberOfChannels === 1 ? 'Mono' : 'Stereo'}
                  </span>
                </div>
              )}

              {isDisplayedAudio && (
                <div className="flex justify-between py-1 border-b border-[#202033] items-center">
                  <span className="text-slate-400 flex items-center gap-1">
                    <Activity className="w-3.5 h-3.5 text-pink-400" />
                    Tempo / BPM
                  </span>
                  <div className="flex items-center gap-1.5">
                    {displayedAsset.metadata.bpm ? (
                      <button
                        type="button"
                        onClick={() =>
                          onSelectBpm &&
                          onSelectBpm(String(displayedAsset.metadata.bpm))
                        }
                        title={`Filter library by ${displayedAsset.metadata.bpm} BPM`}
                        className="font-mono font-bold text-pink-400 bg-pink-950/40 hover:bg-pink-900/60 border border-pink-500/30 hover:border-pink-500/70 px-1.5 py-0.5 rounded text-[11px] cursor-pointer transition-colors"
                      >
                        {displayedAsset.metadata.bpm} BPM
                        {displayedAsset.metadata.tempoDescription ? ` (${displayedAsset.metadata.tempoDescription})` : ''}
                      </button>
                    ) : (
                      <span className="text-slate-500 italic text-[11px]">Not analyzed</span>
                    )}
                    <button
                      type="button"
                      onClick={handleAnalyzeBpm}
                      disabled={analyzingBpm}
                      className="flex items-center gap-1 px-2 py-0.5 bg-[#202035] hover:bg-pink-950/40 text-pink-300 border border-[#3b3b5c] hover:border-pink-500/50 rounded text-[10px] font-medium transition-all cursor-pointer disabled:opacity-50"
                      title="Run BPM Classifier on this audio file"
                    >
                      {analyzingBpm ? (
                        <>
                          <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                          Analyzing
                        </>
                      ) : displayedAsset.metadata.bpm ? (
                        'Re-detect'
                      ) : (
                        'Detect BPM'
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* Asset Pack */}
              <div className="flex justify-between py-1 border-b border-[#202033] items-center">
                <span className="text-slate-400 flex items-center gap-1">
                  <Package className="w-3.5 h-3.5 text-amber-400" />
                  Asset Pack
                </span>
                <div className="flex items-center gap-1.5">
                  {displayedAsset.metadata.pack ? (
                    <span
                      title={`Pack: ${displayedAsset.metadata.pack}`}
                      className="font-mono font-bold text-amber-300 bg-amber-950/40 border border-amber-500/40 px-1.5 py-0.5 rounded text-[11px] truncate max-w-[150px]"
                    >
                      {displayedAsset.metadata.pack}
                    </span>
                  ) : (
                    <span className="text-slate-500 italic text-[11px]">Not classified</span>
                  )}
                  <button
                    type="button"
                    onClick={handleClassifyPack}
                    disabled={classifyingPack}
                    className="flex items-center gap-1 px-2 py-0.5 bg-[#202035] hover:bg-amber-950/40 text-amber-300 border border-[#3b3b5c] hover:border-amber-500/50 rounded text-[10px] font-medium transition-all cursor-pointer disabled:opacity-50"
                    title="Run Pack Classifier on this asset"
                  >
                    {classifyingPack ? (
                      <>
                        <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                        Classifying
                      </>
                    ) : displayedAsset.metadata.pack ? (
                      'Re-classify'
                    ) : (
                      'Classify'
                    )}
                  </button>
                </div>
              </div>

              {displayedAsset.isArchiveEntry && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Archive Source</span>
                  <span className="font-mono text-amber-400 truncate max-w-[180px]">
                    {displayedAsset.archivePath?.split('/').pop()}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Tags Section */}
          <div className="space-y-2.5 pt-2.5 border-t border-[#25253c]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                <Tag className="w-3.5 h-3.5 text-indigo-400" />
                <span>Tags ({displayedAsset.tags?.length || 0})</span>
              </div>

              <div className="flex items-center gap-2">
                {isStack && (
                  <label
                    className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer select-none"
                    title="Apply tag changes to all assets in this stack"
                  >
                    <input
                      type="checkbox"
                      checked={applyTagsToStack}
                      onChange={(e) => setApplyTagsToStack(e.target.checked)}
                      className="w-3 h-3 rounded bg-[#161625] border-[#2e2e48] text-indigo-600 focus:ring-0 cursor-pointer"
                    />
                    <span className="text-[10px] font-mono tracking-tight text-indigo-300">Stack</span>
                  </label>
                )}

                {!isAddingTag && (
                  <button
                    onClick={() => {
                      setIsAddingTag(true);
                      setTagSuggestionsOpen(false);
                    }}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-indigo-300 hover:text-white bg-[#1e1e32] hover:bg-indigo-600 border border-indigo-500/30 transition-colors cursor-pointer"
                    title="Add a tag to this asset"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Add Tag</span>
                  </button>
                )}
              </div>
            </div>

            {/* Tag pills list */}
            {displayedAsset.tags && displayedAsset.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {displayedAsset.tags.map((tag) => {
                  const cleanTag = tag.replace(/^#/, '');
                  const isSelected = selectedTag === cleanTag || selectedTag === `#${cleanTag}`;
                  const isDeleting = deletingTag === tag;
                  return (
                    <div
                      key={tag}
                      className={`inline-flex items-center rounded-md border text-xs transition-colors ${
                        isSelected
                          ? 'bg-indigo-600 text-white border-indigo-400 font-semibold shadow-xs ring-1 ring-indigo-400/50'
                          : 'bg-[#202035] hover:bg-[#282842] border-[#2d2d46] hover:border-indigo-500/50 text-slate-300'
                      }`}
                    >
                      <button
                        onClick={() => onTagClick && onTagClick(tag)}
                        title={`Filter by tag #${cleanTag}`}
                        className="px-2 py-0.5 cursor-pointer hover:text-white transition-colors"
                      >
                        #{cleanTag}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveTag(tag);
                        }}
                        disabled={isDeleting}
                        title={`Remove tag #${cleanTag}`}
                        className={`pr-1.5 pl-0.5 py-0.5 text-slate-400 hover:text-rose-300 hover:bg-rose-500/20 rounded-r-md transition-colors cursor-pointer disabled:opacity-50 ${
                          isSelected ? 'text-indigo-200 hover:text-white' : ''
                        }`}
                      >
                        {isDeleting ? (
                          <Loader2 className="w-3 h-3 animate-spin text-rose-400" />
                        ) : (
                          <X className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              !isAddingTag && (
                <div className="text-xs text-slate-500 italic py-0.5">
                  No tags assigned yet.
                </div>
              )
            )}

            {/* Add Tag Input Form */}
            {isAddingTag && (
              <div className="mt-1.5 p-2 bg-[#141424] border border-[#2b2b44] rounded-lg space-y-2">
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1 flex items-center">
                    <span className="absolute left-2.5 text-xs text-indigo-400 font-mono font-bold select-none">#</span>
                    <input
                      type="text"
                      ref={tagInputRef}
                      value={newTagInput}
                      onChange={(e) => {
                        setNewTagInput(e.target.value);
                        setTagSuggestionsOpen(true);
                      }}
                      onFocus={() => setTagSuggestionsOpen(true)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddTag();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setIsAddingTag(false);
                          setNewTagInput('');
                          setTagSuggestionsOpen(false);
                        }
                      }}
                      placeholder="tag-name (Enter to add)..."
                      className="w-full pl-6 pr-2 py-1 text-xs bg-[#10101b] border border-[#2b2b42] rounded-md text-slate-100 placeholder-slate-500 focus:outline-hidden focus:border-indigo-500"
                      disabled={isTagSubmitting}
                      autoFocus
                    />
                  </div>

                  <button
                    onClick={handleAddTag}
                    disabled={isTagSubmitting || !newTagInput.trim()}
                    className="px-2.5 py-1 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 transition-colors cursor-pointer flex items-center gap-1 shrink-0 shadow-xs"
                    title="Add tag"
                  >
                    {isTagSubmitting ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Check className="w-3 h-3" />
                    )}
                    <span>Add</span>
                  </button>

                  <button
                    onClick={() => {
                      setIsAddingTag(false);
                      setNewTagInput('');
                      setTagSuggestionsOpen(false);
                    }}
                    disabled={isTagSubmitting}
                    className="p-1 text-slate-400 hover:text-white rounded-md hover:bg-[#252538] transition-colors cursor-pointer"
                    title="Cancel"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Autocomplete Dropdown */}
                {tagSuggestionsOpen && filteredSuggestions.length > 0 && (
                  <div className="max-h-32 overflow-y-auto bg-[#10101b] border border-[#27273d] rounded-md p-1 space-y-0.5 shadow-lg">
                    <div className="text-[10px] font-mono text-slate-500 px-2 py-0.5 uppercase tracking-wider">
                      Matching library tags
                    </div>
                    {filteredSuggestions.map((sug) => (
                      <button
                        key={sug.name}
                        type="button"
                        onClick={() => handleAddSpecificTag(sug.name)}
                        className="w-full flex items-center justify-between px-2 py-1 rounded text-xs text-left text-slate-300 hover:text-white hover:bg-indigo-950/60 transition-colors cursor-pointer"
                      >
                        <span className="font-medium truncate">#{sug.name}</span>
                        <span className="text-[10px] font-mono text-slate-500 shrink-0">({sug.count})</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Quick Suggestion Chips */}
            {quickSuggestions.length > 0 && (
              <div className="pt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                <span className="text-[10px] text-slate-500 uppercase font-mono tracking-tight">Quick:</span>
                {quickSuggestions.map((sug) => (
                  <button
                    key={sug.name}
                    onClick={() => handleAddSpecificTag(sug.name)}
                    className="px-1.5 py-0.5 rounded bg-[#18182b] hover:bg-indigo-900/50 border border-[#2a2a44] hover:border-indigo-500/50 text-[11px] text-indigo-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1"
                    title={`Click to add #${sug.name}`}
                  >
                    <Plus className="w-2.5 h-2.5 text-indigo-400" />
                    <span>#{sug.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Filesystem Path */}
          <div className="space-y-1.5 pt-2 border-t border-[#25253c]">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Filesystem Location
            </span>
            <div className="p-2 bg-[#12121d] border border-[#28283e] rounded text-[11px] font-mono text-slate-400 break-all select-text">
              {displayedAsset.absolutePath}
            </div>
          </div>
        </div>
      </div>

      {/* Copy Modal */}
      {showCopyModal && (
        <CopyModal
          isOpen={showCopyModal}
          onClose={() => setShowCopyModal(false)}
          asset={displayedAsset}
          stack={isStack ? stack : undefined}
          targetDir={settings.activeProjectPath}
          projectPaths={settings.projectPaths}
        />
      )}
    </>
  );
}
