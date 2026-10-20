import path from 'path';

/** A configured library root and its optional names. */
export interface LibrarySource {
  path: string;
  names: string[];
}

/** Trims names and drops empty ones and case-insensitive repeats. */
export function cleanLibraryNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/** A library's names, or its folder name when it has none. */
export function effectiveLibraryNames(source: LibrarySource): string[] {
  return source.names.length ? source.names : [path.basename(source.path)];
}
