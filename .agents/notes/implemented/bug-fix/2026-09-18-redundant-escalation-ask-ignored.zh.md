# Agent Note：冗余的升权请求会被忽略，而不是被拒绝

Status: implemented

[English](2026-09-18-redundant-escalation-ask-ignored.md) | 中文

## 问题

会把工具 schema 中**每个已声明属性**都填上的模型，会把可选的升权字段变成事实上的必填字段；本地 `codex` 路由上的两个会话（`gpt-5.6-terra`）展示了这样做的代价。

第一个会话在它的第一条 bash 命令上附加了 `sandbox_permissions: "danger-full-access"` 与 `justification: ""`。配对校验先于加宽检查，因此拒绝信息指向了为空的理由；模型把它读成“把理由写得更像句子”，于是准备了标题为 `Clarifying justification requirements` 的步骤，补上理由后重试——随后被严格更宽检查拒绝，因为该调用本就运行在 `danger-full-access`。这一轮消耗了四次 bash 调用、两次误导性拒绝，最后由用户中止。

让这些拒绝变成单次且具指导性——先判定不可能的请求、再读配对，并指明补救方式——仍然不够。第二个会话在**每次**调用上都发送 bash 的全部七个属性（`command`、`description`、`timeoutMs`、`workdir`、`run_in_background`、`sandbox_permissions`、`justification`），且 `justification` 每次为空；它把同一条命令重试了十次，在 `danger-full-access` 与 `workspace-write` 之间交替请求模式，始终没有去掉任何一个字段。它的推理摘要依次是 `Considering schema field omission`、`Assessing parameter requirements for schema`、`Planning custom schema handling`：它在努力满足一个它认为 schema 强加的要求。没有任何东西强加该要求——线缆上的 schema 只把 `command` 与 `description` 列为必填，也没有 `strict` 标志——但 harness 把“字段存在”读成了“提出请求”，而补救方式是“少发几个属性”的拒绝，无法被一个总是全部发送的模型满足。那条命令始终没有运行。

## 决策

升权参数会针对该调用原本会运行的模式来判定。无法加宽该模式的请求——即该调用本就运行在目标模式或更宽模式——会被**忽略**：调用在常驻策略下继续，`validateEscalationArgs` 返回 `'ignored'`，工具据此跳过审批步骤。可能加宽该调用的请求仍然需要满足配对：缺少理由、理由不驱动任何请求、或理由为空，都会被拒绝。模式不可解析（没有约束型执行器）时保留配对规则。

`isStrictlyWider` 仍是该阶梯的唯一归属；对于任何未经该判定就抵达审批步骤的调用方，`approveEscalation` 仍会执行它：工具先判定请求，授予路径独立拒绝。

被忽略的请求会在工作发生之处可见。`tool-bash` 与 `tool-pwsh` 在请求被忽略时，会向规范结果添加 `escalationIgnored` 事实，渲染器会在既有的拒绝标记与提示标记旁输出 `[sandbox: escalation to "<requested>" ignored — this call ran at "<mode>" mode]`（`escalationIgnoredMarker`）。该事实是输出 schema 的属性，因此它通过渲染后的结果抵达模型，而不是通过模型必须提供的参数；会把工具输出类型渲染进系统提示的 PTC 组合也会在该声明中展示它。filesystem 与 `run_code` 系列同样忽略冗余请求，只是不带该标记——它们的结果没有可挂载的沙箱事实。

描述文本保留此前决策的触发条件：只有 `[sandbox: escalation available` 标记才授权重试，参数错误不是拒绝，四个系列中的 `sandbox_permissions` 字段文本都这样说。

## 考虑过的替代方案

**拒绝冗余请求，并指明补救方式。** 这是本问题上的第一个决策，且按设计生效：把四次拒绝变成一次具指导性的拒绝。随后，一个总是填满所有属性的模型遇到它十次，命令始终没跑。补救方式为“去掉这些字段”的拒绝，对一个做不到的模型不可用：失败不在措辞，而在于依赖“省略”这件事本身。

**把字段存在当作意图。** 这正是失效的假设：`justification: ""` 不是理由，`sandbox_permissions` 也不是请求。在填满的 schema 中“存在”不等于意图，因此决策现在取决于请求的**效果**——它能否加宽本次调用——而不是字段是否存在。

**在无法兑现时不再广告这些字段。** 工具 schema 按组合构建一次，而模式与审批策略是每会话的事实；`danger-full-access` 组合仍需要一个被切换得更窄的会话所用的杠杆，这正是 `ESCALATION_TARGETS` 保持完整枚举的原因。按会话抑制这些字段需要注册表并不提供的按会话参数集。

**静默忽略。** 此前的决策以“奖励预先推测升权”为由否决了任何空操作。现在仍然发生的是忽略，但有了结果标记，模型会被告知该字段没有改变任何事，因此这次调用不会被读作升权成功，记录里也留下了该事实。改变判断的是实测代价：静默的风险小于一条永不运行的命令。

**只在理由为空时忽略。** 那会把一个缺少理由的、本可加宽的请求吞掉而不是拒绝它，而且它仍会拒绝那个清晰的场景——在 `danger-full-access` 下请求 `danger-full-access` 且带有理由。

## 后果

会把每个已声明属性都填上的模型，现在可以在其无法超越的模式下运行命令；本可加宽该调用的请求不受影响，而本可加宽它但配对不完整的请求仍然失败关闭。

`escalation.spec.ts` 固化决策表（冗余请求无论配对如何都返回 `'ignored'`；可加宽的请求保留其配对错误）、被忽略标记的文本，以及 `approveEscalation` 的不可加宽守卫。bash 与 pwsh 套件断言冗余请求会在没有审批请求的情况下运行命令并报告该标记；filesystem 套件断言变更会在没有审批请求的情况下发生。

bash、pwsh 以及四个 `sandbox_permissions` 字段描述改动了快照语料固化的文本，因此 `session` 与 `sdk` 两条通道的提示与工具 schema 附属文件已刷新，刷新不会重写的派生夹具已同步为同一文本；`docs/tool-catalog.md` 已重新生成。`escalationIgnored` 输出属性出现在语料固化的提示与 schema 附属文件中（PTC 会渲染工具输出类型），这些夹具随之更新。

持久化、凭据与会话格式行为没有变化：升权词汇、审批通道与授予范围与之前一致，冗余请求不会授予任何该调用本就没有的权限。
