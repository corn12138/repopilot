export const RUN_STATES = ['queued', 'running', 'done', 'cancelled'];

export function labelFor(state) {
  switch (state) {
    case 'queued': return '排队中';
    case 'running': return '运行中';
    case 'done': return '已完成';
    default: throw new Error('未处理的状态: ' + state);
  }
}
