export function statusView(state) {
<<<<<<< HEAD
  if (state === 'loading') return '加载中…';
  if (state === 'success') return '就绪';
=======
  if (state === 'error') return '加载失败，可重试';
  if (state === 'success') return '就绪（旧文案）';
>>>>>>> feature/error-branch
  throw new Error('未知状态: ' + state);
}
