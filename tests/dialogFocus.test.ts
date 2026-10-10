// @vitest-environment jsdom
import { afterEach, vi } from 'vitest';
import { describe, expect, it } from 'vitest';
import { bindDialogFocus, isBackdropPress, tabWrapTarget } from '../client/src/lib/dialogFocus.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups.length = 0;
  document.body.replaceChildren();
});

function bind(
  dialog: HTMLElement,
  initialFocus: HTMLElement | null,
  onDismiss: () => void,
  options?: { labelledBy?: string; label?: string },
) {
  const cleanup = bindDialogFocus(dialog, initialFocus, onDismiss, options);
  cleanups.push(cleanup);
  return cleanup;
}

function key(target: HTMLElement, name: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: name, bubbles: true, cancelable: true, shiftKey,
  });
  target.dispatchEvent(event);
  return event;
}

describe('dialog focus decisions', () => {
  it('wraps Tab only at the dialog boundaries', () => {
    const buttons = ['close', 'scope', 'run'];
    expect(tabWrapTarget(buttons, 'run', false)).toBe('close');
    expect(tabWrapTarget(buttons, 'close', true)).toBe('run');
    expect(tabWrapTarget(buttons, 'scope', false)).toBeUndefined();
    expect(tabWrapTarget([], 'run', false)).toBeUndefined();
  });

  it('dismisses only on the backdrop itself', () => {
    const backdrop = new EventTarget();
    const content = new EventTarget();
    expect(isBackdropPress(backdrop, backdrop)).toBe(true);
    expect(isBackdropPress(content, backdrop)).toBe(false);
    expect(isBackdropPress(null, null)).toBe(false);
  });

  it('names the dialog, enters focus, traps Tab, and restores the launcher', () => {
    const launcher = document.createElement('button');
    const background = document.createElement('button');
    const overlay = document.createElement('div');
    const dialog = document.createElement('section');
    const heading = document.createElement('h2');
    const first = document.createElement('button');
    const disabled = document.createElement('button');
    const last = document.createElement('button');
    heading.id = 'settings-title';
    disabled.disabled = true;
    dialog.append(heading, first, disabled, last);
    overlay.append(dialog);
    document.body.append(launcher, background, overlay);
    launcher.focus();

    const cleanup = bind(dialog, first, () => {}, { labelledBy: heading.id });
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(document.activeElement).toBe(first);
    expect(launcher.hasAttribute('inert')).toBe(true);
    expect(background.hasAttribute('inert')).toBe(true);

    first.focus();
    expect(key(first, 'Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(key(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    background.focus();
    expect(document.activeElement).toBe(first);

    cleanup();
    expect(document.activeElement).toBe(launcher);
    expect(launcher.hasAttribute('inert')).toBe(false);
    expect(background.hasAttribute('inert')).toBe(false);
  });

  it('lets only the topmost nested dialog handle Escape and restores its launching field', () => {
    const launcher = document.createElement('button');
    const settingsOverlay = document.createElement('div');
    const settings = document.createElement('section');
    const folderLauncher = document.createElement('button');
    const settingsClose = document.createElement('button');
    settings.append(folderLauncher, settingsClose);
    settingsOverlay.append(settings);
    document.body.append(launcher, settingsOverlay);
    launcher.focus();

    const settingsDismiss = vi.fn();
    let closeSettings = () => {};
    closeSettings = bind(settings, settingsClose, () => {
      settingsDismiss();
      closeSettings();
    }, { label: 'Settings' });
    folderLauncher.focus();

    const folderOverlay = document.createElement('div');
    const folder = document.createElement('section');
    const choose = document.createElement('button');
    folder.append(choose);
    folderOverlay.append(folder);
    document.body.append(folderOverlay);
    const folderDismiss = vi.fn();
    let closeFolder = () => {};
    closeFolder = bind(folder, choose, () => {
      folderDismiss();
      closeFolder();
    }, { label: 'Choose folder' });

    expect(settingsOverlay.hasAttribute('inert')).toBe(true);
    expect(folderOverlay.hasAttribute('inert')).toBe(false);
    expect(folder.getAttribute('aria-label')).toBe('Choose folder');
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    try {
      const firstEscape = key(choose, 'Escape');
      expect(firstEscape.defaultPrevented).toBe(true);
      expect(folderDismiss).toHaveBeenCalledTimes(1);
      expect(settingsDismiss).not.toHaveBeenCalled();
      expect(appEscape).not.toHaveBeenCalled();
      expect(settingsOverlay.hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(folderLauncher);

      const secondEscape = key(folderLauncher, 'Escape');
      expect(secondEscape.defaultPrevented).toBe(true);
      expect(settingsDismiss).toHaveBeenCalledTimes(1);
      expect(appEscape).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(launcher);
    } finally {
      window.removeEventListener('keydown', appEscape);
    }
  });

  it('preserves background inertness and keeps newly mounted content inert', async () => {
    const background = document.createElement('main');
    background.setAttribute('inert', '');
    const overlay = document.createElement('div');
    const dialog = document.createElement('section');
    overlay.append(dialog);
    document.body.append(background, overlay);
    const cleanup = bind(dialog, null, () => {}, { label: 'Copy' });
    expect(document.activeElement).toBe(dialog);

    const lateBackground = document.createElement('aside');
    document.body.append(lateBackground);
    await Promise.resolve();
    expect(lateBackground.hasAttribute('inert')).toBe(true);

    cleanup();
    expect(background.hasAttribute('inert')).toBe(true);
    expect(lateBackground.hasAttribute('inert')).toBe(false);
  });

  it('consumes Escape at document capture even when its target is outside the dialog', () => {
    const background = document.createElement('button');
    const dialog = document.createElement('section');
    document.body.append(background, dialog);
    const dismiss = vi.fn();
    bind(dialog, null, dismiss, { label: 'Settings' });
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    try {
      const escape = key(background, 'Escape');
      expect(escape.defaultPrevented).toBe(true);
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(appEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', appEscape);
    }
  });
});
