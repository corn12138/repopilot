/**
 * 全局测试设置。
 *
 * 唯一的职责：把 testing-library 的异步等待窗口从默认的 1000ms 放宽。
 *
 * 为什么需要：`findBy*` / `waitFor` 默认只等 1 秒，而 App 级用例要等一整轮
 * bootstrap（doctor / project.list / model.listProfiles / run.list 四个并发请求）
 * 加上 jsdom 渲染。单文件跑绰绰有余，全量跑机器一忙就超时 —— 那是**环境慢**，
 * 不是断言错。这类红是最坏的一种：它教人无视失败。
 *
 * 放宽等待窗口不会让真正的失败变绿：断言不成立时，waitFor 仍然会在窗口结束时报错，
 * 只是慢一点。真正的死锁由 vitest 自己的 testTimeout（30s）兜住。
 *
 * 只在有 DOM 的环境里生效：Core 的用例跑在 node 环境，用不着也加载不动 DOM 工具。
 */
if (typeof document !== 'undefined') {
  // 从 react 包引：@testing-library/dom 只是它的传递依赖，不在直接依赖里
  const { configure } = await import('@testing-library/react');
  configure({ asyncUtilTimeout: 10_000 });
}
