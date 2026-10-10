const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), '
  + 'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function tabWrapTarget<T>(focusable: readonly T[], active: T | null, backward: boolean): T | undefined {
  if (focusable.length === 0) return undefined;
  if (backward && active === focusable[0]) return focusable[focusable.length - 1];
  if (!backward && active === focusable[focusable.length - 1]) return focusable[0];
  return undefined;
}

export function isBackdropPress(target: EventTarget | null, backdrop: EventTarget | null): boolean {
  return backdrop !== null && target === backdrop;
}

/** Focus the dialog, trap Tab, dismiss on Escape, and restore focus on cleanup. */
export function bindDialogFocus(
  dialog: HTMLElement,
  initialFocus: HTMLElement | null,
  onDismiss: () => void,
): () => void {
  const ownerDocument = dialog.ownerDocument;
  const previousFocus = ownerDocument.activeElement instanceof HTMLElement
    ? ownerDocument.activeElement : null;
  const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
  (initialFocus ?? focusable()[0] ?? dialog).focus();

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const candidates = focusable();
    if (candidates.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const destination = tabWrapTarget(candidates, ownerDocument.activeElement as HTMLElement, event.shiftKey);
    if (destination) {
      event.preventDefault();
      destination.focus();
    }
  };
  dialog.addEventListener('keydown', onKeyDown);

  return () => {
    dialog.removeEventListener('keydown', onKeyDown);
    if (previousFocus?.isConnected) previousFocus.focus();
  };
}
