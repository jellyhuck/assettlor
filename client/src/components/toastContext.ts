import { createContext, useContext } from 'react';
import type { ToastMessage } from '../types';

interface ToastContextValue {
  showToast: (type: ToastMessage['type'], title: string, description?: string) => void;
}

export const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}
