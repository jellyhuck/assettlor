import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageWindow } from '../lib/pageWindow';

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, totalPages, total, pageSize, onPageChange }: PaginationProps) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const pageButton = 'min-w-7 px-2 py-1 rounded disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <nav aria-label="Catalog pages"
      className="shrink-0 border-t border-[#242438] bg-[#151524] px-4 py-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
      <span className="text-slate-400" role="status">{first}–{last} of {total}</span>
      <div className="flex items-center gap-1">
        <button type="button" aria-label="Previous page" disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className={`${pageButton} text-slate-300 hover:bg-[#252538]`}>
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        {pageWindow(page, totalPages).map((value, index) => value === null
          ? <span key={`gap-${index}`} className="px-1 text-slate-500" aria-hidden="true">…</span>
          : <button key={value} type="button"
            aria-label={`Page ${value}`} aria-current={value === page ? 'page' : undefined}
            onClick={() => { if (value !== page) onPageChange(value); }}
            className={`${pageButton} font-mono ${value === page
              ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-[#252538]'}`}>
            {value}
          </button>)}
        <button type="button" aria-label="Next page" disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className={`${pageButton} text-slate-300 hover:bg-[#252538]`}>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </nav>
  );
}
