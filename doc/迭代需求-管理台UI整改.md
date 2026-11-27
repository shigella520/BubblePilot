# 迭代需求：管理台 UI 整改

> 状态：第 1～3 阶段主体及第 4 阶段部分条目已在本地实现（未部署），剩余条目见“未完成项”。整理日期：2026-11-27。依据为 `apps/web/src` 的只读代码审查（未改代码、未做截图验收），部分结论已抽查源码确认；标注“待确认”的条目需先核实。路径相对 `apps/web/src`，行号为审查时位置。

## 现状概览

- **路由**：10 个（登录、概览、消息、自动化列表与画布、插件、表情包、AI 服务、执行与审计、设置）；顶部胶囊导航，≤860px 变为底部固定导航。
- **页面骨架 4 种**：`split-admin-page`（AI、自动化、执行、消息、设置）、`admin-workspace`（概览）、私有布局（插件、表情包）、全屏画布。
- **共享组件**：AdminDetailDialog、AdminFormDialog（脏检查与内嵌解锁）、DismissibleMessage、CursorPagination、ToggleSwitch、SectionNavigation、SensitiveUnlock。
- **样式**：`styles/tokens.css` 仅 22 行颜色/圆角变量；`styles/base.css` 3567 行全局类，含 109 个硬编码 hex、150 处 rgba、23 种字号、24 种圆角；另有 30 余个组件 scoped style。
- **反馈与授权**：`services/api.ts` 的 `errorMessage()` 把错误码和请求 ID 拼进文案；各页自管提示字符串；`sensitiveActive` 由各页自行判断。

优先级：P0 必须 / P1 应该 / P2 可选。工作量：S / M / L。

## 0. 基础件（先做，其余整改大多依赖）

| 编号 | 问题 | 位置 | 建议 | 优先级 | 量 |
| --- | --- | --- | --- | --- | --- |
| F-01 | 设计变量不全、硬编码泛滥：字号 23 种（9px/10px 共 56 处）、圆角 24 种；主蓝有 `#0a84ff` 与 `#2563eb` 两套 | `styles/tokens.css`；`styles/base.css`；`components/ToggleSwitch.vue:27,41`；`views/MemesView.vue:1443-1864` | 扩充语义色（成功/警告/危险/信息/中性）、间距、字号（正文≥12px）、圆角 3 档、阴影、断点；stylelint 禁止新增裸色值和未定义变量 | P0 | M |
| F-02 | 引用未定义的 CSS 变量，样式静默失效（`--bubblepilot-blue` 6 处，另有 `--text-muted`、`--border-color`、`--surface` 等多套） | `base.css:1594,1857,1943,2111,2596,2667`；`MessagesView.vue:1903`；`PluginsView.vue:690,701,740`；`MemesView.vue:1443,1469`；`workflow/NodeInspector.vue:500,506`；`MemoryPanel.vue` | 统一替换为 `--bubblepilot-*` 并纳入 lint | P0 | S |
| F-03 | 按钮体系失控：裸 `.button` 无背景边框（12 处，看起来像文字）；`button danger` 变体不存在；插件页按钮不用 `.button`，“卸载”和“保存”同样式；删除按钮 5 种写法 | `base.css:580-622`；`NodeInspector.vue:475`；`AutomationView.vue:1643`；`PluginsView.vue:430-435,546,654-665,722-727,796`；`MemoryPanel.vue:603,632,687,716,732,943` 等 | `<AppButton variant size loading>`；规则：每区块一个主按钮，删除/卸载统一危险样式且带文字 | P0 | M |
| F-04 | 无统一状态徽章与中文映射：依赖类名等于后端枚举；`neutral`、`status-badge` 无样式；概览把“需关注”标红、“结果未知”标成失败红；索引任务成功/失败都是灰色 | `base.css:623-666,2966-2980`；`DashboardView.vue:154,271`；`ExecutionTriggerMessage.vue:142-152`；`ExecutionTimingSummary.vue:24-45,150-163`；`PluginOverviewCard.vue:190-200`；`MemoryPanel.vue:777` | `utils/status-labels.ts`（领域→枚举→文字与语义色）+ `<StatusBadge>`，图标加文字，未知值中性兜底 | P0 | M |
| F-05 | 反馈组件问题：右下角提示不自动消失、成功也用 `role="alert"`；移动端与底部导航重叠；同一消息在页面和对话框重复显示；部分错误是不可关闭的裸段落；`saveContextSettings` 不重置错误态导致“已保存”显示为红色；插件安装、保存、启停、回滚成功无提示 | `DismissibleMessage.vue:9-14`；`base.css:786-833,1411-1415,3248-3255`；重复：`MessagesView.vue:1088`、`AiView.vue:1357-1366,1466-1474,1603,1690`、`PluginsView.vue:437-440,477`、`MemesView.vue:849,1032,1131`；`AiView.vue:343-358`；`PluginsView.vue:311-396` | `useNotify()` 队列（成功 4 秒自动消失、`role="status"`；错误常驻）+ `<InlineAlert>`；错误在发生处展示，不重复；避让底部导航 | P0 | M |
| F-06 | 错误文案暴露错误码：`errorMessage()` 拼接“（CODE · 请求ID）”，仅翻译 7 个码；插件页另有映射且丢失请求 ID；表情包直接显示 `e.message` | `services/api.ts:135-156`；`utils/plugin-feedback.ts:19,45-56`；`MemesView.vue:434,478,500`；`MemeDeliveries.vue:75` | 返回 `{标题, 下一步, 错误码, 请求ID}`；界面只显示中文说明，码与 ID 收进可复制的“诊断信息”；集中错误码词典 | P0 | M |
| F-07 | 对话框实现分裂：消息图片详情、执行详情、表情包编辑为手写实现（焦点不受控、无 Esc、点外部丢编辑）；共享对话框无尺寸变体；主按钮不在底部操作区、标题重复；定时任务编辑无脏检查和解锁 | `MessagesView.vue:1666-1873`；`ExecutionsView.vue:910-980,1519-1580`；`MemesView.vue:1018-1030,1100-1110`；`AdminDetailDialog.vue:37-44,56`；`AiView.vue:1357-1366` 等；`ScheduledTasksPanel.vue:548-567` | 共享对话框加尺寸；编辑类一律用表单对话框、主按钮放 `#actions`；迁移手写对话框 | P0 | L |
| F-08 | 破坏性操作确认无规律：14 处原生 `confirm()` 风格不一、不说明影响；而取消定时任务、跳过下一次、取消索引任务、切换索引代次、停用检索、插件回退版本、回填归属等无确认；画布 Delete 直接删节点 | `confirm(`：Messages、Memes、Ai、Plugins、Executions、Automation 等；缺确认：`ScheduledTasksPanel.vue:307-319,473,488-499`、`MemoryPanel.vue:631-637,957-976`、`PluginsView.vue:739-748`、`BotIdentityPanel.vue:238`、`WorkflowEditor.vue:755-759` | `useConfirm({标题, 影响, 危险, 确认文字})` 与规则表：删除、卸载、取消任务、切换线上版本、批量写入必须确认；启停给撤销提示；画布删除可撤销 | P0 | M |
| F-09 | 敏感授权门控五花八门：有的只禁用不说明，有的只写在 title，有的写“请先在顶栏解锁”；表单对话框锁定时仍可编辑、提交才报 403；AI、表情包、自动化前端无门控；执行详情打开时顶栏被 inert，解锁按钮点不到；三种叫法；顶栏看不到剩余时间 | `AdminFormDialog.vue:45-54`；`AiView.vue:1350,1596`；`ExecutionsView.vue:723-730,920-925,1548-1563`；`MessagesView.vue:738-760,1001`；`MemoryPanel.vue:551,944`；`AppHeader.vue:92-94` 等 | `<SensitiveGate>`：锁定原因 +“立即解锁”（对话框内可用）；锁定时整体禁用；授权策略表前后端对齐；统一称“敏感操作授权”；顶栏显示剩余时间 | P0 | M |
| F-10 | 列表加载/空/错误状态缺失：首次加载先显示空状态；失败时空状态和错误同时出现；`Promise.all` 一处失败整页变空；设置页失败只剩标题 | `MessagesView.vue:516-531,950-962`；`AutomationView.vue:480-503`；`DashboardView.vue:92-118`；`PluginsView.vue:452-454`；`AiView.vue:320-336`；`SettingsView.vue:72-86` | `<AsyncSection>` 三态；按区块 `allSettled` 降级（可参照 `ScheduledTasksPanel.vue:345-353`） | P0 | M |
| F-11 | 时间、数字、单位格式不统一：52 处 `toLocaleString()`；字节不换算；毫秒与秒混用；图片限制要求填原始字节数 | `MessagesView.vue:1522`；`ExecutionsView.vue:1754,2236`；`MemoryPanel.vue:425-426`；`AgentBudgetDetails.vue`；`AiView.vue:1131-1146,1618-1640` | `utils/format.ts`（固定 zh-CN 24 小时制、相对时间、字节、时长）；输入框带单位 | P1 | S |
| F-12 | 开关三套实现（ToggleSwitch、私有 `.switch-button` 无 `role="switch"`、原生复选框） | `MessagesView.vue:997-1012`；`AutomationView.vue:1251-1258`；`AiView.vue:1515-1523`；`SettingsView.vue:282-292`；`IdleTriggerSettings.vue:70-77`；`AttachmentHandlingSettings.vue:109-117` | 启用类统一 ToggleSwitch | P1 | S |
| F-13 | 页面骨架不统一：插件、表情包自建布局与双重内边距；h1 位置与数量不一（AI 页两个 h1）；AI 侧栏标题与导航名不一致；自动化侧栏只有一个不可点按钮；导航与区块图标重复 | `PluginsView.vue:421-436`；`MemesView.vue:679-688`；`AiView.vue:828,858,1180`；`AutomationView.vue:935-946`；`ExecutionsView.vue:1108-1112`；`AppHeader.vue:80-89` | `<PageLayout>` + `<PageSection>`；每页一个 h1；图标不重复 | P1 | M |
| F-14 | 未保存修改保护不一致：仅表情包有离开守卫；画布记录了 dirty 却不拦截；设置类表单“刷新”直接覆盖；AI 页“测试”重载整页冲掉其他表单；插件启停重置脏检查基线 | `WorkflowCanvasView.vue:76,283-285,320-324`；`SettingsView.vue:180`；`NetworkSettingsPanel.vue:67`；`AiView.vue:597`；`MemesView.vue:574-597`；`PluginsView.vue:353-365`；`AdminFormDialog.vue:26-32` | `useDirtyGuard()`（路由离开 + 关闭页面）；刷新与测试前确认；测试只刷新被测对象 | P0 | M |
| F-15 | 刷新与轮询策略各异：表情包 5 秒轮询不判断可见、失败静默、卡片跳动；执行列表和详情从不刷新，“运行中”一直挂着；刷新按钮有的无忙碌态 | `MemesView.vue:438-469,656-670`；`services/progress-poller.ts`；`ExecutionsView.vue:982-987` | `useAutoRefresh()`：有进行中条目才轮询、隐藏时暂停、显示“更新于”；统一刷新按钮 | P1 | M |
| F-16 | 分页与表格容器不统一（定时任务、表情包各自分页；`.table-scroll` 与 `.table-shell` 两套） | `ScheduledTasksPanel.vue:524-541`；`MemesView.vue:996-1016` | 统一分页组件与表格容器 | P2 | S |
| F-17 | 长 ID 展示不一：有的截 8 位且不可复制，有的整段完整 ID 当第二行 | `DashboardView.vue:360-369`；`ExecutionsView.vue:1374-1390`；`AutomationView.vue:1180` | `<CopyableId>`：短显示、悬停全文、点击复制 | P2 | S |

## 1. 明显缺陷（可立即修）

| 编号 | 问题 | 位置 | 建议 | 优先级 | 量 |
| --- | --- | --- | --- | --- | --- |
| B-01 | Provider 卡片多出字面量 `>`（显示为“> API Key 已配置”），已确认 | `AiView.vue:1257-1258` | 删除 | P0 | S |
| B-02 | `button danger` / `button tiny danger` 无定义，“删除动作块”按钮无样式 | `NodeInspector.vue:475`；`AutomationView.vue:1643` | 改用危险样式 | P0 | S |
| B-03 | 概览表情投递区块用了无样式的 `panel` 类 | `DashboardView.vue:335` | 改为 `admin-panel` | P0 | S |
| B-04 | 概览指标口径错：“监听中的聊天”未过滤启用；“最近执行”取 `limit=8` 条数，永远 ≤8（已确认） | `DashboardView.vue:84-86,97-108,182,198` | 改为启用计数、按时间窗统计或改名“最近 8 条” | P0 | S |
| B-05 | 画布“测试执行”是占位按钮，只提示“将在下一步接入”（已确认） | `WorkflowCanvasView.vue:278-282,364-366` | 先隐藏或跳转到触发预览/执行记录 | P0 | S |
| B-06 | 自动化页残留 4 大块 `v-if="false"` 死代码（旧编辑器、AI 生成器、JSON 表单、Bot 触发器区） | `AutomationView.vue:1006,1025,1081,1431-1676` | 删除 | P1 | M |
| B-07 | 画布保存失败或有未保存修改时仍显示绿色对勾 | `WorkflowCanvasView.vue:337-339`；`base.css:874-883` | 已保存/未保存/保存中/失败四态 | P1 | S |
| B-08 | 画布加载失败（含工作流不存在）仍渲染可编辑空画布，保存会请求不存在的 id | `WorkflowCanvasView.vue:139-163,410-420` | 错误页 +“返回列表/重试” | P0 | S |

## 2. 交互流程

| 编号 | 问题 | 位置 | 建议 | 优先级 | 量 |
| --- | --- | --- | --- | --- | --- |
| I-01 | “测试”与“保存”关系各页不同：设置页测的是已保存配置但未说明；AI 只能在列表测已保存配置，结果压成一句提示；插件必须先测才能存；长期检索测草稿 | `SettingsView.vue:127-132,189-206`；`AiView.vue:551-597,1278-1286`；`PluginsView.vue:551-582,721-723`；`MemoryPanel.vue:603-606` | 统一：表单底部“测试当前填写”+“保存”，结果在表单内结构化展示（各项检查、HTTP 状态、请求 ID）；只能测已保存的写明 | P0 | M |
| I-02 | 插件“确认安装/保存配置与授权”未测试时禁用且无说明；改任何连接字段重置测试状态 | `PluginsView.vue:551-582,721-723` | 旁注“修改连接后需重新测试”，测试按钮挪到保存旁 | P0 | S |
| I-03 | 禁用不说明原因普遍存在（自动化启停、画布主动发言确认、Inspector 插件勾选、执行“人工关闭”） | `AutomationView.vue:1251-1258`；`WorkflowCanvasView.vue:398-407`；`NodeInspector.vue:267`；`ExecutionsView.vue:1548-1563` | 凡禁用必给原因（参照 `AttachmentHandlingSettings.vue:121`） | P1 | S |
| I-04 | 工作流“保存即发布”不可见：启用状态下保存直接上线；侧栏“保存后立即生效”与画布“请在顶部启用”矛盾 | `WorkflowCanvasView.vue:176,196-225`；`AutomationView.vue:944` | 启用时按钮写“保存并发布”或拆“保存草稿/发布”；页头显示编辑版本与线上版本 | P0 | M |
| I-05 | 画布主操作分散两条工具栏；导出要求先保存但点击后才报错；确认框主按钮无主样式 | `WorkflowCanvasView.vue:289-292,350-377,398-407`；`WorkflowEditor.vue:764-789` | 保存放页头紧邻状态；有未保存修改时导出禁用并说明 | P1 | M |
| I-06 | 画布前端校验仅 3 条，结果在无样式段落，不定位节点或字段 | `WorkflowEditor.vue:577-610,760-762` | 选中出错节点并在 Inspector 字段旁报错 | P1 | M |
| I-07 | Inspector 字段顺序乱：AI 节点名称排在插件/附件/生图之后；“采用新输出策略”是裸按钮 | `NodeInspector.vue:309-326` | 名称/描述 → 输入 → 基础配置 → 高级能力 → 危险操作 | P1 | S |
| I-08 | 定时任务时间要手写 ISO、时区自由文本；“先预览才能保存”说明预览后被隐藏 | `TaskScheduleEditor.vue:51-63,105-109`；`ScheduledTasksPanel.vue:612-617,633-635` | `datetime-local` + 时区下拉；前置说明常驻 | P1 | M |
| I-09 | 消息搜索在已授权时进入页面不自动执行，先显示“没有搜索结果” | `MessagesView.vue:863-874,883-886,1393` | 挂载即搜索或区分“尚未搜索” | P1 | S |
| I-10 | 导出/搜索时间范围不做前端校验（顺序、最长 31 天） | `MessagesView.vue:738-745` | 内联校验 | P1 | S |
| I-11 | 成员映射按钮打开对话框时变“收起”；搜索结果显示原始 senderId 而不用映射名 | `MessagesView.vue:990,1361` | 去掉“收起”；显示映射名，ID 作副信息 | P1 | S |
| I-12 | 插件安装与管理挤在一个超长对话框；“查看指令”内容出现在最底部 | `PluginsView.vue:456-479,670` | 拆 Tab/步骤；指令就地展开 | P1 | M |
| I-13 | 执行列表无筛选（工作流、聊天、状态、时间）；切换按钮无 `aria-pressed` | `ExecutionsView.vue:1305-1343` | 统一筛选栏 | P1 | M |
| I-14 | AI 页 Provider 用卡片、路由用表格；上下移动一个用字符一个用图标 | `AiView.vue:1201,1496,1546-1563,1665-1679` | 统一列表形态与行操作 | P2 | M |
| I-15 | Agent 设置为行内编辑、定时任务设置为摘要卡+对话框；前者无授权门控，“恢复默认值”用成功色 | `AgentSettingsPanel.vue:69,74-153`；`ScheduledTaskSettingsPanel.vue:102,229-238` | 统一设置区块模板 | P1 | M |
| I-16 | 登录后固定跳首页，丢失原目标；登录错误用浮动提示 | `LoginView.vue:22,54`；`App.vue:16-17` | 记录 redirect；错误内联 | P2 | S |

## 3. 文案与术语

| 编号 | 问题 | 位置 | 建议 | 优先级 | 量 |
| --- | --- | --- | --- | --- | --- |
| C-01 | 同一概念多种叫法：长期检索/长期聊天检索/长期记忆/历史索引/历史补建/索引代次；工作流/自动化；启用/停用与接收中/已停止；死信/重试耗尽；两个面板标题相同；插件工具授权被写成“本工作流需要的能力” | `MemoryPanel.vue:492-524,556,629`；`MessagesView.vue:1171`；`AiView.vue:833`；`ExecutionsView.vue:1111,1299`；`BotIdentityPanel.vue:158,186,238`；`AutomationView.vue:1258-1270`；`PluginToolPicker.vue:47` 等 | 术语表（如：功能“长期记忆”、任务“索引任务”；对象“工作流”、导航“自动化”；启停统一“启用/停用”） | P1 | S |
| C-02 | 中英混排：英文小标题（MONITORING、ARCHIVE SEARCH…）、Server URL/Base URL/Fallback/Schema 等标签、none/minimal/high 选项值、空格不一 | `MessagesView.vue:920,1186,1411,1680`；`AutomationView.vue:957,974-995`；`SettingsView.vue:243-294`；`AiView.vue:1093-1095,1398-1405`；`PluginsView.vue:546,570` | 小标题中文或去掉；协议与专有名词（API Key、Webhook、MCP）保留英文，其余翻译；选项值中文映射 | P2 | S |
| C-03 | 原始枚举与错误码直接展示（工作流状态、聊天类型、链接预览/诊断/导出状态、审计字段、节点类型、reason_code/error_code、索引代次 ID 等） | 涉及 Automation、Messages、Dashboard、Ai、Executions、WorkflowNode、ScheduledTasks、BotIdentity、MemoryPanel、Plugins、Memes 多处 | 依托 F-04/F-06 字典；原始码只进“诊断信息”或提示 | P0 | M |
| C-04 | 用方位或页面名指路而不给链接（“请在顶部启用”“到执行与审计→历史索引查看”“在 AI 服务中配置”） | `WorkflowCanvasView.vue:225`；`MessagesView.vue:93-94`；`MemesView.vue:433,683`；`ScheduledTaskSettingsPanel.vue:102` | 一律改为链接或内嵌操作按钮 | P1 | S |

## 4. 信息架构

| 编号 | 问题 | 位置 | 建议 | 优先级 | 量 |
| --- | --- | --- | --- | --- | --- |
| A-01 | “执行与审计”成杂物间：AI 用量、空闲交流审计、定时任务列表、索引任务都在这里，而对应配置在别处 | `ExecutionsView.vue:1107-1112,1126-1288,1455-1457` | **方案 A（推荐）**：导航重组为 概览 / 消息 / 自动化（工作流、定时任务、空闲交流）/ AI（Provider、路由、Agent、长期记忆、联网、用量）/ 插件与表情包 / 执行与审计（执行记录、审计）/ 系统设置。**方案 B（最小改动）**：保持结构，每对“配置↔运行记录”加双向链接 | P1 | L |
| A-02 | 设置分散：插件工具预算、定时任务全局设置在系统设置页，插件页、自动化页无入口；网络设置提到插件与 MCP 无链接 | `SettingsView.vue:149-160,325-326`；`NetworkSettingsPanel.vue:71-73` | 设置跟着功能走，或至少双向链接 | P1 | M |
| A-03 | 长期记忆面板挂在 AI 页、执行页、消息对话框三处，标题各不相同、互不相通 | `AiView.vue:847`；`ExecutionsView.vue:1457`；`MessagesView.vue:1175` | 统一标题并互相跳转 | P1 | S |
| A-04 | 列表中的对象不可跳转：执行行的工作流、聊天，概览最近执行，用量里的 Provider | `ExecutionsView.vue:1374-1390`；`DashboardView.vue:360-369` | 出现其他实体名或 ID 就可点击进入 | P1 | S |
| A-05 | 跳转写法三种（`/#/…`、`#/…`、RouterLink） | `AiView.vue:1101`；`IdleWorkflowPreview.vue:321,366`；`ScheduledTasksPanel.vue:755,820` | 统一 RouterLink + 命名路由 | P2 | S |
| A-06 | 自动化列表上方常驻四个开发者用的复制按钮（Schema、Binding Catalog、编写指南、标准提示词） | `AutomationView.vue:974-995` | 收进“开发者资源”菜单 | P2 | S |
| A-07 | 自动化列表“匹配方式/内容”读旧 `/api/v1/triggers`，仅在画布配置触发器的工作流可能显示“未启用触发器”（**待确认**） | `AutomationView.vue:461-476,1207` | 核实后改为读已发布定义 | P1 | M |

## 5. 可访问性与响应式

| 编号 | 问题 | 位置 | 建议 | 优先级 | 量 |
| --- | --- | --- | --- | --- | --- |
| X-01 | 焦点可见性弱：输入框焦点只有极淡阴影；部分 `outline:0`；按钮无 `:focus-visible` | `base.css:870-872,1609-1613,2432` | 统一 2px 强调色描边 | P1 | S |
| X-02 | 9～10px 字号 56 处，叠加弱化色与玻璃背景（对比度**待实测**） | `base.css:547,623-635,729,784` 等 | 下限 12px，徽章 11～12px | P1 | S |
| X-03 | 输入框与图标按钮缺标签（成员映射、画布名称与返回、节点搜索、“×/＋”字符按钮）；快捷键不可见 | `MessagesView.vue:1122-1138`；`WorkflowCanvasView.vue:320-335`；`NodeCreator.vue:36,49-51`；`NodeInspector.vue:192`；`WorkflowEdge.vue:46`；`WorkflowNode.vue:122,140,159` | 补 aria-label；换图标并在 title 标快捷键 | P1 | S |
| X-04 | 插件卡片整卡 aria-label 覆盖内容，读屏听不到启用状态与待审工具 | `PluginOverviewCard.vue:56` | 改用 `aria-describedby` | P1 | S |
| X-05 | 画布不可键盘操作；点空白即弹“添加动作”与平移冲突 | `WorkflowEditor.vue:792-795,809`；`WorkflowNode.vue` | 节点可聚焦、Inspector 提供“连接到…”；添加动作改双击或按钮 | P2 | L |
| X-06 | 用量图表仅鼠标可读 | `AiUsageChart.vue:3-7,168,172` | `role="img"` + 表格视图 | P2 | S |
| X-07 | 断点散乱（560/600/640/680/700/760/860/900/1180） | `base.css:1404,3145,3207,3238,3337,3351` 及多组件 | 收敛为 3 档 | P2 | S |
| X-08 | 画布页头不换行窄屏溢出；高度写死 `calc(100vh-240px)` 且最小 700px；Inspector 浮层无遮罩、不能 Esc | `base.css:846-918,1256-1268,1404-1410` | 页头换行、次要操作收进“更多”；用 dvh；小屏底部抽屉 | P1 | M |

## 第 1 阶段实施记录（本地，未部署）

- **已完成**：B-01～B-05、B-08；F-01（扩充语义色、字号与间距变量，最小字号 11px）、F-02（未定义变量全部替换）、F-03（裸 `.button` 默认显示为次要按钮，补齐 `danger` 变体，插件页改用共享按钮，删除类统一为 `danger-ghost`，按钮键盘焦点环）、F-04（`utils/status-labels.ts` 与 `StatusBadge`，已用于概览、自动化、导出、索引任务）、F-05（成功提示 5 秒自动消失并改为 `role="status"`，错误提示不透明，移动端避开底部导航，AI 页成功提示不再沿用红色）、F-06（错误码、请求 ID 与未翻译的服务端英文移入“诊断信息”小字，按 HTTP 状态给出中文说明，插件页同格式）、F-10（概览、自动化、AI 页按区块加载，单项失败只提示该项；首次加载显示“正在加载”）、F-11（`utils/format.ts`，33 处时间显示改为固定 `YYYY-MM-DD HH:mm:ss`）。

- **提示位置规则（2026-11-27 补充）**：按钮操作的结果（成功与失败）一律用右下角浮层提示（`DismissibleMessage` 不加 `inline`）：成功 5 秒自动消失，错误保留到手动关闭；有原生对话框打开时，浮层放进最上层对话框，仍显示在视口右下角。`inline` 只用于与某个字段或区块直接相关、需要常驻的说明（例如配置超限警告）。长期检索设置、聊天检索弹窗、索引任务、数据保留、Agent 设置、定时任务设置面板已按此修正（此前写在面板顶部，滚动后看不到测试连接结果）。第二轮补齐：定时任务列表与其修改/删除弹窗、外部网络、插件工具预算、Bot 角色与归属、模拟消息匹配、画布保存前校验、执行详情中的图片/触发消息/附件预览、表情投递处置、表情包页操作结果改为浮层；删除 AI Provider/路由弹窗、插件管理弹窗、成员映射弹窗、表情弹窗内与浮层重复的段落；画布加载失败只在错误页说明一次。区块首次加载失败（区块会因此为空）仍就地显示，表情上传的文件校验移到选择按钮旁。浮层组件在挂载时决定放入哪个对话框，因此“关闭对话框并同时提示结果”的页面须把浮层放在对话框之后（模板顺序），否则会被放进正在关闭的对话框而看不到。
- **回归保护**：`tests/web-style-tokens.test.ts` 禁止未定义 CSS 变量、11px 以下字号与未定义按钮变体；`tests/web-ui-foundations.test.ts` 覆盖状态字典、格式化、错误诊断拆分与分区加载。
- **留待后续阶段**：F-04 其余页面（执行详情、审计、链接预览等）的徽章替换随 C-03 一并完成；F-10 其余页面（消息、插件、表情包、设置）随第 2 阶段迁移。

## 第 2～4 阶段实施记录（本地，未部署）

- **决策**：D1 采用方案 A 重组导航；D2 已启用工作流的按钮为“保存并发布”；D3 后端核实 AI 服务写操作只记审计不要求敏感授权，前端与之一致；D5 统一称“长期检索”。
- **交互一致性**：F-08 全部 `window.confirm` 换为站内确认框并补齐缺失确认（定时任务取消/暂停/跳过、索引任务取消与代次启用、停用聊天检索、插件回退、归属回填），画布删除提供撤销；F-09 `session.requestUnlock()` 与 `LockedHint` 就地解锁（执行详情内可用），表单对话框未授权时整体禁用，顶栏显示剩余时间，统一“敏感操作授权”；F-14 画布离开守卫、AI Provider 测试只刷新 Provider 列表、表情编辑关闭前确认；I-02/I-03 插件测试要求与工作流启停的禁用原因；I-04/B-07 “保存并发布”、编辑/线上版本、保存四态；F-12 自定义开关补 `role="switch"`。
- **对话框与文案**：F-07 表情上传/编辑、合集、消息图片改用原生 dialog（`ModalShell`），`AdminDetailDialog` 增加 md/lg/xl；C-03 原始枚举改中文（事件类型、入站状态、运行状态与告警、API 类型、推理强度、聊天/内容/导出/媒体类型、审计字段、节点类型），保留的错误码标为“诊断”；I-01 仅能测试已保存配置的按钮写明。
- **导航与布局**：A-01 顶部导航改为 概览 / 消息 / 自动化 / AI 服务 / 插件与表情包 / 执行与审计 / 设置（子页面高亮父级，图标不重复）；AI 用量与缓存（抽出为 `AiUsagePanel`）和索引任务移至 AI 服务；定时任务及其全局设置、空闲主动交流移至自动化；插件工具预算移至插件页；插件与表情包共用页内切换；A-04 执行列表工作流名可进入画布、概览最近执行可进入详情；A-05 站内跳转统一 RouterLink；A-06 开发者资源收起；C-01/C-02 术语与中文小标题；C-04 指路改为链接或明确位置；F-13 每页一个 h1；B-06 删除自动化页约 800 行死代码。
- **其他**：F-15 表情包页隐藏时不轮询（间隔 15 秒），执行列表在有进行中条目时每 15 秒刷新；F-17 `CopyableId`；I-09 消息搜索首屏状态；I-16 登录后回到原页面（仅限站内路径）；X-01/X-03/X-04/X-06/X-08 焦点、按钮标签、插件卡片读屏、图表语义、画布页头换行。

## 上线后调整（2026-11-27）

- “用量与缓存”移回执行与审计，位于执行记录下方。
- 插件与表情包改用与其他页面一致的侧栏导航（共用侧栏切换两个页面），插件工具预算改为“插件工具预算”按钮打开的设置弹窗。
- 插件管理的工作流引用显示工作流名称并可进入画布，已删除的工作流显示可复制 ID。
- 工作流列表的开发者资源改为工具栏中的下拉按钮；定时任务与空闲主动交流改用统一的面板标题、刷新按钮位置、筛选栏与表格样式；概览告警标签不再嵌套。

## 未完成项

F-07 执行详情对话框仍为自定义实现（已有焦点管理）；F-14 设置页刷新前确认；F-16 分页组件统一；I-05 画布保存按钮移到页头；I-06 画布校验定位到节点；I-07 Inspector 字段顺序；I-08 定时任务时间控件；I-10 导出时间范围内联校验；I-11 成员映射显示；I-12 插件对话框分步；I-13 执行列表筛选；I-14 AI 页列表形态统一；I-15 设置区块模板；X-05 画布键盘操作；X-07 断点收敛；A-07 自动化触发器列数据来源（待核实）。

## 分阶段计划

1. **基础件与明显缺陷**：B-01～B-05、B-08；F-01～F-06、F-10、F-11。产出组件与规则表（按钮层级、状态色、反馈位置、错误呈现），避免后续返工。
2. **交互一致性**（“操作逻辑割裂”的核心）：F-07、F-08、F-09、F-12、F-14；I-01～I-04；C-03；B-07。重点是画布保存/发布、“测试/保存”统一模式、解锁入口就地化。
3. **布局与信息架构**：F-13、F-15～F-17；A-01～A-07；C-01、C-02、C-04；B-06；I-05～I-16 剩余项。动结构前先定 A-01 采用方案 A 还是 B。
4. **可访问性、响应式与打磨**：X-01～X-08、I-13、I-14。用 `apps/web/*-preview.html` 在 375 / 768 / 1280 三档宽度逐页截图作为验收基线。

## 待决事项

| 编号 | 问题 |
| --- | --- |
| D1 | A-01 导航重组：方案 A（推荐）还是方案 B |
| D2 | I-04 工作流发布：启用时“保存并发布”，还是拆成“保存草稿 / 发布”两步 |
| D3 | F-09：AI 服务、表情包、自动化的写操作后端是否强制敏感授权，前端门控以此对齐 |
| D4 | A-07 自动化触发器列的数据来源需核实 |
| D5 | C-01 术语表定稿（尤其“长期记忆”与“长期检索”取哪个） |
