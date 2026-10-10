import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ClassifierInfo,
  ClassifierTargetType,
  ClassifierRunResult,
  Asset,
} from '../types';
import {
  Sparkles,
  X,
  Play,
  CheckCircle2,
  AlertCircle,
  Music,
  Image as ImageIcon,
  Package,
  RefreshCw,
  Sliders,
} from 'lucide-react';
import { useToast } from './Toast';
import {
  parseClassifiers,
  parseRunResult,
  parseTargetInventory,
  resolveTargetSelection,
  type AssetTargetChoice,
  type ClassifierTargetInventory,
  type LoadState,
} from './classifierModalData';
import { createRequestGate, errorMessage, requestJson, type RequestGate } from '../lib/requestLifecycle';
import { bindDialogFocus, isBackdropPress } from '../lib/dialogFocus';

interface ClassifierModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedAsset?: Asset | null;
  onRunComplete?: () => void;
}

export function ClassifierModal({
  isOpen,
  onClose,
  selectedAsset,
  onRunComplete,
}: ClassifierModalProps) {
  const onRunCompleteRef = useRef(onRunComplete);
  useEffect(() => { onRunCompleteRef.current = onRunComplete; }, [onRunComplete]);
  const notifyRunComplete = useCallback(() => { onRunCompleteRef.current?.(); }, []);

  if (!isOpen) return null;
  return (
    <ClassifierDialog
      onClose={onClose}
      selectedAsset={selectedAsset}
      onRunComplete={notifyRunComplete}
    />
  );
}

function ClassifierDialog({ onClose, selectedAsset, onRunComplete }: Omit<ClassifierModalProps, 'isOpen'>) {
  const { showToast } = useToast();
  const [classifiers, setClassifiers] = useState<ClassifierInfo[]>([]);
  const [classifierLoadState, setClassifierLoadState] = useState<LoadState>('loading');
  const [classifierError, setClassifierError] = useState<string>('');
  const [inventory, setInventory] = useState<ClassifierTargetInventory | null>(null);
  const [inventoryLoadState, setInventoryLoadState] = useState<LoadState>('loading');
  const [inventoryError, setInventoryError] = useState<string>('');
  const [selectedClassifierId, setSelectedClassifierId] = useState<string>('bpm');
  const [targetType, setTargetType] = useState<ClassifierTargetType>(selectedAsset ? 'asset' : 'all');
  const [targetValue, setTargetValue] = useState<string>(selectedAsset?.id ?? '');
  const [running, setRunning] = useState<boolean>(false);
  const [runResult, setRunResult] = useState<ClassifierRunResult | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(true);
  const runningRef = useRef(false);
  const runGateRef = useRef<RequestGate | null>(null);
  const selectionRevisionRef = useRef(0);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const handleClose = useCallback(() => {
    activeRef.current = false;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    activeRef.current = true;
    const classifiersGate = createRequestGate();
    const inventoryGate = createRequestGate();
    const runGate = createRequestGate();
    runGateRef.current = runGate;

    async function loadClassifiers() {
      const request = classifiersGate.begin();
      try {
        const data = await requestJson('/api/classifiers', parseClassifiers, { signal: request.signal });
        if (!activeRef.current || !request.isCurrent()) return;
        setClassifiers(data);
        setSelectedClassifierId((current) => data.some((item) => item.id === current)
          ? current : (data[0]?.id ?? ''));
        setClassifierLoadState('ready');
      } catch (error) {
        if (!activeRef.current || !request.isCurrent()) return;
        setClassifierError(errorMessage(error));
        setClassifierLoadState('error');
      }
    }

    async function loadInventory() {
      const request = inventoryGate.begin();
      try {
        const data = await requestJson('/api/classifiers/targets', parseTargetInventory, { signal: request.signal });
        if (!activeRef.current || !request.isCurrent()) return;
        setInventory(data);
        setInventoryLoadState('ready');
      } catch (error) {
        if (!activeRef.current || !request.isCurrent()) return;
        setInventoryError(errorMessage(error));
        setInventoryLoadState('error');
      }
    }

    void loadClassifiers();
    void loadInventory();
    return () => {
      activeRef.current = false;
      classifiersGate.dispose();
      inventoryGate.dispose();
      if (runGateRef.current === runGate) runGateRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!dialogRef.current) return;
    return bindDialogFocus(dialogRef.current, closeButtonRef.current, handleClose);
  }, [handleClose]);

  const currentClassifier = classifiers.find((classifier) => classifier.id === selectedClassifierId);
  const selection = resolveTargetSelection(
    currentClassifier, targetType, targetValue, inventory, inventoryLoadState
  );
  const targetOptions = selection.options;
  const selectedChoice = selection.choice;
  const incompatibleAsset = targetType === 'asset' && Boolean(selectedChoice)
    && !selection.compatible;
  const canRun = classifierLoadState === 'ready' && selection.canRun;

  const changeClassifier = (classifierId: string) => {
    selectionRevisionRef.current += 1;
    setSelectedClassifierId(classifierId);
    setRunResult(null);
  };

  const changeTargetType = (type: ClassifierTargetType) => {
    selectionRevisionRef.current += 1;
    setTargetType(type);
    setTargetValue(type === 'asset' ? (selectedAsset?.id ?? '') : '');
    setRunResult(null);
  };

  const changeTargetValue = (value: string) => {
    selectionRevisionRef.current += 1;
    setTargetValue(value);
    setRunResult(null);
  };

  const handleRun = async () => {
    const runGate = runGateRef.current;
    if (!currentClassifier || !canRun || runningRef.current || !runGate) return;
    const request = runGate.begin();
    runningRef.current = true;
    setRunning(true);
    setRunResult(null);
    const revision = selectionRevisionRef.current;

    try {
      const result = await requestJson(`/api/classifiers/${currentClassifier.id}/run`, parseRunResult, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: request.signal,
        body: JSON.stringify({
          targetType,
          targetValue: targetType === 'all' ? undefined : targetValue,
        }),
      });
      if (!request.isCurrent()) return;
      if (result.classifierId !== currentClassifier.id) {
        throw new Error('The classifier run response did not match the selected classifier');
      }
      onRunComplete?.();
      if (!activeRef.current) return;
      if (revision !== selectionRevisionRef.current) return;
      setRunResult(result);
      const outcomeDetails = result.noResultCount !== undefined && result.errorCount !== undefined
        ? `; ${result.noResultCount} no result; ${result.errorCount} errors`
        : `; ${result.failedCount} not classified`;
      showToast(
        result.errorCount && result.errorCount > 0 ? 'warning'
          : result.classifiedCount === result.totalTargeted && result.totalTargeted > 0 ? 'success' : 'info',
        result.errorCount && result.errorCount > 0 ? `${currentClassifier.name} completed with errors`
          : result.classifiedCount > 0 ? `${currentClassifier.name} Completed` : 'No assets classified',
        `Classified ${result.classifiedCount} of ${result.totalTargeted}${outcomeDetails} in ${(result.elapsedMs / 1000).toFixed(1)}s`
      );
    } catch (error) {
      if (activeRef.current && request.isCurrent()
        && revision === selectionRevisionRef.current) {
        showToast('error', 'Classifier Run Error', errorMessage(error));
      }
    } finally {
      runningRef.current = false;
      if (activeRef.current && request.isCurrent()) setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4"
      onMouseDown={(event) => { if (isBackdropPress(event.target, event.currentTarget)) handleClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="classifier-dialog-title"
        tabIndex={-1}
        className="bg-[#171727] border border-[#2b2b42] rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden text-slate-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#25253c] bg-[#131320]">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-pink-950/60 border border-pink-500/40 text-pink-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 id="classifier-dialog-title" className="text-base font-semibold text-slate-100">Asset Classifiers</h2>
              <p className="text-xs text-slate-400">
                Execute automated multi-step classification on your library, folders, or archives
              </p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close classifiers"
            onClick={handleClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto max-h-[72vh]">
          {/* Classifier Selection */}
          <div className="space-y-2">
            <div className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Classifier
            </div>
            {classifierLoadState === 'loading' && <p role="status" className="text-xs text-slate-400">Loading classifiers…</p>}
            {classifierLoadState === 'error' && (
              <p role="alert" className="text-xs text-rose-400">Could not load classifiers: {classifierError}</p>
            )}
            {classifierLoadState === 'ready' && classifiers.length === 0 && (
              <p role="status" className="text-xs text-slate-400">No classifiers are available.</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {classifiers.map((clf) => (
                <button
                  key={clf.id}
                  type="button"
                  aria-pressed={clf.id === selectedClassifierId}
                  onClick={() => changeClassifier(clf.id)}
                  className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all cursor-pointer ${
                    clf.id === selectedClassifierId
                      ? clf.id === 'pack'
                        ? 'bg-amber-950/30 border-amber-500/60 ring-1 ring-amber-500/30'
                        : clf.category === 'image'
                        ? 'bg-purple-950/30 border-purple-500/60 ring-1 ring-purple-500/30'
                        : 'bg-pink-950/30 border-pink-500/60 ring-1 ring-pink-500/30'
                      : 'bg-[#12121d] border-[#292942] hover:border-[#38385a]'
                  }`}
                >
                  {clf.id === 'pack' ? (
                    <Package className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  ) : clf.category === 'image' ? (
                    <ImageIcon className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
                  ) : (
                    <Music className="w-5 h-5 text-pink-400 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="text-xs font-bold text-slate-100">{clf.name}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2">{clf.description}</div>
                  </div>
                </button>
              ))}
            </div>
            {currentClassifier && (
              <p className="text-[11px] text-slate-400">
                The Enabled setting controls automatic runs. You can run this classifier manually here.
              </p>
            )}
          </div>

          {/* Multi-Step Pipeline Preview */}
          {currentClassifier && (
            <div className="space-y-2 bg-[#12121e] border border-[#232338] rounded-lg p-3.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-300">
                <span className={`flex items-center gap-1.5 ${
                  currentClassifier.id === 'pack'
                    ? 'text-amber-400'
                    : currentClassifier.category === 'image'
                    ? 'text-purple-400'
                    : 'text-pink-400'
                }`}>
                  <Sliders className="w-3.5 h-3.5" />
                  Multi-Step Execution Pipeline
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  {currentClassifier.steps.length} Steps
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                {currentClassifier.steps.map((step, idx) => (
                  <div
                    key={step.id}
                    className="flex flex-col p-2 rounded-md bg-[#181829] border border-[#2a2a42] text-[11px]"
                  >
                    <div className={`flex items-center gap-1 text-[10px] font-mono font-bold mb-1 ${
                      currentClassifier.id === 'pack'
                        ? 'text-amber-400'
                        : currentClassifier.category === 'image'
                        ? 'text-purple-400'
                        : 'text-pink-400'
                    }`}>
                      <span>Step {idx + 1}</span>
                    </div>
                    <span className="font-medium text-slate-200 line-clamp-1">{step.name}</span>
                    <span className="text-[10px] text-slate-400 line-clamp-2 mt-0.5">
                      {step.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Target Scope Selection */}
          <div className="space-y-3">
            <div className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Apply Classifier To
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="group" aria-label="Target scope">
              {([
                ['all', 'Entire Library'],
                ['directory', 'Specific Directory'],
                ['archive', 'Specific Archive'],
                ['asset', 'Specific Asset'],
              ] as const).map(([type, label]) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={targetType === type}
                  onClick={() => changeTargetType(type)}
                  className={`py-2 px-3 text-xs font-medium rounded-lg border text-center transition-all cursor-pointer ${
                    targetType === type
                      ? 'bg-indigo-600 border-indigo-500 text-white shadow-sm'
                      : 'bg-[#181829] border-[#292942] text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {targetType !== 'all' && (
              <div className="space-y-1.5 pt-1">
                <label htmlFor="classifier-target" className="block text-[11px] text-slate-400">
                  {targetType === 'directory' ? 'Target Folder' : targetType === 'archive'
                    ? 'Target Zip Archive' : 'Target Asset'}
                </label>
                {inventoryLoadState === 'loading' && (
                  <p role="status" className="text-xs text-slate-400">Loading available targets…</p>
                )}
                {inventoryLoadState === 'error' && (
                  <p role="alert" className="flex items-center gap-1.5 text-xs text-rose-400">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    Could not load targets: {inventoryError}
                  </p>
                )}
                {inventoryLoadState === 'ready' && targetOptions?.length === 0 && (
                  <p role="status" className="text-xs text-amber-400">
                    No indexed {targetType === 'directory' ? 'directories' : targetType === 'archive'
                      ? 'archives' : 'assets'} are available.
                  </p>
                )}
                <select
                  id="classifier-target"
                  value={selectedChoice ? targetValue : ''}
                  disabled={inventoryLoadState !== 'ready' || !targetOptions?.length}
                  onChange={(event) => changeTargetValue(event.target.value)}
                  className="w-full bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500 cursor-pointer disabled:opacity-50"
                >
                  <option value="">Select a {targetType === 'directory' ? 'directory' : targetType === 'archive'
                    ? 'zip archive' : 'catalog asset'}</option>
                  {targetOptions?.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}{targetType === 'asset' ? ` (${(choice as AssetTargetChoice).category})` : ''}
                    </option>
                  ))}
                </select>
                {inventoryLoadState === 'ready' && targetType === 'asset'
                  && selectedAsset && targetValue === selectedAsset.id && !selectedChoice && (
                    <p role="alert" className="text-xs text-amber-400">
                      The previously selected asset is no longer indexed. Choose another asset.
                    </p>
                  )}
                {incompatibleAsset && currentClassifier && (
                  <p role="alert" className="text-xs text-amber-400">
                    This asset is {String((selectedChoice as AssetTargetChoice).category)};
                    {currentClassifier.name} accepts {currentClassifier.category} assets. Choose a compatible asset.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Results Summary if ran */}
          {runResult && (
            <div className="space-y-2 bg-[#12121e] border border-[#2c2c45] rounded-lg p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  Classification Results
                </span>
                <span className="text-xs font-mono text-slate-400">
                  {(runResult.elapsedMs / 1000).toFixed(2)}s
                </span>
              </div>

              <div className={`grid gap-2 py-2 border-y border-[#202033] text-center text-xs ${
                runResult.errorCount !== undefined
                  ? 'grid-cols-4' : 'grid-cols-3'
              }`}>
                <div>
                  <div className="text-slate-400 text-[10px]">Targeted</div>
                  <div className="font-mono font-bold text-slate-100">{runResult.totalTargeted}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">Classified</div>
                  <div className="font-mono font-bold text-emerald-400">{runResult.classifiedCount}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">
                    {runResult.noResultCount !== undefined ? 'No result' : 'Not classified'}
                  </div>
                  <div className="font-mono font-bold text-slate-400">
                    {runResult.noResultCount ?? runResult.failedCount}
                  </div>
                </div>
                {runResult.errorCount !== undefined && (
                  <div>
                    <div className="text-slate-400 text-[10px]">Errors</div>
                    <div className="font-mono font-bold text-rose-400">{runResult.errorCount}</div>
                  </div>
                )}
              </div>

              <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1 text-[11px] pt-1">
                {runResult.details.map((item) => (
                  <div
                    key={item.assetId}
                    className="flex items-center justify-between py-1 px-2 rounded bg-[#181828] border border-[#252538]"
                  >
                    <span className="font-mono text-slate-300 truncate max-w-[240px]" title={item.assetPath}>
                      {item.assetPath}
                    </span>
                    {item.success && item.result?.bpm ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="font-mono font-bold text-pink-400">
                          {String(item.result.bpm)} BPM
                        </span>
                        {Boolean(item.result.tempoDescription) && (
                          <span className="text-[10px] bg-pink-950/60 border border-pink-500/30 text-pink-300 px-1 rounded">
                            {String(item.result.tempoDescription)}
                          </span>
                        )}
                      </div>
                    ) : item.success && item.result?.spriteType ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className={`font-mono font-bold text-xs capitalize px-1.5 py-0.5 rounded border ${
                            item.result.spriteType === 'character'
                              ? 'text-purple-300 bg-purple-950/50 border-purple-500/40'
                              : item.result.spriteType === 'object'
                              ? 'text-amber-300 bg-amber-950/50 border-amber-500/40'
                              : item.result.spriteType === 'texture'
                              ? 'text-emerald-300 bg-emerald-950/50 border-emerald-500/40'
                              : item.result.spriteType === 'background'
                              ? 'text-sky-300 bg-sky-950/50 border-sky-500/40'
                              : 'text-slate-400 bg-slate-800/40 border-slate-600/40'
                          }`}
                        >
                          {String(item.result.spriteType)}
                        </span>
                        {item.result.confidence !== undefined && (
                          <span className="text-[10px] text-slate-400 font-mono">
                            {Math.round(Number(item.result.confidence) * 100)}%
                          </span>
                        )}
                      </div>
                    ) : item.success && typeof item.result?.pack === 'string' ? (
                      <span className="font-mono font-bold text-amber-300 truncate max-w-[180px]">
                        {item.result.pack}
                      </span>
                    ) : item.success ? (
                      <span className="text-[10px] text-emerald-400">Classified</span>
                    ) : (
                      <span className={`text-[10px] italic truncate max-w-[180px] ${
                        item.outcome === 'error' ? 'text-rose-400' : 'text-slate-500'
                      }`} title={item.error}>
                        {item.error || (item.outcome === 'error' ? 'Processing error' : 'No result')}
                        {item.stale ? ' (previous result retained)' : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#25253c] bg-[#131320]">
          {running && (
            <p className="mr-auto text-[11px] text-slate-400">Closing this dialog keeps the run going.</p>
          )}
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-[#202033] hover:bg-[#2a2a44] rounded-lg transition-colors cursor-pointer"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleRun}
            disabled={running || !canRun}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-pink-600 hover:bg-pink-500 rounded-lg transition-colors shadow-md disabled:opacity-50 cursor-pointer"
          >
            {running ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Executing Pipeline...
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                Run Classifier
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
