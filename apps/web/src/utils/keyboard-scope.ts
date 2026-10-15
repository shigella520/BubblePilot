/** Canvas commands must never take over native editing or modal controls. */
export function isCanvasShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
    return false;
  return !event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        target.matches(
          'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], dialog',
        ),
    );
}
