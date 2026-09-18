# Agent Note：只拒绝单个模型，而不是整个命名空间

Status: implemented

[English](2026-09-18-refuse-one-model-not-the-namespace.md) | 中文

## Problem

`llm-pi-ai` 的 settings 段是按一个命名空间整体校验的，因此 schema 拒绝一个取值就会拒绝其中的每个提供方。一个拼错的等级键——`reasoningEfforts: { max: max, ultra: ultra }`，其中 `ultra` 是协议拼写而不是 pi-ai 的等级之一——代价是整个 `llm-pi-ai` 段：`grok`、`codex`、`ais` 与被编辑的提供方都保持原状态，该键所指的路由丢掉它的模型，而界面上没有任何提示。`SettingsProvider.publish` 把这次失败收敛为一条 `settings: keeping last good "llm-pi-ai" after invalid stored section`，只到达服务端日志；Models 页面渲染的是上一份可用行，选择器提供的是上一份可用模型，用户唯一的信号就是这份沉默。

影响范围比"看不见某一行"更大。一次运行中的拒绝会让已存段处于中毒状态：之后对该命名空间的任何写入都会重新解析整段，因此编辑一个无关提供方也会被 codex 的错误拒绝，而出错键所在的数组元素根本无法被路径操作寻址。冷启动时该段连注册都会失败——`register` 是内联解析的，此时还没有"上一份可用值"——于是该命名空间从 `settings.describe()` 中消失：所有 pi-ai 路由消失，修复写入返回 `settings namespace "llm-pi-ai" is not registered`。最需要编辑界面的状态恰恰没有界面，只能手工编辑文档。

## Decision

`reasoningEfforts` 在 schema 边界接受任意键，由解析步骤拒绝命名了 pi-ai 不认识等级的那一个模型条目。该检查在读取已声明集合之前执行，因此只含拼写错误的字典会指出这些拼写，而不是报告"没有提供 off 之外的等级"；它在 `resolveRouteModels` 的逐条目 catch 内部抛出 `PiAiCatalogError`。这一个位置同时继承了代码库已有的两种行为：延迟校验——已存文档读取路径——把消息记入 `modelErrors` 并只丢掉该条目，而严格解析通过 `assertServiceable` 拒绝引入它的那次写入。

被拒绝的模型是"列出"而不是"隐藏"。`llm-pi-ai` 在可配置提供方目录中报告其 `modelErrors`，其适配器的 `listModels` 返回可用模型，随后为每条拒绝附带一个携带新字段 `LlmModelInfo.unavailable` 的条目。编辑器的模型选择器把该条目渲染为置灰并显示原因，`/model` 弹层把它标记为不可用并以适配器自己的文本回应选择，Models 页面在对应模型行上显示同一段文字——而那正是消息所指字段被编辑的地方。`ModelCatalogModel.unavailable` 将它穿过宿主目录，`buildModelCatalog` 从已有列表中投影被拒条目，而不是去解析元数据：那次解析会抛出同一个拒绝，而构建器的按提供方 catch 会把它变成组级失败，从而隐藏该路由健康的模型。

已经停在被拒模型上的选择通过该 seam 已有的机制阻塞输入框：`ModelDirectory` 从被选模型上读出拒绝并发布为 `unavailableReason`，因此 `ctx.conversation.blocks` 携带的是适配器的文本，而不是本插件的通用文案。只有显式拒绝才会阻塞——不在目录分组中永远不阻塞，因为一个不再公布某模型的路由仍可正常使用。

`ultra` 等级可达的写法是 `max: ultra`：可选键是 pi-ai 自身的等级集合，而值才是分派时发送的内容。

本决策细化了 [pi-ai 目录变化后的可修复设置](../bug-fix/2026-09-07-pi-ai-settings-catalog-recovery.zh.md)：注册期容忍目录诊断、注册后对已变更提供方严格校验的规则不变，被拒模型从"只存在于设置中"变为"在列表中可见且不可选"。

## Alternatives considered

**改为在描述符中报告拒绝。** `SettingsNamespaceView` 可以携带被拒命名空间与 schemastery 消息，Models 页面无需改动 pi-ai 就能渲染一条横幅。它命名的是段而不是模型，被拒条目仍然不被列出，而且对冷启动场景毫无帮助——那时注册在任何命名空间视图存在之前就已失败。

**在 settings seam 内按提供方解析。** seam 无法把一个命名空间拆成可独立校验的单元：只有拥有方知道哪个子树算一个模型条目。逐模型的粒度必须来自拥有方自己的解析。

**保留现有的 `serviceableModels` 过滤并隐藏被拒条目。** 这正是代码库对目录漂移的做法，也正是用户看不到文档配置了什么的原因。本该携带诊断的那一行，恰好就是消失的那一行。

**放宽键类型但不加解析期检查。** 实测：`{ low: low, max: max, ultra: ultra }` 随后解析时完全不产生诊断——三个模型全部提供服务、`modelErrors` 为空——因为已声明集合与 thinking 等级映射都是遍历 `THINKING_LEVELS` 构建的。被静默忽略的字段比它所替代的拒绝更糟。

**把 `ultra` 加为 thinking 等级。** 等级集合属于 pi-ai（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）；`ultra` 是 codex 代理在协议上接受的一个值，因此选择器中一个标注为 "Ultra" 的等级在不改动上游的前提下无法表达。

**把改动扩展到全部 profile 词汇。** `api`、`compat` 各词汇、`transport`、`cacheRetention`、`input` 以及数值边界都会以同样方式吞掉一个拼写错误。每个字段都需要各自确认其错误是逐模型的 `PiAiCatalogError` 而非路由级失败，因此其余字段维持现状。

## Consequences

本次只覆盖 `reasoningEfforts` 这一类；上述 profile 词汇仍存在同样的陷阱。

写入路径仍然拒绝该取值，但消息现在来自解析而不是 schema：`config.spec.ts` 通过 `assertServiceable` 断言含路由名与模型名的文本，而 `{ high: 42 }`——类型错误而非词汇错误——仍然由 schema 拒绝。`dynamic-config.spec.ts` 固定了列表形态（一个可用条目加一个携带原因的拒绝条目）、逐模型的目录诊断、在任何提供方 I/O 之前以 `INVALID_CONFIG` 拒绝的请求、无关提供方仍可编辑，以及用于修复的数组替换。`session-models.host.spec.ts` 固定了被拒条目不会使其提供方分组崩溃。客户端测试固定了置灰并带原因的行、弹层的不可用标记与拒绝、携带适配器文本的输入框阻塞、键盘导航跳过置灰行，以及既有规则：不在目录中永不阻塞。

含多个拼错模型的文档一次报告一个：路由级 `error` 是 `modelErrors` 的第一条，而逐模型映射把这些全部带给会渲染行的界面。

不改变任何持久化或对模型可见的内容。`reasoningEfforts` 属于配置，拒绝是按操作派生的，没有任何 session 事件、线上载荷或持久记录新增字段。
