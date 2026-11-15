# 任务失败与 Lil’Log 183/235 调查

本次只调查并提出方案，没有修改识别算法、评审工具业务实现、真实人工数据或提交代码。诊断脚本与输出位于忽略目录 `output/task-failure-audit/`，复现使用独立浏览器会话，没有接管任务会话，也没有实际点击翻译按钮。

## 范围与状态

固定调查对象为用户在 23:13 查询时已失败的 27 个任务：2026-11-14 22:50 后加入本批、并在 23:13:38 前结束的失败任务。原始记录及逐项分类见 `original-27.json`、`original-27-classified.json` / `.csv`。

调查期间原队列继续执行；23:38 的最新状态为本批 61 项全部结束，2 完成、59 失败。后续新增失败不计入本报告 27 项分解。Lil’Log 单独调查，23:14:44 以不完整结束，不是永久死锁。

## 最初 27 项逐项分组

| 页面 | 失败任务 | 具体原因 |
| --- | --- | --- |
| Ars Technica header | 采集、发布实翻、当前版识别，共 3 项 | 主页面 HTTP 405；后两项缺失采集快照 |
| Ars Technica segmented body | 同上 3 项 | 主页面 HTTP 405；后两项连带失败 |
| Genius lyrics | 同上 3 项 | 主页面 HTTP 403；后两项连带失败 |
| CNN live story | 同上 3 项 | 主页面 HTTP 404；后两项连带失败 |
| GitHub discussion list | 同上 3 项 | 主页面 HTTP 404；后两项连带失败 |
| GitHub issue detail | 同上 3 项 | 主页面 HTTP 404；后两项连带失败 |
| Claude / Intercom help article | 同上 3 项 | 主页面 HTTP 404；后两项连带失败 |
| Archive / Substack archive | 发布实翻 1 项 | 快照实际是 CAPTCHA 页面，遮罩拦截悬浮球点击 |
| GEN article | 发布实翻 1 项 | OneTrust Cookie 遮罩拦截悬浮球点击 |
| Clayton Ramsey article | 发布实翻 1 项 | 51 个初始目标中覆盖 38 个，剩余 13 个是 MathML，发布版执行层不处理 |
| Hidden expandable card / How LLMs Work | 发布实翻 1 项 | 169 个初始目标覆盖 162 个，剩余 7 个是 SVG 文字，执行层不处理 |
| Exercism C++ exercise | 发布实翻 1 项 | 初始 34 个目标覆盖 5 个，剩余 29 个检测为中文，当前中译目标相同而跳过 |
| Liepin job page | 发布实翻 1 项 | 初始 54 个目标覆盖 21 个，剩余 33 个检测为中文，被目标语言规则跳过 |

合计：7 项采集 HTTP 错误 + 14 项依赖快照缺失 + 2 项启动点击被拦截 + 4 项完成条件与执行行为不一致 = 27。

这里的 403 / 404 / 405 是采集时主页面的直接响应证据。不能仅凭 404 判断页面已删除还是当前会话无权限，也不能仅凭 405 判定某种反爬实现。网址来自 fixture；它可能只是结构测试的 URL 上下文，不能据此保证是真实有效的在线页面。

### 原始 HTTP 证据

`output/playwright/reading-review/` 的 console 日志直接记录对应主文档状态：

- `console-2026-11-14T14-51-03-108Z.log`：Ars header 405。
- `console-2026-11-14T14-51-13-660Z.log`：Ars segmented 405。
- `console-2026-11-14T14-51-24-282Z.log`：Genius 403。
- `console-2026-11-14T14-55-54-846Z.log`：CNN 404。
- `console-2026-11-14T15-01-10-074Z.log`：GitHub discussions 404。
- `console-2026-11-14T15-01-19-180Z.log`：GitHub issue 404。
- `console-2026-11-14T15-05-51-811Z.log`：Claude help article 404。

采集代码 `worker.mjs:38–39` 遇到非成功主文档就抛出 HTTP 错误，因此没有生成 latest.json。`server.mjs:124` 却预先把 capture / baseline / candidate 一起排队，没有依赖阻断；采集失败后后两项照常执行，最终报 ENOENT。

## Lil’Log 为什么停在 183/235

最新失败运行：`release-1794669023255-707f75`；快照 `3bec1349-4994-4813-9941-ff224bc2ea51`。

- 初始目标 235，标记处理 183，原文覆盖 183，译文元素 182。
- 未覆盖 52：14 个 SVG text、38 个 SVG title，全部不是 HTMLElement。
- 已处理但没有插入译文的 1 项是公式块 `ϵ∼c⋅Dα+E`，所以译文元素数为 182。
- 观测结束时 pending=0、failures=0，观测耗时 241,087ms。
- 前一次运行也停在同样的 183/235，原因可重复。

锁定的发布版源码为 `65d20abd7af0aa55ae59ee57b515692bd941ca22`。`entrypoints/main/trans.ts:538` 对非 HTMLElement 直接返回，第 596 行后台队列也只取 HTMLElement。SVG / MathML 永远不会进入后续翻译，因此等待无法补齐这些目标。

工具的 `worker.mjs:95` 却对全部初始目标统一等待四分钟；`completion.mjs` 只从处理标记与覆盖宿主推断完成，没有“执行不支持／目标语言相同”的终止原因。于是队列实际已无可推进内容，UI 仍显示运行中直至超时。

这不是发现了 52 个翻译服务失败，也不等于 52 项都应翻译：其中有数值、图表坐标和悬浮说明。应保留原目标清单和真实未覆盖结果，先区分执行能力，再按产品口径评价内容质量，不能把未支持目标直接记为翻译成功。

## 两个点击失败：独立复现

在同一归档快照、同一发布版的独立会话中，悬浮球均存在且可见，坐标为 x=1380、y=834、42×42；但 trial click 稳定超时：

- Archive：页面正文为 “One more step / Please complete the security check”，原站 div 拦截指针事件。它不是目标文章，既有扩容报告已经记录过验证码限制。
- GEN：正常文章正文存在，但 `div.onetrust-pc-dark-filter.ot-fade-in` 拦截指针事件。

原历史命令没有保存完整 stdout，因此不能声称恢复了当时的全部调用栈；本次在相同冻结输入上，保留 waitFor 并进行不真正触发翻译的 trial click，独立复现了具体拦截位置。

证据：`actionability.json`，以及两个 `*-stdout.log`。没有绕过验证码，也没有强制点击遮罩。

## 为什么只显示 npm 警告

Playwright CLI 把应用异常写入 stdout。`driver.mjs` 使用 execFile，非零退出抛出的 error.message 主要包含命令与 stderr，没有带上 stdout。worker 保存 error.message；server 的 stdout/stderr 环形 log 只在内存中，没有归档或对外展示。

本次受控抛出 `HTTP 404 controlled diagnostic` 后：CLI stdout 明确包含该错误，exception.message 却只有 Command failed。见 `controlled-error.json`。因此 `npm warn Unknown env config "dir"` 不是这些失败的根因，是被保留下来的伴随警告。

## 另外四个“不完整”的精确说明

- Clayton：13 个缺失项全部在 math 中，12 个 mtext、1 个 mo；Chrome 中均不是 HTMLElement。额外运行宿主已经计入原文覆盖，没有把它们重复当成失败。
- Hidden expandable：真正未覆盖的是 7 个 SVG text；2 个初始子目标已由运行时父宿主覆盖。部分图文字在原文索引中没有 textIds，因为 catalogue 显式跳过 svg，这也说明目前图中文字不能被完整评审定位。
- Exercism：请求英语路径，却采到了 `/zh-CN/` 的中文页面；29 个剩余目标用发布版相同 franc 规则全部识别为 cmn，映射为 zh-Hans。
- Liepin：33 个剩余目标同样全部为 cmn。发布版目标是 zh-Hans，`translationDirection.ts:14–30` 判定不用再翻译，`trans.ts:1073–1076` 清除未完成标记。

这里的 attempted 实际来自 DOM 标记，不是可靠的“已发出请求数”；源语言相同的节点进入处理后又清除标记，会被工具误看成尚未尝试。

Chrome DOMParser 独立核对：Lil’Log 的 52 个均为 SVG；Clayton 的 13 个均为 MathML；Hidden 的 7 个均为 SVG；Exercism / Liepin 共 62 个为 HTML 且原检测语言为 cmn。见 `browser-translation-analysis.json`。诊断中对少量未带原标记的图文字仅用文本查找来判断元素类型，没有用文本匹配改变正式覆盖统计。

## 建议修复顺序与具体边界

1. **保留真正错误。** 在 driver 的命令边界归档退出码、阶段、stdout、stderr，提取 CLI 的错误区块；worker 写结构化 error 对象，server 保存任务日志。回归覆盖“stderr 只有警告而 stdout 含 HTTP 错误”。不把完整网页与日志提交仓库。
2. **加前置与依赖判断。** 批量补齐先检查主文档状态、最终 URL、验证码正文、遮罩和既有 validation。采集成功且快照有效后才安排实翻／识别，显式绑定返回的 snapshotId；前置失败的子任务记“上一步失败，已跳过”，而不是再制造两个 ENOENT。已知受限页不在每次补齐时无条件重试。
3. **区分观测结束与实翻合格。** 保留全部初始目标，另记 translated、processed-without-insert、skipped-target-language、unsupported-element、unanchored、failed 等逐项原因，沿用被测发布版的实际执行条件。剩余均已知不可推进时提前结束并保留诊断；未知原因的未覆盖仍是不完整。不要把所有 skipped 统一算作翻译成功，不降低原质量要求，也不改 fixture 期望来变绿。SVG / MathML 是否纳入扩展能力另开议题，本轮可以先解决无意义等待。
4. **改善任务显示。** 显示当前执行项、阶段开始时间、最后一次实质进展时间与各原因计数。心跳更新时间不等于覆盖进展；日志必须可展开。失败、受限和依赖跳过分开统计，防止 7 个采集失败看起来变成 21 个独立根因。
5. **整理受限样本。** 404 / 403 / 405 的网址保留历史，人工确认有效地址或将其保留为 fixture-only。Archive 的验证码快照标为无效实翻输入。GEN 在采集时明确处理 Cookie 状态后另存新快照，不在旧冻结页面里悄悄删遮罩或 force-click。Exercism 可新增明确英语 locale / 最终 URL 的快照；Liepin 中文页面可只做目标识别评审，若要实翻需单独定义适用方向，不与原英语基线混比。

建议先落地第 1–4 项工具修复及其隔离回归，随后只重试已确认输入有效的样本。所有旧快照、失败记录、人工标注和接受限制保留；本报告不代表已经实施这些修复。
