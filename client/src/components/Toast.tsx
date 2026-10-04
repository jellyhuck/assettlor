import React, { createContext, useContext, useState, useCallback } from 'react';
import { ToastMessage } from '../types';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

interface ToastContextValue {
  showToast: (type: ToastMessage['type'], title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((type: ToastMessage['type'], title: string, description?: string) => {
    const id = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    setToasts((prev) => [...prev, { id, type, title, description }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((toast) => {
          let icon = <Info className="w-5 h-5 text-indigo-400 shrink-0" />;
          let border = 'border-indigo-500/30';
          let bg = 'bg-[#1e1e2f]';

          if (toast.type === 'success') {
            icon = <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />;
            border = 'border-emerald-500/40';
          } else if (toast.type === 'error') {
            icon = <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />;
            border = 'border-rose-500/40';
          }

          return (
            <div
              key={toast.id}
              className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-lg shadow-xl border ${border} ${bg} text-slate-100 transition-all transform animate-in fade-in slide-in-from-bottom-2`}
            >
              {icon}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-slate-100 leading-tight">{toast.title}</div>
                {toast.description && (
                  <div className="text-xs text-slate-400 mt-1 break-all leading-normal">{toast.description}</div>
                )}
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                className="text-slate-500 hover:text-slate-300 transition-colors p-0.5 rounded cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
