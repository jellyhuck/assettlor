const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, '
  + '[tabindex], [contenteditable="true"]';

interface DialogFocusOptions {
  /** ID of a visible heading inside the dialog. */
  labelledBy?: string;
  /** Use when the dialog has no visible heading. */
  label?: string;
}

interface InertState {
  hadAttribute: boolean;
  property: boolean | undefined;
}

interface DialogRecord {
  dialog: HTMLElement;
  previousFocus: HTMLElement | null;
}

interface DocumentDialogs {
  records: DialogRecord[];
  inertElements: Map<HTMLElement, InertState>;
  observer: MutationObserver | null;
}

const documents = new WeakMap<Document, DocumentDialogs>();

function documentDialogs(ownerDocument: Document): DocumentDialogs {
  let state = documents.get(ownerDocument);
  if (!state) {
    state = { records: [], inertElements: new Map(), observer: null };
    documents.set(ownerDocument, state);
  }
  return state;
}

function focusableChildren(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.matches(':disabled') || element.tabIndex < 0) return false;
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return style?.display !== 'none' && style?.visibility !== 'hidden';
  });
}

function focusEntry(dialog: HTMLElement, initialFocus: HTMLElement | null): void {
  const candidates = focusableChildren(dialog);
  const target = initialFocus?.isConnected && dialog.contains(initialFocus)
    && (initialFocus === dialog || candidates.includes(initialFocus))
    ? initialFocus : (candidates[0] ?? dialog);
  target.focus();
}

function restoreInert(state: DocumentDialogs): void {
  for (const [element, previous] of state.inertElements) {
    if (previous.hadAttribute) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
    if (previous.property !== undefined) element.inert = previous.property;
  }
  state.inertElements.clear();
}

function syncInert(ownerDocument: Document, state: DocumentDialogs): void {
  restoreInert(state);
  const top = state.records.at(-1)?.dialog;
  if (!top?.isConnected) return;

  // Mark each sibling branch along the dialog's path to <body> inert. This
  // leaves a nested dialog interactive while disabling its parent dialog.
  let branch: Element = top;
  while (branch !== ownerDocument.body && branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      state.inertElements.set(sibling, {
        hadAttribute: sibling.hasAttribute('inert'),
        property: 'inert' in sibling ? sibling.inert : undefined,
      });
      sibling.setAttribute('inert', '');
      if ('inert' in sibling) sibling.inert = true;
    }
    branch = branch.parentElement;
  }
}

function isTopDialog(ownerDocument: Document, record: DialogRecord): boolean {
  return documentDialogs(ownerDocument).records.at(-1) === record;
}

export function tabWrapTarget<T>(focusable: readonly T[], active: T | null, backward: boolean): T | undefined {
  if (focusable.length === 0) return undefined;
  if (backward && active === focusable[0]) return focusable[focusable.length - 1];
  if (!backward && active === focusable[focusable.length - 1]) return focusable[0];
  return undefined;
}

export function isBackdropPress(target: EventTarget | null, backdrop: EventTarget | null): boolean {
  return backdrop !== null && target === backdrop;
}

/**
 * Give a dialog modal semantics, contain focus, dismiss the topmost dialog on
 * Escape, and restore the launching control when it closes.
 */
export function bindDialogFocus(
  dialog: HTMLElement,
  initialFocus: HTMLElement | null,
  onDismiss: () => void,
  options: DialogFocusOptions = {},
): () => void {
  const ownerDocument = dialog.ownerDocument;
  const state = documentDialogs(ownerDocument);
  const previousFocus = ownerDocument.activeElement instanceof HTMLElement
    ? ownerDocument.activeElement : null;
  const originalAttributes = new Map<string, string | null>();
  const setAttribute = (name: string, value: string) => {
    originalAttributes.set(name, dialog.getAttribute(name));
    dialog.setAttribute(name, value);
  };
  if (!dialog.hasAttribute('role')) setAttribute('role', 'dialog');
  setAttribute('aria-modal', 'true');
  if (!dialog.hasAttribute('tabindex')) setAttribute('tabindex', '-1');
  if (options.labelledBy) setAttribute('aria-labelledby', options.labelledBy);
  else if (options.label) setAttribute('aria-label', options.label);

  const record: DialogRecord = { dialog, previousFocus };
  state.records.push(record);
  syncInert(ownerDocument, state);
  if (!state.observer && ownerDocument.body) {
    state.observer = new MutationObserver(() => syncInert(ownerDocument, state));
    state.observer.observe(ownerDocument.body, { childList: true, subtree: true });
  }
  focusEntry(dialog, initialFocus);

  const onFocusIn = (event: FocusEvent) => {
    if (!isTopDialog(ownerDocument, record)) return;
    if (event.target instanceof Node && !dialog.contains(event.target)) {
      focusEntry(dialog, initialFocus);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isTopDialog(ownerDocument, record)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // App listens for Escape at window. Stop it even when the key originated
      // outside the dialog or closing this dialog exposes another one.
      event.stopImmediatePropagation();
      onDismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const candidates = focusableChildren(dialog);
    const active = ownerDocument.activeElement as HTMLElement | null;
    const destination = candidates.length === 0 ? dialog
      : !active || !candidates.includes(active)
        ? (event.shiftKey ? candidates[candidates.length - 1] : candidates[0])
        : tabWrapTarget(candidates, active, event.shiftKey);
    if (destination) {
      event.preventDefault();
      event.stopPropagation();
      destination.focus();
    }
  };
  ownerDocument.addEventListener('focusin', onFocusIn, true);
  ownerDocument.addEventListener('keydown', onKeyDown, true);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    ownerDocument.removeEventListener('focusin', onFocusIn, true);
    ownerDocument.removeEventListener('keydown', onKeyDown, true);
    const wasTop = isTopDialog(ownerDocument, record);
    state.records.splice(state.records.indexOf(record), 1);
    syncInert(ownerDocument, state);
    if (state.records.length === 0) {
      state.observer?.disconnect();
      state.observer = null;
    }
    for (const [name, value] of originalAttributes) {
      if (value === null) dialog.removeAttribute(name);
      else dialog.setAttribute(name, value);
    }
    if (wasTop) {
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
      else if (state.records.length > 0) focusEntry(state.records.at(-1)!.dialog, null);
    }
  };
}
