/** Small DOM file helpers: hidden-input picker with cancel support. */

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    // Browsers without the `cancel` event: resolving on window focus keeps the
    // promise from hanging forever when the dialog is dismissed.
    const onFocus = () => {
      setTimeout(() => finish(input.files?.[0] ?? null), 500);
    };
    window.addEventListener('focus', onFocus, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
