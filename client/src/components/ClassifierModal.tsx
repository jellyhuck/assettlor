import React, { useState, useEffect } from 'react';
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
  Folder,
  Archive,
  Music,
  Image as ImageIcon,
  Check,
  RefreshCw,
  Sliders,
  ChevronRight,
  ArrowRight,
} from 'lucide-react';
import { useToast } from './Toast';

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
  const { showToast } = useToast();
  const [classifiers, setClassifiers] = useState<ClassifierInfo[]>([]);
  const [selectedClassifierId, setSelectedClassifierId] = useState<string>('bpm');
  const [targetType, setTargetType] = useState<ClassifierTargetType>('all');
  const [targetValue, setTargetValue] = useState<string>('');
  const [running, setRunning] = useState<boolean>(false);
  const [runResult, setRunResult] = useState<ClassifierRunResult | null>(null);

  // Available directories and archives
  const [directories, setDirectories] = useState<string[]>([]);
  const [archives, setArchives] = useState<string[]>([]);

  useEffect(() => {
    if (isOpen) {
      // Fetch available classifiers
      fetch('/api/classifiers')
        .then((res) => res.json())
        .then((data: ClassifierInfo[]) => {
          setClassifiers(data);
          if (data.length > 0 && !selectedClassifierId) {
            setSelectedClassifierId(data[0].id);
          }
        })
        .catch(() => {});

      // Fetch assets to extract unique directories and archives for target dropdowns
      fetch('/api/assets?limit=200')
        .then((res) => res.json())
        .then((data) => {
          const dirs = new Set<string>();
          const archs = new Set<string>();

          (data.items || []).forEach((item: any) => {
            if (item.path) {
              const parts = item.path.split('/');
              if (parts.length > 1) {
                dirs.add(parts.slice(0, parts.length - 1).join('/'));
              }
            }
            if (item.isArchiveEntry && item.archivePath) {
              archs.add(item.archivePath.split(/[\\/]/).pop() || '');
            }
          });

          setDirectories(Array.from(dirs).filter(Boolean).sort());
          setArchives(Array.from(archs).filter(Boolean).sort());
        })
        .catch(() => {});

      // If an asset is currently selected, default target to that asset
      if (selectedAsset) {
        setTargetType('asset');
        setTargetValue(selectedAsset.id);
      } else {
        setTargetType('all');
        setTargetValue('');
      }
      setRunResult(null);
    }
  }, [isOpen, selectedAsset]);

  if (!isOpen) return null;

  const currentClassifier = classifiers.find((c) => c.id === selectedClassifierId) || classifiers[0];

  const handleRun = async () => {
    if (!currentClassifier) return;
    setRunning(true);
    setRunResult(null);

    try {
      let finalTargetValue: string | string[] | undefined = targetValue;
      if (targetType === 'all') {
        finalTargetValue = undefined;
      } else if (targetType === 'asset' && selectedAsset) {
        finalTargetValue = selectedAsset.id;
      }

      const res = await fetch(`/api/classifiers/${currentClassifier.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType,
          targetValue: finalTargetValue,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to run classifier');
      }

      const result: ClassifierRunResult = await res.json();
      setRunResult(result);
      showToast(
        'success',
        `${currentClassifier.name} Completed`,
        `Classified ${result.classifiedCount} of ${result.totalTargeted} assets in ${(result.elapsedMs / 1000).toFixed(1)}s`
      );

      if (onRunComplete) {
        onRunComplete();
      }
    } catch (err: any) {
      showToast('error', 'Classifier Run Error', err?.message || 'Execution failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
      <div className="bg-[#171727] border border-[#2b2b42] rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden text-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#25253c] bg-[#131320]">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-pink-950/60 border border-pink-500/40 text-pink-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100">Asset Classifiers</h2>
              <p className="text-xs text-slate-400">
                Execute automated multi-step classification on your library, folders, or archives
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto max-h-[72vh]">
          {/* Classifier Selection */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Classifier
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {classifiers.map((clf) => (
                <button
                  key={clf.id}
                  onClick={() => {
                    setSelectedClassifierId(clf.id);
                    setRunResult(null);
                  }}
                  className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all cursor-pointer ${
                    clf.id === selectedClassifierId
                      ? 'bg-pink-950/30 border-pink-500/60 ring-1 ring-pink-500/30'
                      : 'bg-[#12121d] border-[#292942] hover:border-[#38385a]'
                  }`}
                >
                  {clf.category === 'image' ? (
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
          </div>

          {/* Multi-Step Pipeline Preview */}
          {currentClassifier && (
            <div className="space-y-2 bg-[#12121e] border border-[#232338] rounded-lg p-3.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-300">
                <span className="flex items-center gap-1.5 text-pink-400">
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
                    <div className="flex items-center gap-1 text-[10px] font-mono text-pink-400 font-bold mb-1">
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
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Apply Classifier To
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => {
                  setTargetType('all');
                  setTargetValue('');
                }}
                className={`py-2 px-3 text-xs font-medium rounded-lg border text-center transition-all cursor-pointer ${
                  targetType === 'all'
                    ? 'bg-indigo-600 border-indigo-500 text-white shadow-sm'
                    : 'bg-[#181829] border-[#292942] text-slate-300 hover:border-slate-500'
                }`}
              >
                Entire Library
              </button>

              <button
                type="button"
                onClick={() => {
                  setTargetType('directory');
                  if (directories.length > 0 && !targetValue) {
                    setTargetValue(directories[0]);
                  }
                }}
                className={`py-2 px-3 text-xs font-medium rounded-lg border text-center transition-all cursor-pointer ${
                  targetType === 'directory'
                    ? 'bg-indigo-600 border-indigo-500 text-white shadow-sm'
                    : 'bg-[#181829] border-[#292942] text-slate-300 hover:border-slate-500'
                }`}
              >
                Specific Directory
              </button>

              <button
                type="button"
                onClick={() => {
                  setTargetType('archive');
                  if (archives.length > 0 && !targetValue) {
                    setTargetValue(archives[0]);
                  }
                }}
                className={`py-2 px-3 text-xs font-medium rounded-lg border text-center transition-all cursor-pointer ${
                  targetType === 'archive'
                    ? 'bg-indigo-600 border-indigo-500 text-white shadow-sm'
                    : 'bg-[#181829] border-[#292942] text-slate-300 hover:border-slate-500'
                }`}
              >
                Specific Archive
              </button>

              <button
                type="button"
                onClick={() => {
                  setTargetType('asset');
                  if (selectedAsset) {
                    setTargetValue(selectedAsset.id);
                  }
                }}
                className={`py-2 px-3 text-xs font-medium rounded-lg border text-center transition-all cursor-pointer ${
                  targetType === 'asset'
                    ? 'bg-indigo-600 border-indigo-500 text-white shadow-sm'
                    : 'bg-[#181829] border-[#292942] text-slate-300 hover:border-slate-500'
                }`}
              >
                Selected Asset
              </button>
            </div>

            {/* Sub-inputs based on targetType */}
            {targetType === 'directory' && (
              <div className="space-y-1.5 pt-1">
                <span className="text-[11px] text-slate-400">Target Folder:</span>
                {directories.length > 0 ? (
                  <select
                    value={targetValue}
                    onChange={(e) => setTargetValue(e.target.value)}
                    className="w-full bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500 cursor-pointer"
                  >
                    {directories.map((d) => (
                      <option key={d} value={d}>
                        📁 {d}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={targetValue}
                    onChange={(e) => setTargetValue(e.target.value)}
                    placeholder="e.g. audio/sfx or music"
                    className="w-full bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500"
                  />
                )}
              </div>
            )}

            {targetType === 'archive' && (
              <div className="space-y-1.5 pt-1">
                <span className="text-[11px] text-slate-400">Target Zip Archive:</span>
                {archives.length > 0 ? (
                  <select
                    value={targetValue}
                    onChange={(e) => setTargetValue(e.target.value)}
                    className="w-full bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500 cursor-pointer"
                  >
                    {archives.map((a) => (
                      <option key={a} value={a}>
                        📦 {a}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={targetValue}
                    onChange={(e) => setTargetValue(e.target.value)}
                    placeholder="e.g. RetroPack.zip"
                    className="w-full bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500"
                  />
                )}
              </div>
            )}

            {targetType === 'asset' && (
              <div className="p-2.5 rounded-lg bg-[#12121e] border border-[#292942] text-xs">
                {selectedAsset ? (
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-slate-200 truncate">{selectedAsset.name}</span>
                    <span className="font-mono text-[10px] text-indigo-400">{selectedAsset.category}</span>
                  </div>
                ) : (
                  <span className="text-amber-400 text-xs">No asset currently selected in gallery.</span>
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

              <div className="grid grid-cols-3 gap-2 py-2 border-y border-[#202033] text-center text-xs">
                <div>
                  <div className="text-slate-400 text-[10px]">Targeted</div>
                  <div className="font-mono font-bold text-slate-100">{runResult.totalTargeted}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">Classified</div>
                  <div className="font-mono font-bold text-emerald-400">{runResult.classifiedCount}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">Skipped / SFX</div>
                  <div className="font-mono font-bold text-slate-400">{runResult.failedCount}</div>
                </div>
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
                    ) : (
                      <span className="text-[10px] text-slate-500 italic truncate max-w-[150px]">
                        {item.error || 'Skipped'}
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
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-[#202033] hover:bg-[#2a2a44] rounded-lg transition-colors cursor-pointer"
          >
            Close
          </button>
          <button
            onClick={handleRun}
            disabled={running || (targetType === 'asset' && !selectedAsset)}
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
