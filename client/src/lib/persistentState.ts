import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

const KEY_PREFIX = 'assettlor:';

/** Type guard that accepts only the listed literal values. */
export function oneOf<T extends string>(...values: readonly T[]): (value: unknown) => value is T {
  return (value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Read a stored preference, falling back when storage is unavailable or the value is stale. */
export function readStoredValue<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredValue(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
  } catch {
    // Private windows and blocked storage simply lose the preference.
  }
}

/** `useState` that survives page reloads by mirroring the value into localStorage. */
export function usePersistentState<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readStoredValue(key, fallback, isValid));
  useEffect(() => {
    writeStoredValue(key, value);
  }, [key, value]);
  return [value, setValue];
}
