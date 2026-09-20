# Agent Note: Web runner 启动与持久输入框草稿

Status: implemented

[English](2026-09-20-web-runner-composer-drafts.md) | 中文

## Problem

工作树工具需要向已运行的 DSH Web 会话交付任务，包括发送前审阅模式以及大到无法放入命令行参数的提示词。仅保存在浏览器本地的草稿无法接收另一进程的文本，也无法跨浏览器 origin 保留。把未提交的任务记录为用户消息，会错误地将其视作会话内容，还可能启动模型工作。

## Decision

受支持的启动入口仍是 `dsh web open [dir]`。`-p` 与 `--prompt` 提供内联文本；`--prompt-file FILE` 读取 UTF-8 文本，不将文件内容重新展开为参数。内联输入与文件输入互斥，相对文件路径以调用方工作目录为基准，无效输入在创建 Session 前失败。提示词文本不进入会话 URL。Host 构建将 `./open` 子路径作为独立 bundle 与 `index`、`startup` 一同输出，因此已安装的 `dsh` 可以解析启动器行。已有的 [Web-open 决策](2026-09-16-web-open-from-cli.zh.md) 继续负责服务器发现、鉴权与浏览器选择。

创建 Session 后，启动器通过普通 Host prompt API 提交，除非 `--no-submit` 选择 `session/setDraft`。浏览器在操作确认后打开，打开行为与提交行为相互独立。浏览器打开失败只发出警告，不撤销已创建的 Session；输入操作失败会标识已经创建的 Session。浏览器绝不自动提交加载的草稿。

Session Controller 负责可冷读取的纯文本 `session/getDraft` 与 `session/setDraft` 操作。`session_composer_drafts` storage domain 在会话记录之外保存带版本的逐 Session 记录。空文本删除记录。两个操作均验证 Session 存在，但不激活 Agent，也不计算 projection。Storage-domain 写入提供持久化确认，销毁时等待待完成写入。Session 分叉不复制输入框状态。

浏览器保留带持久 `draftDirty` 标记的本地文本镜像用于即时恢复，然后读取 Host 草稿。未保存的本地文本（包括清空后的空文本）或读取期间发生的编辑优先。否则编辑器接受 Host 文本，即使已确认的本地镜像并非空文本，因此已保存的镜像不会恢复已在别处清空的任务。未保存的空值防止 Host 清空失败后在刷新时恢复陈旧的初始草稿。Host 确认仅在本地文本仍匹配时清除标记；缺少该标记的旧浏览器记录在完成同步前视为未保存。一个观察器串行写入并合并期间的编辑，包括普通提交清空与失败恢复。销毁时先脱离观察并立即销毁输入 shell，再等待已接受的写入。Host 采用最后写入生效的替换规则；这是持久恢复，不是协作编辑或标签页间实时同步。

`dsh-web` 集成是 agent-pro 中的浏览器交付路径，不是 PTY provider，也不返回流式代理结果。它调用受支持的 DSH 启动器并保留文件输入。wrk 选择浏览器专用参数，将 Session 身份交给 DSH，而不传入终端颜色参数或 agent-run 本地 Session id。完成意味着启动成功，不意味着模型已经完成任务。

## Alternatives considered

**将草稿保存为 Session 事件。** 未提交文本是可编辑的交互状态，不是模型历史。将其回放为用户消息会错误表达用户准入；仅用于 UI 的事件也会使每次按键进入会话记录生命周期。

**通过浏览器 URL 或仅通过 localStorage 携带提示词。** URL 传输会在浏览器历史中暴露任务文本，并受到 URL 长度限制。浏览器本地存储无法接收 Host 端启动请求，且仍按 origin 分区。

**把 dsh-web 注册为终端 runner。** PTY provider 负责就绪检测、终端注入与附着进程行为。仅为通过验证而声称支持这些能力，会为一次性浏览器启动附加无关的生命周期与身份规则。

**加入版本冲突或草稿实时广播。** 当前消费者需要初始交付与刷新恢复，而非并发编辑。串行 Client 写入防止本地响应乱序；版本和广播需要单独的多写入方产品决策。

## Consequences

草稿可跨 Host 与浏览器刷新保留，且不创建模型可见消息。[Host-backed preference 决策](../bug-fix/2026-08-06-host-backed-web-preferences.zh.md) 继续约束用户配置；与 Session 关联的草稿记录不是 settings。[输入框隔离提案](../../proposed/architecture/2026-09-14-composer-model-and-draft-editor.zh.md) 仍独立存在：持久文本不保留结构化引用、附件、光标状态、撤销历史或多个可编辑 root。

未保存的浏览器恢复文本（包括清空后的空文本）可以替换较新的 Host 值，因为本地未保存工作优先；已确认的镜像则在下次挂载时跟随 Host。不同标签页可以覆盖彼此保存的文本；没有合并或实时冲突 UI。关闭浏览器不保证运行中的网络写入完成，因此仍需本地镜像。启动器要求已有运行中的 DSH Web 实例，不启动替代服务器。

## Verification

聚焦 Host 测试覆盖冷读取、精确保留长 Unicode 文本、替换与清空、持久化重载、缺失 Session、存储失败，以及不创建 Agent 的插件销毁与重开。CLI 测试覆盖提示词解析、文件输入、Host 准入与草稿写入的区别，以及浏览器失败报告。浏览器持久化测试覆盖未完成读取、编辑优先级、写入合并、失败和销毁。组装 GUI 与无密钥快照验证仍是独立的集成证据；这些聚焦检查不代表完整 GUI 测试集通过。
