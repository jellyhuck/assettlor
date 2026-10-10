import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Asset, AssetStack, CopyAssetRequest } from '../types';
import { Copy, Folder, Layers, File, Check, X } from 'lucide-react';
import { useToast } from './Toast';
import { bindDialogFocus } from '../lib/dialogFocus';
import { createRequestGate, errorMessage, expectRecord } from '../lib/requestLifecycle';

interface CopyModalProps {
  isOpen: boolean;
  onClose: () => void;
  asset?: Asset | null;
  stack?: AssetStack | null;
  targetDir?: string;
  projectPaths?: string[];
}

interface CopyOperation {
  payload: CopyAssetRequest;
  itemName: string;
  targetPath: string;
  mode: 'file' | 'stack';
  itemIdentity: string;
}

interface CopyFailure {
  title: string;
  message: string;
  failedFile?: string;
  targetDirectory?: string;
  copiedCount?: number;
  rolledBackCount?: number;
  remainingFiles: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function copyFailure(value: Record<string, unknown>, status: number): CopyFailure {
  const details = value.details && typeof value.details === 'object' && !Array.isArray(value.details)
    ? value.details as Record<string, unknown> : null;
  const copiedFiles = strings(details?.copiedFiles);
  const rolledBackFiles = strings(details?.rolledBackFiles);
  const remainingFiles = strings(details?.remainingFiles);
  return {
    title: remainingFiles.length > 0 ? 'Copy Partially Completed'
      : value.code === 'COPY_CONFLICT' ? 'Copy Conflict' : 'Copy Failed',
    message: typeof value.error === 'string' ? value.error : `Copy failed (HTTP ${status})`,
    failedFile: typeof details?.failedFile === 'string' ? details.failedFile : undefined,
    targetDirectory: typeof details?.targetDirectory === 'string' ? details.targetDirectory : undefined,
    copiedCount: details ? copiedFiles.length : undefined,
    rolledBackCount: details ? rolledBackFiles.length : undefined,
    remainingFiles,
  };
}

async function readCopyResponse(response: Response): Promise<
  { ok: true; message?: string } | { ok: false; failure: CopyFailure }
> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { ok: false, failure: {
      title: 'Copy Failed',
      message: response.ok ? 'The server returned an invalid copy response'
        : `Copy failed (HTTP ${response.status})`,
      remainingFiles: [],
    } };
  }

  let data: Record<string, unknown>;
  try {
    data = expectRecord(value, 'copy');
  } catch (error) {
    return { ok: false, failure: {
      title: 'Copy Failed', message: errorMessage(error), remainingFiles: [],
    } };
  }
  if (!response.ok) return { ok: false, failure: copyFailure(data, response.status) };
  if (data.success !== true) return { ok: false, failure: {
    title: 'Copy Failed', message: 'The server did not confirm the copy', remainingFiles: [],
  } };
  return { ok: true, message: typeof data.message === 'string' ? data.message : undefined };
}

function OpenCopyModal({ onClose, asset, stack, targetDir, projectPaths }: Omit<CopyModalProps, 'isOpen'>) {
  const { showToast } = useToast();
  const [modeSelection, setModeSelection] = useState<{ stackId: string; all: boolean } | null>(null);
  const [selectedDirOverride, setSelectedDirOverride] = useState<string | null>(null);
  const [operation, setOperation] = useState<CopyOperation | null>(null);
  const [failure, setFailure] = useState<CopyFailure | null>(null);
  const [requestGate] = useState(createRequestGate);
  const pendingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  const projects = projectPaths === undefined ? (targetDir ? [targetDir] : [])
    : projectPaths.filter((project) => project.trim() !== '');
  const defaultDir = targetDir && projects.includes(targetDir) ? targetDir : (projects[0] ?? '');
  const selectedDir = selectedDirOverride && projects.includes(selectedDirOverride)
    ? selectedDirOverride : defaultDir;
  const copyAll = !stack || modeSelection?.stackId !== stack.id ? true : modeSelection.all;
  const title = stack?.name ?? asset?.name ?? 'No item selected';
  const selectedFileName = asset?.name ?? stack?.representativeAsset?.name ?? 'the representative file';
  const selectedMember = Boolean(stack && asset && asset.id !== stack.representativeAssetId);
  const itemIdentity = `${stack?.id ?? ''}\0${asset?.id ?? ''}`;
  const itemIdentityRef = useRef(itemIdentity);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    itemIdentityRef.current = itemIdentity;
  }, [onClose, itemIdentity]);

  const handleClose = useCallback(() => {
    requestGate.invalidate();
    onCloseRef.current();
  }, [requestGate]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const releaseFocus = bindDialogFocus(dialog, closeButtonRef.current, handleClose,
      { labelledBy: 'copy-dialog-title' });
    return () => {
      requestGate.invalidate();
      releaseFocus();
    };
  }, [handleClose, requestGate]);

  const handleCopy = async () => {
    if (pendingRef.current || !selectedDir) return;
    const payload: CopyAssetRequest = stack && copyAll
      ? { stackId: stack.id, copyStackAll: true, targetPath: selectedDir }
      : { assetId: asset?.id || stack?.representativeAssetId, targetPath: selectedDir };
    if (!payload.stackId && !payload.assetId) return;

    const submitted: CopyOperation = {
      payload,
      itemName: stack && copyAll ? stack.name : selectedFileName,
      targetPath: selectedDir,
      mode: stack && copyAll ? 'stack' : 'file',
      itemIdentity,
    };
    pendingRef.current = true;
    setOperation(submitted);
    setFailure(null);
    const token = requestGate.begin();
    try {
      const response = await fetch('/api/assets/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitted.payload),
      });
      const result = await readCopyResponse(response);
      if (!token.isCurrent()) return;
      if (!result.ok) {
        setFailure(result.failure);
        showToast('error', result.failure.title, result.failure.message);
        return;
      }
      showToast('success', 'Copied to Game Project',
        result.message ?? `${submitted.itemName} copied to ${submitted.targetPath}`);
      if (itemIdentityRef.current === submitted.itemIdentity) onCloseRef.current();
    } catch (error) {
      if (!token.isCurrent()) return;
      const nextFailure = { title: 'Copy Failed', message: errorMessage(error), remainingFiles: [] };
      setFailure(nextFailure);
      showToast('error', nextFailure.title, nextFailure.message);
    } finally {
      pendingRef.current = false;
      if (token.isCurrent()) setOperation(null);
    }
  };

  const canCopy = Boolean(selectedDir && (stack && copyAll ? stack.id : asset?.id || stack?.representativeAssetId));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="copy-dialog-title" tabIndex={-1}
        className="bg-[#171727] border border-[#2d2d48] rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden text-slate-200">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#25253c] bg-[#131320]">
          <div className="flex items-center gap-2">
            <Copy className="w-4 h-4 text-indigo-400" />
            <h3 id="copy-dialog-title" className="text-sm font-semibold text-slate-100">Copy to Game Project</h3>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={handleClose}
            aria-label="Close copy dialog"
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
              <div id="copy-destination-label" className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Destination Project</div>
              {projects.length > 1 && (
                <span className="text-[10px] text-indigo-400 font-medium">{projects.length} available</span>
              )}
            </div>

            {projects.length > 1 ? (
              <select
                id="copy-destination"
                aria-labelledby="copy-destination-label"
                value={selectedDir}
                onChange={(event) => { setSelectedDirOverride(event.target.value); setFailure(null); }}
                disabled={Boolean(operation)}
                className="w-full bg-[#12121d] border border-[#2c2c45] rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-indigo-500 cursor-pointer"
              >
                {projects.map((project, index) => {
                  const folderName = project.split('/').filter(Boolean).pop() || project;
                  return (
                    <option key={project} value={project}>
                      {index === 0 ? `★ ${folderName} (Active)` : folderName} — {project}
                    </option>
                  );
                })}
              </select>
            ) : null}

            <div className="flex items-center gap-1.5 text-xs font-mono text-cyan-300 mt-1.5 bg-[#11111d] p-2 rounded border border-[#28283e] break-all">
              <Folder className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span>{selectedDir || 'No project destination configured'}</span>
            </div>
          </div>

          {stack && (
            <div className="space-y-2 pt-1 border-t border-[#25253c]">
              <div className="text-xs font-semibold text-slate-300">Stack Copy Mode</div>
              <label className="flex items-center gap-2.5 p-2 rounded-lg border border-[#2b2b40] hover:bg-[#202034] cursor-pointer">
                <input
                  type="radio"
                  name="copyMode"
                  checked={copyAll}
                  onChange={() => { setModeSelection({ stackId: stack.id, all: true }); setFailure(null); }}
                  disabled={Boolean(operation)}
                  className="accent-indigo-500"
                />
                <Layers className="w-4 h-4 text-indigo-400 shrink-0" />
                <div className="text-xs">
                  <div className="font-semibold text-slate-200">Copy Complete Stack ({stack.itemCount} files)</div>
                  <div className="text-slate-400">Copies all frames/variations into a folder</div>
                </div>
              </label>

              <label className="flex items-center gap-2.5 p-2 rounded-lg border border-[#2b2b40] hover:bg-[#202034] cursor-pointer">
                <input
                  type="radio"
                  name="copyMode"
                  checked={!copyAll}
                  onChange={() => { setModeSelection({ stackId: stack.id, all: false }); setFailure(null); }}
                  disabled={Boolean(operation)}
                  className="accent-indigo-500"
                />
                <File className="w-4 h-4 text-slate-400 shrink-0" />
                <div className="text-xs">
                  <div className="font-semibold text-slate-200">
                    {selectedMember ? 'Copy Selected File Only' : 'Copy Representative File Only'}
                  </div>
                  <div className="text-slate-400">Copies {selectedFileName} only</div>
                </div>
              </label>
            </div>
          )}

          {operation && (
            <div role="status" className="text-xs text-indigo-200 bg-indigo-500/10 border border-indigo-500/30 rounded-lg p-3 break-all">
              Copying {operation.mode === 'stack' ? 'complete stack' : 'file'} “{operation.itemName}” to {operation.targetPath}.
              {' '}Closing this dialog will not stop the copy.
            </div>
          )}

          {failure && (
            <div role="alert" className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 space-y-1 break-all">
              <div className="font-semibold">{failure.title}: {failure.message}</div>
              {failure.targetDirectory && <div>Destination: {failure.targetDirectory}</div>}
              {failure.failedFile && <div>Failed file: {failure.failedFile}</div>}
              {failure.copiedCount !== undefined && (
                <div>{failure.copiedCount} file(s) copied before failure; {failure.rolledBackCount} rolled back.</div>
              )}
              {failure.remainingFiles.length > 0 && (
                <div>Files still present: {failure.remainingFiles.join(', ')}</div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-[#25253c] bg-[#131320]">
          <button
            type="button"
            onClick={handleClose}
            className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#202033] hover:bg-[#2a2a44] rounded-lg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={Boolean(operation) || !canCopy}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-sm disabled:opacity-50 cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            {operation ? 'Copying...' : 'Confirm Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CopyModal(props: CopyModalProps) {
  if (!props.isOpen) return null;
  return <OpenCopyModal {...props} />;
}
