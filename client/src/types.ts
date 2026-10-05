export * from '../../shared/types.js';
export * from '../../shared/filterSync.js';

export interface ToastMessage {
  id: string;
  type: 'success' | 'info' | 'error' | 'warning';
  title: string;
  description?: string;
}

export type ViewMode = 'grid' | 'list';
export type CardZoom = 'small' | 'medium' | 'large';
