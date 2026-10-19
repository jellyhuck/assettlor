/** Page numbers to show around the current page, with `null` marking a gap. */
export function pageWindow(page: number, totalPages: number, radius = 1): Array<number | null> {
  const pages: Array<number | null> = [];
  const start = Math.max(2, page - radius);
  const end = Math.min(totalPages - 1, page + radius);
  pages.push(1);
  if (start > 2) pages.push(start === 3 ? 2 : null);
  for (let value = start; value <= end; value++) pages.push(value);
  if (end < totalPages - 1) pages.push(end === totalPages - 2 ? totalPages - 1 : null);
  if (totalPages > 1) pages.push(totalPages);
  return pages;
}
