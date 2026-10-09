/** True when keyboard input should go to a form control, not to editor shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  // While a dialog is open, keys belong to the dialog, not to the editor.
  if (typeof document !== 'undefined' && document.querySelector('dialog[open]')) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}
