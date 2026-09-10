export function showToast(message: string, parent?: HTMLElement, durationMs: number = 3000): void {
  const host = parent || document.getElementById('viewport') || document.body;
  let toast = document.getElementById('editor-toast') as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'editor-toast';
    toast.className = 'editor-toast';
    host.appendChild(toast);
  }
  toast.innerHTML = `<span style="font-size:16px;">💡</span> ${message}`;
  toast.style.display = 'flex';

  if ((toast as any).timeoutId) {
    clearTimeout((toast as any).timeoutId);
  }
  (toast as any).timeoutId = setTimeout(() => {
    toast!.style.display = 'none';
  }, durationMs);
}