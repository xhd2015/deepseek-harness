# Agent Note: 在侧边栏中显示当前 Session 所属项目

Status: implemented

[English](2026-09-18-sidebar-reveal-open-session-project.md) | 中文

## Problem

侧边栏把 Session 归组在所属 Workspace 下，而折叠的 Workspace 不渲染任何 Session 行。恢复 `?session=…` 或调用 `uiWorkspace.openSession(id)` 会选中一个 Session，但只要读者此前折叠过该 Workspace，它就会一直保持折叠：浏览器仅在该 Workspace 没有展开记录时才展开当前 Session 所属的分组。读者因此只看到一份未变化的折叠列表，只能逐个打开 Workspace 去找高亮行。折叠当前 Workspace 与折叠其他 Workspace 也无法区分，因为文件夹着色只在分组展开时才生效。

## Decision

选中 Session 会重新展开它所属的 Workspace。`WorkspaceBrowser` 观察 `list.current`，在每次 Session 变化时展开其分组一次，覆盖已存储的关闭记录；被处理的 Session id 保存在 `useRef` 中，因此随后再次折叠同一分组不会被下一次渲染撤销，也不会影响其他 Workspace。该规则在分组视图、Workspace 流就绪、没有进行中的搜索且没有全局面板时生效——与 Session 行判断“正在查看某个 Session”的方式一致。该规则在单列表视图和侧边栏轨道态下不生效。

持有当前 Session 的折叠 Workspace 保留两处标记：业务色文件夹图标（现在仅由归属关系决定），以及 2px 业务色前置色条（`Rows.module.css` 中的 `.projectRowCurrent`）。项目行同时带有 `aria-current="true"`。两处标记报告的都是读者自己的位置，而不是子级状态：折叠分组仍然不显示其 Session 的待交互或活动指示。

## Alternatives considered

**把 effect 留在 `SessionTree` 并去掉显式记录守卫。** `SessionTree` 在搜索进行时和单列表视图下会卸载，被跟踪的 Session 因此丢失，下一次挂载会重新展开读者已刻意折叠的分组。`WorkspaceBrowser` 在这些切换中始终存在。

**只要当前分组处于折叠状态就在每次渲染时展开。** 读者将永远无法折叠当前打开的 Workspace：它会在下一次渲染时重新展开。

**不跟踪 Session 变化而直接强制展开。** 与上一个方案等价：`setGroupExpanded(key, true)` 会因为折叠记录而反复触发。

**在五条 Session 折叠之外也显示当前 Session 行。** 每次打开 Session 都会让很长的项目整段渲染；折叠仍保持为用户手势，与普通浏览时一致。

**只给文件夹图标着色。** 在长长的 Workspace 列表中，16px 图标容易被忽略；前置色条在快速扫视时更可靠，并复用了拖拽标记的强调色写法。

**同时标记持有当前 Session 的已展开 Workspace。** 高亮的 Session 行已经表达了该状态，再给其表头加一处标记只是噪声。

## Consequences

该展开会像其他展开一样写入 `dsh.workspace.view.v5` 中的普通 `groupExpansion` 记录，因此会持久化：重新加载 `?session=…` URL 会再次展开该折叠 Workspace。这是折叠行标记的有意取舍——该标记服务于在一次访问中折叠当前 Workspace 的读者，而不是让它在全新加载后继续保持折叠。该规则取代 [Workspace 侧边栏顺序与折叠](../../archived/feature/2026-08-11-workspace-sidebar-order-and-folding.md) 中记录的“仅在无显式状态时展开”规则。

没有任何对模型可见、持久化或线上的变更：本次改动是客户端展示加上一次视图存储写入。`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` 固定了重新展开、折叠保持与标记；`rows.client.spec.tsx` 固定了行状态；`browser-styles.client.spec.ts` 依据 CSS 源固定了强调色声明。
