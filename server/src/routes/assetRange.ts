/**
 * A single byte range is supported. Unknown units, malformed syntax, and
 * multi-range requests are ignored and receive the complete representation.
 * Syntactically valid ranges that cannot select a byte receive 416.
 */
export interface AssetResponsePlan {
  status: 200 | 206 | 416;
  start: number;
  end: number;
  contentLength: number;
  contentRange?: string;
}

export function planAssetResponse(totalSize: number, rangeHeader: string | undefined): AssetResponsePlan {
  const full: AssetResponsePlan = {
    status: 200,
    start: 0,
    end: totalSize - 1,
    contentLength: totalSize,
  };
  if (!rangeHeader) return full;

  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) return full;

  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  ) {
    return full;
  }

  const unsatisfiable: AssetResponsePlan = {
    status: 416,
    start: 0,
    end: -1,
    contentLength: 0,
    contentRange: `bytes */${totalSize}`,
  };
  if (totalSize === 0) return unsatisfiable;

  let start: number;
  let end: number;
  if (first === undefined) {
    if (last === 0) return unsatisfiable;
    start = Math.max(0, totalSize - last!);
    end = totalSize - 1;
  } else {
    start = first;
    end = last === undefined ? totalSize - 1 : Math.min(last, totalSize - 1);
    if (start >= totalSize || end < start) return unsatisfiable;
  }

  return {
    status: 206,
    start,
    end,
    contentLength: end - start + 1,
    contentRange: `bytes ${start}-${end}/${totalSize}`,
  };
}
