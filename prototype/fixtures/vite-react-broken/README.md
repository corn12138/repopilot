# vite-react-broken

**这个仓库是故意坏的。** 别修它。

一个最小的 Vite + React + TypeScript 购物车页面，带一个真实的构建错误：
`applyDiscount()` 重构成返回 `DiscountResult` 对象了，但 `CartSummary.tsx`
还把它当 `number` 传给 `formatMoney()`。

```
src/components/CartSummary.tsx(19,26): error TS2345:
  Argument of type 'DiscountResult' is not assignable to parameter of type 'number'.
```

它是端到端测试的目标仓库，也可以在应用里当第一个任务目标 —— 导入它，
让 Agent 去修。

## 两件容易困惑的事

**为什么这里没有 `.git`？**

嵌套 git 仓库会被外层仓库当成 gitlink，clone 下来是空目录，测试直接废掉。
所以端到端测试会把这个目录**复制到临时位置再初始化 git**，源目录始终保持无 VCS 状态。
你在这里执行 `git status` 会提示不是仓库，是预期的。

**为什么要装依赖？**

因为验证是真跑 `tsc --noEmit && vite build`，不是模拟的。没有 `node_modules`
测试会以明确的错误信息退出，而不是假装通过。

```bash
npm install
```
