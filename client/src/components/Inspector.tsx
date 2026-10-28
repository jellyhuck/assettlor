import React, { lazy, Suspense, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Asset, AssetStack, AppSettings, TagInfo, LibraryInfo, type ClassifierRunResult } from '../types';
import {
  X,
  Copy,
  Folder,
  Library,
  Layers,
  Grid,
  Volume2,
  Image as ImageIcon,
  Box,
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
import { ImagePreview } from './ImagePreview';
import { ImageThumbnail } from './ImageThumbnail';
import { ModelDetails } from './ModelDetails';
import { SoundIcon, MusicPlateIcon } from './AudioIcons';
import { useToast } from './Toast';
import { directoryKey } from '../lib/settingsDraft';
import { CopyModal } from './CopyModal';
import { createRequestGate, errorMessage, isAbortError, requestJson, expectArray, expectRecord } from '../lib/requestLifecycle';
import { isBoolean, usePersistentState } from '../lib/persistentState';

// three.js is large; load it only when a model is inspected.
const ModelViewer = lazy(() => import('./ModelViewer'));

type StackItem = AssetStack & { isStack: true };
type MemberState = { key: string; phase: 'ready' | 'error'; assets: Asset[]; error: string | null };
type ParentState = { key: string; parent: StackItem | null; error: string | null };

function isAsset(value: unknown): value is Asset {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Asset).id === 'string'
    && typeof (value as Asset).name === 'string'
    && typeof (value as Asset).fileUrl === 'string'
    && typeof (value as Asset).thumbnailUrl === 'string'
    && Array.isArray((value as Asset).tags)
    && (value as Asset).metadata !== null && typeof (value as Asset).metadata === 'object';
}

function parseStack(value: unknown): StackItem {
  const data = expectRecord(value, 'stack');
  if (typeof data.id !== 'string' || typeof data.name !== 'string'
    || !['animation', 'audio_variation'].includes(String(data.type))) {
    throw new Error('The stack response has an unexpected shape');
  }
  return { ...data, isStack: true } as unknown as StackItem;
}

function parseTaggedAsset(value: unknown): Asset {
  const data = expectRecord(value, 'tag update');
  if (!isAsset(data.asset)) throw new Error('The tag update response has an unexpected shape');
  return data.asset;
}

function parseTaggedStack(value: unknown): StackItem {
  const data = expectRecord(value, 'stack tag update');
  return parseStack(data.stack);
}

function parseClassifierRun(value: unknown): ClassifierRunResult {
  const data = expectRecord(value, 'classifier');
  if (!Array.isArray(data.details) || !data.details.every((detail: unknown) =>
    detail !== null && typeof detail === 'object' && typeof (detail as { success?: unknown }).success === 'boolean')) {
    throw new Error('The classifier response has an unexpected shape');
  }
  return data as unknown as ClassifierRunResult;
}

function ClipboardButton({ text, label, successTitle, className, children }: {
  text: string;
  label: string;
  successTitle: string;
  className: string;
  children: (copied: boolean) => React.ReactNode;
}) {
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
      await navigator.clipboard.writeText(text);
      if (!active.current) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
      showToast('success', successTitle, text);
    } catch (error: unknown) {
      if (active.current) showToast('error', 'Copy Failed', errorMessage(error));
    }
  };

  return <button type="button" onClick={() => { void handleCopy(); }}
    title={copied ? 'Copied!' : label} aria-label={label} className={className}>
    {children(copied)}
  </button>;
}

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
  onSelectFolder?: (folder: string | null) => void;
  selectedFolder?: string | null;
  onSelectLibrary?: (library: string | null) => void;
  selectedLibrary?: string | null;
  libraries?: LibraryInfo[];
  onAssetUpdated?: (updatedAsset: Asset, updateSelection?: boolean) => void;
  onStackUpdated?: (updatedStack: AssetStack & { isStack: true }, updateSelection?: boolean) => void;
  availableTags?: TagInfo[];
  revision?: number;
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
  onSelectFolder,
  selectedFolder,
  onSelectLibrary,
  selectedLibrary,
  libraries,
  onAssetUpdated,
  onStackUpdated,
  availableTags,
  revision,
}: InspectorProps) {
  const { showToast } = useToast();

  const [pixelated, setPixelated] = usePersistentState('previewPixelated', true, isBoolean);
  const [checkerboard, setCheckerboard] = usePersistentState('previewCheckerboard', true, isBoolean);
  const [memberState, setMemberState] = useState<MemberState | null>(null);
  const [selectedMember, setSelectedMember] = useState<{ stackId: string; id: string } | null>(null);
  const [viewChoice, setViewChoice] = useState<{
    itemKey: string; initialViewMode: 'stack' | 'assets'; value: 'stack' | 'assets';
  } | null>(null);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [parentState, setParentState] = useState<ParentState | null>(null);
  const [pendingOperations, setPendingOperations] = useState<Array<{
    scope: { key: string }; action: string;
  }>>([]);
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagInput, setNewTagInput] = useState('');
  const [stackTagChoice, setStackTagChoice] = useState<{ stackId: string; enabled: boolean } | null>(null);
  const [tagSuggestionsOpen, setTagSuggestionsOpen] = useState(false);
  const [localAvailableTags, setLocalAvailableTags] = useState<TagInfo[]>([]);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const memberGate = useRef(createRequestGate());
  const parentGate = useRef(createRequestGate());

  const isStack = Boolean(item && 'isStack' in item && item.isStack);
  const stack = isStack ? (item as AssetStack & { isStack: true }) : null;
  const itemKey = item ? `${isStack ? 'stack' : 'asset'}:${item.id}` : '';
  const stackViewMode = viewChoice?.itemKey === itemKey
    && viewChoice.initialViewMode === initialViewMode ? viewChoice.value : initialViewMode;
  const setStackViewMode = (value: 'stack' | 'assets') =>
    setViewChoice({ itemKey, initialViewMode, value });
  const stackId = stack?.id;
  const representative = stack?.representativeAsset;
  const memberKey = stack ? [itemKey, revision ?? '', stack.itemCount,
    stack.representativeAssetId, representative?.updatedAt, representative?.fileUrl,
    representative?.thumbnailUrl].join('|') : '';
  const parentId = !isStack && item ? (item as Asset).stackId : null;
  const parentKey = parentId ? `${itemKey}|${parentId}|${revision ?? ''}` : '';
  const stackAssets = memberState?.key === memberKey ? memberState.assets : [];
  const memberPhase = !stack ? null : memberState?.key === memberKey ? memberState.phase : 'loading';
  const memberError = memberState?.key === memberKey ? memberState.error : null;
  const selectedFrameIndex = stackAssets.findIndex((asset) =>
    asset.id === (selectedMember && selectedMember.stackId === stack?.id
      ? selectedMember.id : stack?.representativeAssetId));
  const currentFrameIndex = selectedFrameIndex >= 0 ? selectedFrameIndex : 0;
  const selectedVariant = stackAssets[currentFrameIndex] ?? null;
  const currentAssetId = !isStack ? item?.id ?? '' : selectedVariant?.id ?? representative?.id ?? '';
  const mutationKey = `${itemKey}|${currentAssetId}|${revision ?? ''}`;
  const mutationScopeRef = useRef<{ key: string }>({ key: '' });
  useLayoutEffect(() => { mutationScopeRef.current = { key: mutationKey }; }, [mutationKey]);
  const isCurrentScope = (scope: { key: string }) => mutationScopeRef.current === scope;
  const isPending = (action: string) => pendingOperations.some((entry) =>
    entry.scope.key === mutationKey && entry.action === action);
  const setPending = (scope: { key: string }, action: string, pending: boolean) => {
    setPendingOperations((previous) => pending
      ? [...previous, { scope, action }]
      : previous.filter((entry) => entry.scope !== scope || entry.action !== action));
  };
  const analyzingBpm = isPending('bpm');
  const classifyingSprite = isPending('sprite');
  const classifyingPack = isPending('pack');
  const classifyingFolders = isPending('folder');
  const isTagSubmitting = isPending('tag-add');
  const applyTagsToStack = Boolean(stack && stackTagChoice?.stackId === stack.id && stackTagChoice.enabled);
  const parentStack = parentState?.key === parentKey ? parentState.parent : null;
  const parentError = parentState?.key === parentKey ? parentState.error : null;

  const selectMember = (asset: Asset) => {
    if (stack) setSelectedMember({ stackId: stack.id, id: asset.id });
  };

  const updateMember = (asset: Asset) => {
    setMemberState((previous) => previous?.key === memberKey
      ? { ...previous, assets: previous.assets.map((member) => member.id === asset.id ? asset : member) }
      : previous);
  };

  // Member responses are keyed to the current stack revision, including a same-ID refresh.
  useEffect(() => {
    const gate = memberGate.current;
    if (!stackId) {
      gate.invalidate();
      return;
    }
    const request = gate.begin(memberKey);
    requestJson(`/api/stacks/${encodeURIComponent(stackId)}/assets`,
      (value) => expectArray(value, isAsset, 'stack members'), { signal: request.signal })
      .then((assets) => {
        if (request.isCurrent(memberKey)) {
          setMemberState({ key: memberKey, phase: 'ready', assets, error: null });
        }
      })
      .catch((error: unknown) => {
        if (request.isCurrent(memberKey) && !isAbortError(error)) {
          setMemberState({ key: memberKey, phase: 'error', assets: [], error: errorMessage(error) });
        }
      });
    return () => gate.invalidate();
  }, [memberKey, stackId]);

  // If item is an individual asset that has a stackId, fetch its parent stack details
  useEffect(() => {
    const gate = parentGate.current;
    if (!parentId) {
      gate.invalidate();
      return;
    }
    const request = gate.begin(parentKey);
    requestJson(`/api/stacks/${encodeURIComponent(parentId)}`, parseStack, { signal: request.signal })
      .then((parent) => {
        if (request.isCurrent(parentKey)) setParentState({ key: parentKey, parent, error: null });
      })
      .catch((error: unknown) => {
        if (request.isCurrent(parentKey) && !isAbortError(error)) {
          setParentState({ key: parentKey, parent: null, error: errorMessage(error) });
        }
      });
    return () => gate.invalidate();
  }, [parentId, parentKey]);

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
      ? stackAssets[currentFrameIndex]
      : selectedVariant || stack?.representativeAsset || (item as Asset);

  // Asset to display in metadata section and single preview
  const displayedAsset =
    !isStack
      ? (item as Asset)
      : currentSeparateAsset || selectedVariant || stack?.representativeAsset;

  if (!displayedAsset) {
    return <div className="p-4 text-xs text-slate-300" role="status">
      {memberPhase === 'error' ? `Stack members unavailable: ${memberError}`
        : memberPhase === 'ready' ? 'This stack has no available preview.'
        : 'Loading preview…'}
    </div>;
  }

  const isDisplayedImage = displayedAsset.category === 'image';
  const isDisplayedAudio = displayedAsset.category === 'audio';
  const isDisplayedModel = displayedAsset.category === 'model';
  const displayedName = isStack && stackViewMode === 'stack' ? stack?.name || displayedAsset.name : displayedAsset.name;
  const archiveFilePath = displayedAsset.archivePath || displayedAsset.absolutePath;
  const archiveMemberPath = displayedAsset.archiveEntryPath
    || displayedAsset.path.split('#/')[1] || displayedAsset.path;
  const locationToCopy = displayedAsset.isArchiveEntry
    ? `${archiveFilePath}#/${archiveMemberPath.replace(/^\//, '')}`
    : displayedAsset.absolutePath;

  const formatBytes = (bytes?: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const handleRunClassifier = async (kind: 'bpm' | 'sprite' | 'pack' | 'folder') => {
    const target = displayedAsset;
    if ((kind === 'bpm' && target.category !== 'audio')
      || (kind === 'sprite' && target.category !== 'image') || isPending(kind)) return;
    const scope = mutationScopeRef.current;
    const title = kind === 'bpm' ? 'BPM Analysis' : kind === 'sprite' ? 'Sprite Classification'
      : kind === 'pack' ? 'Pack Classification' : 'Folder Classification';
    setPending(scope, kind, true);
    try {
      const run = await requestJson(`/api/classifiers/${kind}/run`, parseClassifierRun, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType: 'asset', targetValue: target.id }),
      });
      const detail = run.details.find((entry) => entry.assetId === target.id) ?? run.details[0];
      if (!detail) throw new Error('The classifier returned no result for this asset');
      // Classification can also clear obsolete metadata/tags on a no-result run.
      // Read the persisted asset instead of synthesizing a partial result here.
      const updated = await requestJson(`/api/assets/${encodeURIComponent(target.id)}`,
        (value) => {
          if (!isAsset(value)) throw new Error('The asset response has an unexpected shape');
          return value;
        });
      const current = isCurrentScope(scope);
      if (current) updateMember(updated);
      onAssetUpdated?.(updated, current);
      if (detail.success && current) {
        const description = kind === 'bpm'
          ? `${target.name}: ${detail.result?.bpm ?? 'detected'} BPM`
          : kind === 'sprite'
            ? `${target.name}: ${detail.result?.spriteType ?? 'classified'}`
            : kind === 'pack'
              ? `${target.name}: ${detail.result?.pack ?? 'classified'}`
              : `${target.name}: ${Array.isArray(detail.result?.folders)
                ? detail.result.folders.join(' / ') : 'classified'}`;
        showToast('success', title, description);
      } else if (detail.outcome === 'error') {
        showToast('error', `${title} Error`, `${target.name}: ${detail.error || 'Classification failed'}`);
      } else if (current) {
        showToast('info', title, `${target.name}: ${detail.error || 'No result found'}`);
      }
    } catch (error: unknown) {
      showToast('error', `${title} Error`, `${target.name}: ${errorMessage(error)}`);
    } finally {
      setPending(scope, kind, false);
    }
  };

  const handleAnalyzeBpm = () => { void handleRunClassifier('bpm'); };
  const handleClassifySprite = () => { void handleRunClassifier('sprite'); };
  const handleClassifyPack = () => { void handleRunClassifier('pack'); };
  const handleClassifyFolders = () => { void handleRunClassifier('folder'); };

  const sourceKey = displayedAsset.sourceDirectory ? directoryKey(displayedAsset.sourceDirectory) : null;
  const assetLibraries = sourceKey
    ? (libraries ?? []).filter((library) => library.paths.some((libraryPath) => directoryKey(libraryPath) === sourceKey))
    : [];

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

  const addTags = async (rawTags: string[]) => {
    const target = displayedAsset;
    const scope = mutationScopeRef.current;
    if (isPending('tag-add')) return;
    const currentTags = target.tags || [];
    const existing = new Set(currentTags.map((tag) => tag.replace(/^#/, '').toLowerCase()));
    const uniqueToAdd = Array.from(new Set(rawTags.map((tag) => tag.replace(/^#/, '').trim())
      .filter((tag) => tag.length > 0 && !existing.has(tag.toLowerCase()))));
    if (uniqueToAdd.length === 0) {
      showToast('info', 'Tags Exist', 'All entered tags are already assigned');
      return;
    }
    const stackTarget = applyTagsToStack ? stack : null;
    setPending(scope, 'tag-add', true);
    try {
      if (stackTarget) {
        const updatedStack = await requestJson(`/api/stacks/${encodeURIComponent(stackTarget.id)}/tags`,
          parseTaggedStack, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: uniqueToAdd }),
          });
        const current = isCurrentScope(scope);
        if (current) {
          setMemberState((previous) => previous?.key === memberKey ? { ...previous,
            assets: previous.assets.map((member) => ({ ...member,
              tags: Array.from(new Set([...(member.tags || []), ...uniqueToAdd])) })),
          } : previous);
        }
        onStackUpdated?.(updatedStack, current);
      } else {
        const updatedAsset = await requestJson(`/api/assets/${encodeURIComponent(target.id)}/tags`,
          parseTaggedAsset, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: uniqueToAdd }),
          });
        const current = isCurrentScope(scope);
        if (current) updateMember(updatedAsset);
        onAssetUpdated?.(updatedAsset, current);
      }
      if (isCurrentScope(scope)) {
        setNewTagInput('');
        setIsAddingTag(false);
        setTagSuggestionsOpen(false);
      }
      if (isCurrentScope(scope)) {
        showToast('success', uniqueToAdd.length === 1 ? 'Tag Added' : 'Tags Added',
          `${target.name}: ${uniqueToAdd.map((tag) => `#${tag}`).join(', ')}`);
      }
    } catch (error: unknown) {
      showToast('error', 'Tag Error', `${target.name}: ${errorMessage(error)}`);
    } finally {
      setPending(scope, 'tag-add', false);
    }
  };

  const handleAddSpecificTag = (tagName: string) => { void addTags([tagName]); };
  const handleAddTag = () => { void addTags(newTagInput.split(',')); };

  const handleRemoveTag = async (tagToRemove: string) => {
    const target = displayedAsset;
    const cleanTag = tagToRemove.replace(/^#/, '').trim();
    const action = `tag-remove:${cleanTag.toLowerCase()}`;
    if (!cleanTag || isPending(action)) return;
    const scope = mutationScopeRef.current;
    const stackTarget = applyTagsToStack ? stack : null;
    setPending(scope, action, true);
    try {
      if (stackTarget) {
        const updatedStack = await requestJson(
          `/api/stacks/${encodeURIComponent(stackTarget.id)}/tags/${encodeURIComponent(cleanTag)}`,
          parseTaggedStack, { method: 'DELETE' });
        const current = isCurrentScope(scope);
        if (current) {
          setMemberState((previous) => previous?.key === memberKey ? { ...previous,
            assets: previous.assets.map((member) => ({ ...member,
              tags: (member.tags || []).filter((tag) =>
                tag.replace(/^#/, '').toLowerCase() !== cleanTag.toLowerCase()) })),
          } : previous);
        }
        onStackUpdated?.(updatedStack, current);
      } else {
        const updatedAsset = await requestJson(
          `/api/assets/${encodeURIComponent(target.id)}/tags/${encodeURIComponent(cleanTag)}`,
          parseTaggedAsset, { method: 'DELETE' });
        const current = isCurrentScope(scope);
        if (current) updateMember(updatedAsset);
        onAssetUpdated?.(updatedAsset, current);
      }
      if (isCurrentScope(scope)) showToast('success', 'Tag Removed', `${target.name}: #${cleanTag}`);
    } catch (error: unknown) {
      showToast('error', 'Tag Removal Error', `${target.name}: ${errorMessage(error)}`);
    } finally {
      setPending(scope, action, false);
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
            ) : isDisplayedModel ? (
              <Box className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : displayedAsset.metadata.duration !== undefined && displayedAsset.metadata.duration <= 5 ? (
              <SoundIcon className="w-4 h-4 text-cyan-400 shrink-0" />
            ) : (
              <MusicPlateIcon className="w-4 h-4 shrink-0" />
            )}
            <span className="text-xs font-semibold text-slate-100 truncate">{displayedName}</span>
            <ClipboardButton
              key={`${itemKey}|${revision ?? ''}|name|${displayedName}`}
              text={displayedName}
              label="Copy name to clipboard"
              successTitle="File Name Copied"
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer shrink-0"
            >
              {(copied) => copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </ClipboardButton>
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
        {parentId && parentError && (
          <div className="px-4 py-2 text-xs text-amber-300" role="status">
            Parent stack unavailable: {parentError}
          </div>
        )}
        {parentId && !parentStack && !parentError && (
          <div className="px-4 py-2 text-xs text-slate-400" role="status">Loading parent stack…</div>
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
          {isStack && memberPhase === 'loading' ? (
            <div role="status" className="text-xs text-slate-400">Loading stack members…</div>
          ) : isStack && memberPhase === 'error' ? (
            <div role="alert" className="text-xs text-rose-300">Stack members unavailable: {memberError}</div>
          ) : isStack && stackAssets.length === 0 ? (
            <div role="status" className="text-xs text-slate-400">This stack has no available members.</div>
          ) : null}
          {/* Stack View: Animation Flipbook controls */}
          {isStack && stackAssets.length === 0 ? null : isStack && stackViewMode === 'stack' && stack?.type === 'animation' ? (
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
                initialFrameIndex={currentFrameIndex}
                selectedFrameIndex={currentFrameIndex}
                onSelectFrame={(_idx, frame) => {
                  selectMember(frame);
                }}
                onViewFrameSeparately={(frame) => {
                  selectMember(frame);
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
                  selectMember(v);
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
                      {stack?.type === 'animation' ? 'Frame' : 'Asset'} {currentFrameIndex + 1} of{' '}
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
                          currentFrameIndex > 0 ? currentFrameIndex - 1 : stackAssets.length - 1;
                        selectMember(stackAssets[nextIdx]);
                      }}
                      title="Previous asset"
                      className="p-1 rounded bg-[#202033] hover:bg-[#2b2b44] text-slate-400 hover:text-white border border-[#2d2d46] transition-colors cursor-pointer"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        const nextIdx =
                          currentFrameIndex + 1 < stackAssets.length ? currentFrameIndex + 1 : 0;
                        selectMember(stackAssets[nextIdx]);
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
                    const isCurrent = index === currentFrameIndex;
                    return (
                      <button
                        key={assetItem.id}
                        onClick={() => {
                          selectMember(assetItem);
                        }}
                        className={`relative shrink-0 w-12 h-12 rounded-lg border overflow-hidden p-0.5 transition-all cursor-pointer ${
                          isCurrent
                            ? 'border-indigo-500 ring-2 ring-indigo-500/50 bg-[#25253e]'
                            : 'border-[#2d2d44] hover:border-slate-500 bg-[#161625]'
                        }`}
                        title={`${assetItem.name} (${formatBytes(assetItem.size)})`}
                      >
                        <ImageThumbnail
                          asset={assetItem}
                          pixelated={pixelated}
                          revision={revision}
                          className="w-full h-full object-contain"
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
                <ImagePreview
                  asset={currentSeparateAsset}
                  pixelated={pixelated}
                  checkerboard={checkerboard}
                  onPixelatedChange={setPixelated}
                  onCheckerboardChange={setCheckerboard}
                  revision={revision}
                  title="Asset Preview"
                />
              ) : isDisplayedAudio ? (
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-300">Audio Preview</span>
                  <AudioWaveformPlayer asset={currentSeparateAsset} variants={[]} />
                </div>
              ) : null}
            </div>
          ) : isDisplayedImage ? (
            /* Standalone image preview */
            <ImagePreview
              asset={displayedAsset}
              pixelated={pixelated}
              checkerboard={checkerboard}
              onPixelatedChange={setPixelated}
              onCheckerboardChange={setCheckerboard}
              revision={revision}
            />
          ) : isDisplayedAudio ? (
            /* Standalone audio waveform */
            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-300">Audio Waveform</span>
              <AudioWaveformPlayer asset={displayedAsset} variants={[]} />
            </div>
          ) : isDisplayedModel ? (
            /* Standalone 3D model viewer */
            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-300">3D Preview</span>
              <Suspense fallback={
                <div role="status" className="flex h-64 items-center justify-center gap-2 rounded-lg border border-[#2b2b44] bg-[#11111d] text-xs text-indigo-300">
                  <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                  Loading 3D viewer…
                </div>
              }>
                <ModelViewer asset={displayedAsset} revision={revision} />
              </Suspense>
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
            <ClipboardButton
              key={`${itemKey}|${revision ?? ''}|location|${locationToCopy}`}
              text={locationToCopy}
              label={displayedAsset.isArchiveEntry ? 'Copy archive member location' : 'Copy file path'}
              successTitle={displayedAsset.isArchiveEntry ? 'Member Location Copied' : 'Path Copied'}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-[#202033] hover:bg-[#2b2b44] text-slate-200 border border-[#30304a] rounded-lg text-xs font-medium transition-all cursor-pointer truncate"
            >
              {() => <><Folder className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="truncate">{displayedAsset.isArchiveEntry ? 'Copy Member Location' : 'Copy Path'}</span></>}
            </ClipboardButton>
          </div>

          {/* Metadata Section */}
          <div className="space-y-3 pt-3 border-t border-[#25253c] select-text">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider select-text">
                {isStack ? 'Frame Metadata' : 'Asset Metadata'}
              </h4>
              {isStack && stackAssets.length > 0 && (
                <span className="text-[10px] font-mono text-indigo-400 select-text">
                  Frame {currentFrameIndex + 1}/{stackAssets.length}
                </span>
              )}
            </div>
            <div className="space-y-2 text-xs select-text">
              <div className="flex items-center justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400 select-text">File Name</span>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="font-mono text-slate-200 select-text truncate max-w-[190px]"
                    title={displayedAsset.name}
                  >
                    {displayedAsset.name}
                  </span>
                  <ClipboardButton
                    key={`${itemKey}|${revision ?? ''}|file-name|${displayedAsset.name}`}
                    text={displayedAsset.name}
                    label="Copy file name to clipboard"
                    successTitle="File Name Copied"
                    className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer shrink-0"
                  >
                    {(copied) => copied ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </ClipboardButton>
                </div>
              </div>

              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400 select-text">Format</span>
                <span className="font-mono uppercase font-semibold text-indigo-400 select-text">
                  {displayedAsset.extension.replace('.', '')}
                </span>
              </div>

              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400 select-text">File Size</span>
                <span className="font-mono text-slate-200 select-text">{formatBytes(displayedAsset.size)}</span>
              </div>

              {isDisplayedImage &&
                displayedAsset.metadata.width &&
                displayedAsset.metadata.height && (
                  <div className="flex justify-between py-1 border-b border-[#202033] items-center">
                    <span className="text-slate-400 select-text">Dimensions</span>
                    <div className="flex items-center gap-1 font-mono text-xs select-text">
                      <button
                        onClick={() =>
                          onSelectWidth &&
                          onSelectWidth(String(displayedAsset.metadata.width))
                        }
                        title={`Filter library by width = ${displayedAsset.metadata.width}px`}
                        className="font-medium text-cyan-300 hover:text-cyan-100 hover:underline cursor-pointer select-text"
                      >
                        {displayedAsset.metadata.width}w
                      </button>
                      <span className="text-slate-500 select-text">×</span>
                      <button
                        onClick={() =>
                          onSelectHeight &&
                          onSelectHeight(String(displayedAsset.metadata.height))
                        }
                        title={`Filter library by height = ${displayedAsset.metadata.height}px`}
                        className="font-medium text-cyan-300 hover:text-cyan-100 hover:underline cursor-pointer select-text"
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
                  <span className="text-slate-400 select-text">Color Space</span>
                  <span className="font-mono text-slate-300 select-text">
                    {displayedAsset.metadata.colorSpace}
                  </span>
                </div>
              )}

              {isDisplayedImage && (
                <div className="flex justify-between py-1 border-b border-[#202033] items-center">
                  <span className="text-slate-400 flex items-center gap-1 select-text">
                    <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                    Sprite Type
                  </span>
                  <div className="flex items-center gap-1.5 select-text">
                    {displayedAsset.metadata.spriteType ? (
                      <button
                        type="button"
                        onClick={() =>
                          onSelectSprite &&
                          onSelectSprite(displayedAsset.metadata.spriteType || null)
                        }
                        title={`Filter library by sprite:${displayedAsset.metadata.spriteType}`}
                        className={`font-mono font-bold px-1.5 py-0.5 rounded text-[11px] capitalize border cursor-pointer hover:opacity-80 transition-opacity select-text ${
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
                      <span className="text-slate-500 italic text-[11px] select-text">Not classified</span>
                    )}
                    <button
                      type="button"
                      onClick={handleClassifySprite}
                      disabled={classifyingSprite}
                      className="flex items-center gap-1 px-2 py-0.5 bg-[#202035] hover:bg-purple-950/40 text-purple-300 border border-[#3b3b5c] hover:border-purple-500/50 rounded text-[10px] font-medium transition-all cursor-pointer disabled:opacity-50 select-none"
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
                  <span className="text-slate-400 select-text">Duration</span>
                  <button
                    onClick={() =>
                      onSelectDuration &&
                      onSelectDuration(String(Math.round(displayedAsset.metadata.duration!)))
                    }
                    title={`Filter library by duration ≈ ${Math.round(displayedAsset.metadata.duration)}s`}
                    className="font-mono font-medium text-cyan-300 hover:text-cyan-100 hover:underline cursor-pointer select-text"
                  >
                    {displayedAsset.metadata.duration.toFixed(2)} seconds
                  </button>
                </div>
              )}

              {isDisplayedAudio && displayedAsset.metadata.sampleRate && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400 select-text">Sample Rate</span>
                  <span className="font-mono text-slate-300 select-text">
                    {(displayedAsset.metadata.sampleRate / 1000).toFixed(1)} kHz
                  </span>
                </div>
              )}

              {isDisplayedAudio && displayedAsset.metadata.numberOfChannels && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400 select-text">Channels</span>
                  <span className="font-mono text-slate-300 select-text">
                    {displayedAsset.metadata.numberOfChannels === 1 ? 'Mono' : 'Stereo'}
                  </span>
                </div>
              )}

              {isDisplayedAudio && (
                <div className="flex justify-between py-1 border-b border-[#202033] items-center">
                  <span className="text-slate-400 flex items-center gap-1 select-text">
                    <Activity className="w-3.5 h-3.5 text-pink-400" />
                    Tempo / BPM
                  </span>
                  <div className="flex items-center gap-1.5 select-text">
                    {displayedAsset.metadata.bpm ? (
                      <button
                        type="button"
                        onClick={() =>
                          onSelectBpm &&
                          onSelectBpm(String(displayedAsset.metadata.bpm))
                        }
                        title={`Filter library by ${displayedAsset.metadata.bpm} BPM`}
                        className="font-mono font-bold text-pink-400 bg-pink-950/40 hover:bg-pink-900/60 border border-pink-500/30 hover:border-pink-500/70 px-1.5 py-0.5 rounded text-[11px] cursor-pointer transition-colors select-text"
                      >
                        {displayedAsset.metadata.bpm} BPM
                        {displayedAsset.metadata.tempoDescription ? ` (${displayedAsset.metadata.tempoDescription})` : ''}
                      </button>
                    ) : (
                      <span className="text-slate-500 italic text-[11px] select-text">Not analyzed</span>
                    )}
                    <button
                      type="button"
                      onClick={handleAnalyzeBpm}
                      disabled={analyzingBpm}
                      className="flex items-center gap-1 px-2 py-0.5 bg-[#202035] hover:bg-pink-950/40 text-pink-300 border border-[#3b3b5c] hover:border-pink-500/50 rounded text-[10px] font-medium transition-all cursor-pointer disabled:opacity-50 select-none"
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

              {isDisplayedModel && <ModelDetails asset={displayedAsset} />}

              {/* Asset Pack */}
              <div className="flex justify-between py-1 border-b border-[#202033] items-center">
                <span className="text-slate-400 flex items-center gap-1 select-text">
                  <Package className="w-3.5 h-3.5 text-amber-400" />
                  Asset Pack
                </span>
                <div className="flex items-center gap-1.5 select-text">
                  {displayedAsset.metadata.pack ? (
                    <span
                      title={`Pack: ${displayedAsset.metadata.pack}`}
                      className="font-mono font-bold text-amber-300 bg-amber-950/40 border border-amber-500/40 px-1.5 py-0.5 rounded text-[11px] truncate max-w-[150px] select-text"
                    >
                      {displayedAsset.metadata.pack}
                    </span>
                  ) : (
                    <span className="text-slate-500 italic text-[11px] select-text">Not classified</span>
                  )}
                  <button
                    type="button"
                    onClick={handleClassifyPack}
                    disabled={classifyingPack}
                    className="flex items-center gap-1 px-2 py-0.5 bg-[#202035] hover:bg-amber-950/40 text-amber-300 border border-[#3b3b5c] hover:border-amber-500/50 rounded text-[10px] font-medium transition-all cursor-pointer disabled:opacity-50 select-none"
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

              {/* Library */}
              {assetLibraries.length > 0 && (
                <div className="flex justify-between gap-2 py-1 border-b border-[#202033] items-start">
                  <span className="text-slate-400 flex items-center gap-1 select-text shrink-0 pt-0.5">
                    <Library className="w-3.5 h-3.5 text-emerald-400" />
                    Library
                  </span>
                  <div className="flex flex-wrap justify-end items-center gap-1 select-text min-w-0">
                    {assetLibraries.map((library) => {
                      const isSelected = selectedLibrary?.toLowerCase() === library.name.toLowerCase();
                      return (
                        <button
                          key={library.name}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => onSelectLibrary?.(library.name)}
                          disabled={!onSelectLibrary}
                          title={`Filter library by lib:${library.name}`}
                          className={`px-1.5 py-0.5 rounded text-[11px] border truncate max-w-[150px] transition-colors cursor-pointer disabled:cursor-default ${
                            isSelected
                              ? 'bg-emerald-700/80 border-emerald-400 text-white font-semibold'
                              : 'text-emerald-300 bg-emerald-950/40 border-emerald-500/40 hover:border-emerald-400'
                          }`}
                        >
                          {library.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Folders */}
              <div className="flex justify-between gap-2 py-1 border-b border-[#202033] items-start">
                <span className="text-slate-400 flex items-center gap-1 select-text shrink-0 pt-0.5">
                  <Folder className="w-3.5 h-3.5 text-cyan-400" />
                  Folders
                </span>
                <div className="flex flex-wrap justify-end items-center gap-1 select-text min-w-0">
                  {displayedAsset.metadata.folders?.length ? (
                    displayedAsset.metadata.folders.map((folder) => {
                      const isSelected = selectedFolder?.toLowerCase() === folder.toLowerCase();
                      return (
                        <button
                          key={folder}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => onSelectFolder?.(folder)}
                          disabled={!onSelectFolder}
                          title={`Filter library by folder:${folder}`}
                          className={`font-mono px-1.5 py-0.5 rounded text-[11px] border truncate max-w-[150px] transition-colors cursor-pointer disabled:cursor-default ${
                            isSelected
                              ? 'bg-cyan-700/80 border-cyan-400 text-white font-semibold'
                              : 'text-cyan-300 bg-cyan-950/40 border-cyan-500/40 hover:border-cyan-400'
                          }`}
                        >
                          {folder}
                        </button>
                      );
                    })
                  ) : (
                    <span className="text-slate-500 italic text-[11px] select-text">Not classified</span>
                  )}
                  <button
                    type="button"
                    onClick={handleClassifyFolders}
                    disabled={classifyingFolders}
                    className="flex items-center gap-1 px-2 py-0.5 bg-[#202035] hover:bg-cyan-950/40 text-cyan-300 border border-[#3b3b5c] hover:border-cyan-500/50 rounded text-[10px] font-medium transition-all cursor-pointer disabled:opacity-50 select-none"
                    title="Run Folder Classifier on this asset"
                  >
                    {classifyingFolders ? (
                      <>
                        <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                        Classifying
                      </>
                    ) : displayedAsset.metadata.folders?.length ? (
                      'Re-classify'
                    ) : (
                      'Classify'
                    )}
                  </button>
                </div>
              </div>

              {displayedAsset.isArchiveEntry && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400 select-text">Archive Source</span>
                  <span className="font-mono text-amber-400 truncate max-w-[180px] select-text">
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
                      onChange={(e) => stack && setStackTagChoice({ stackId: stack.id, enabled: e.target.checked })}
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
                  const isDeleting = isPending(`tag-remove:${cleanTag.toLowerCase()}`);
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

          {/* Filesystem and virtual archive locations */}
          <div className="space-y-1.5 pt-2 border-t border-[#25253c]">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              {displayedAsset.isArchiveEntry ? 'Archive File' : 'Filesystem Location'}
            </span>
            <div className="p-2 bg-[#12121d] border border-[#28283e] rounded text-[11px] font-mono text-slate-400 break-all select-text">
              {archiveFilePath}
            </div>
            {displayedAsset.isArchiveEntry && <>
              <span className="block text-xs font-semibold text-slate-400 uppercase tracking-wider pt-1">
                Member in Archive
              </span>
              <div className="p-2 bg-[#12121d] border border-[#28283e] rounded text-[11px] font-mono text-slate-400 break-all select-text">
                {archiveMemberPath}
              </div>
            </>}
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
