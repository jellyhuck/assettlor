import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Folder, ChevronRight, CornerLeftUp, Check, X, Loader2 } from 'lucide-react';
import { bindDialogFocus, isBackdropPress } from '../lib/dialogFocus';
import {
  createRequestGate,
  errorMessage,
  expectArray,
  expectRecord,
  isAbortError,
  requestJson,
} from '../lib/requestLifecycle';

interface FolderBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (selectedPath: string) => void;
  initialPath?: string;
  title: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  currentPath: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
}

interface BrowserState {
  requestedPath?: string;
  result: BrowseResult | null;
  loading: boolean;
  error: string | null;
}

function parseBrowseResult(value: unknown): BrowseResult {
  const data = expectRecord(value, 'folder browser');
  if (typeof data.currentPath !== 'string' || !data.currentPath.trim()
    || data.parentPath !== null && typeof data.parentPath !== 'string') {
    throw new Error('The folder browser response has an unexpected shape');
  }
  const directories = expectArray<DirectoryEntry>(
    data.directories,
    (entry): entry is DirectoryEntry => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const directory = entry as Record<string, unknown>;
      return typeof directory.name === 'string' && typeof directory.path === 'string'
        && Boolean(directory.path.trim());
    },
    'folder browser',
  );
  return {
    currentPath: data.currentPath,
    parentPath: data.parentPath,
    directories,
  };
}

function browseUrl(targetPath?: string): string {
  return `/api/fs/browse${targetPath ? `?path=${encodeURIComponent(targetPath)}` : ''}`;
}

function FolderBrowserSession({ onClose, onSelect, initialPath, title }: Omit<FolderBrowserModalProps, 'isOpen'>) {
  const initialRequestedPath = initialPath?.trim() || undefined;
  const [state, setState] = useState<BrowserState>({
    requestedPath: initialRequestedPath,
    result: null,
    loading: true,
    error: null,
  });
  const [requestGate] = useState(createRequestGate);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  const runRequest = useCallback(async (targetPath?: string) => {
    const request = requestGate.begin(targetPath);
    try {
      const result = await requestJson(browseUrl(targetPath), parseBrowseResult, {
        signal: request.signal,
      });
      if (!request.isCurrent(targetPath)) return;
      setState({ requestedPath: targetPath, result, loading: false, error: null });
    } catch (error: unknown) {
      if (!request.isCurrent(targetPath) || isAbortError(error)) return;
      setState((previous) => ({
        ...previous,
        requestedPath: targetPath,
        loading: false,
        error: errorMessage(error),
      }));
    }
  }, [requestGate]);

  const loadDirectory = useCallback((targetPath?: string) => {
    setState((previous) => ({
      ...previous,
      requestedPath: targetPath,
      loading: true,
      error: null,
    }));
    void runRequest(targetPath);
  }, [runRequest]);

  useEffect(() => {
    const request = requestGate.begin(initialRequestedPath);
    void requestJson(browseUrl(initialRequestedPath), parseBrowseResult, {
      signal: request.signal,
    }).then((result) => {
      if (!request.isCurrent(initialRequestedPath)) return;
      setState({ requestedPath: initialRequestedPath, result, loading: false, error: null });
    }).catch((error: unknown) => {
      if (!request.isCurrent(initialRequestedPath) || isAbortError(error)) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: errorMessage(error),
      }));
    });
    return () => requestGate.invalidate();
  }, [initialRequestedPath, requestGate]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!dialogRef.current) return;
    return bindDialogFocus(dialogRef.current, closeButtonRef.current, () => onCloseRef.current(), {
      labelledBy: titleId,
    });
  }, [titleId]);

  const loaded = !state.loading && !state.error ? state.result : null;
  const displayedPath = loaded?.currentPath ?? state.requestedPath ?? 'Default directory';
  const backPath = loaded?.parentPath ?? (!loaded ? state.result?.currentPath : null);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
      onMouseDown={(event) => { if (isBackdropPress(event.target, event.currentTarget)) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-[#181828] border border-[#2e2e48] rounded-xl shadow-2xl w-full max-w-2xl h-[30rem] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden text-slate-200"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a44] bg-[#141422]">
          <div className="flex items-center gap-2.5">
            <Folder className="w-5 h-5 text-indigo-400" />
            <h2 id={titleId} className="text-base font-semibold text-slate-100">{title}</h2>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close folder browser"
            className="p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-[#25253c] bg-[#1a1a2e] flex items-center gap-2">
          {backPath && (
            <button
              onClick={() => void loadDirectory(backPath)}
              aria-label={loaded ? 'Go to parent directory' : 'Return to previous directory'}
              className="p-1.5 rounded bg-[#25253e] hover:bg-[#323254] text-slate-300 hover:text-white transition-colors cursor-pointer"
            >
              <CornerLeftUp className="w-4 h-4" />
            </button>
          )}
          <div className="flex-1 bg-[#12121e] border border-[#2d2d48] rounded px-3 py-1.5 text-xs font-mono text-slate-300 truncate select-text">
            {displayedPath}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-1" aria-busy={state.loading}>
          {state.loading ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-slate-400" role="status">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
              <span className="text-xs">Reading directories...</span>
            </div>
          ) : state.error ? (
            <div className="p-4 text-xs text-rose-400 bg-rose-950/20 border border-rose-900/40 rounded-lg" role="alert">
              <p>Cannot open {displayedPath}: {state.error}</p>
              <button
                onClick={() => void loadDirectory(state.requestedPath)}
                className="mt-3 px-3 py-1.5 text-xs font-medium text-rose-100 bg-rose-900/40 hover:bg-rose-900/60 rounded-lg cursor-pointer"
              >
                Retry
              </button>
            </div>
          ) : loaded?.directories.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No subdirectories found in this folder.
            </div>
          ) : (
            loaded?.directories.map((dir) => (
              <button
                key={dir.path}
                onClick={() => void loadDirectory(dir.path)}
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

        <div className="flex items-center justify-between px-5 py-3.5 border-t border-[#25253c] bg-[#141422]">
          <span className="text-xs text-slate-400 truncate max-w-xs">
            {loaded ? 'Selected:' : state.loading ? 'Opening:' : 'Unavailable:'}{' '}
            <span className="text-slate-200 font-mono">{displayedPath}</span>
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
                if (!loaded) return;
                onSelect(loaded.currentPath);
                onClose();
              }}
              disabled={!loaded}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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

export function FolderBrowserModal(props: FolderBrowserModalProps) {
  if (!props.isOpen) return null;
  return <FolderBrowserSession key={props.initialPath ?? ''} {...props} />;
}
