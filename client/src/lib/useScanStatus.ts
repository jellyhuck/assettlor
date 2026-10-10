import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanProgressEvent, ScanStatusType } from '../types';
import { createRequestGate, errorMessage, expectRecord, requestJson, type RequestGate } from './requestLifecycle';

const SCAN_STATES: readonly ScanStatusType[] = ['idle', 'scanning', 'completed', 'error'];

export function parseScanStatus(value: unknown): ScanProgressEvent {
  const record = expectRecord(value, 'scan status');
  if (!SCAN_STATES.includes(record.status as ScanStatusType)
    || typeof record.libraryPath !== 'string'
    || typeof record.scannedCount !== 'number' || !Number.isFinite(record.scannedCount)
    || typeof record.indexedCount !== 'number' || !Number.isFinite(record.indexedCount)
    || (record.libraryPaths !== undefined && (!Array.isArray(record.libraryPaths)
      || !record.libraryPaths.every((path: unknown) => typeof path === 'string')))
    || (record.failedScopes !== undefined && (!Array.isArray(record.failedScopes)
      || !record.failedScopes.every((path: unknown) => typeof path === 'string')))) {
    throw new Error('The scan status response has an unexpected shape');
  }
  return record as unknown as ScanProgressEvent;
}

type RequestToken = ReturnType<RequestGate['begin']>;

/** Read the current server scan job and keep it fresh while its dialog is open. */
export function useScanStatus(isOpen: boolean, pollIntervalMs = 1000): {
  status: ScanProgressEvent | null;
  error: string | null;
  refresh: () => Promise<ScanProgressEvent | null>;
} {
  const [status, setStatus] = useState<ScanProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gateRef = useRef<RequestGate | null>(null);
  const pendingRef = useRef<RequestToken | null>(null);

  const refresh = useCallback(async (): Promise<ScanProgressEvent | null> => {
    const gate = gateRef.current;
    if (!gate) return null;
    const request = gate.begin();
    pendingRef.current = request;
    try {
      const next = await requestJson('/api/scan/status', parseScanStatus, { signal: request.signal });
      if (!request.isCurrent()) return null;
      setStatus(next);
      setError(null);
      return next;
    } catch (cause) {
      if (request.isCurrent()) setError(errorMessage(cause));
      return null;
    } finally {
      if (pendingRef.current === request) pendingRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const gate = createRequestGate();
    gateRef.current = gate;
    void refresh();
    const timer = window.setInterval(() => {
      if (!pendingRef.current) void refresh();
    }, pollIntervalMs);
    return () => {
      window.clearInterval(timer);
      gate.dispose();
      if (gateRef.current === gate) gateRef.current = null;
      pendingRef.current = null;
      setStatus(null);
      setError(null);
    };
  }, [isOpen, pollIntervalMs, refresh]);

  return { status: isOpen ? status : null, error: isOpen ? error : null, refresh };
}
