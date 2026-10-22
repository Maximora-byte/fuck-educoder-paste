<a id="top"></a>
<div align="center">

# 头歌 / 学习通复制粘贴助手：3.2.2 候选版

**保留编辑选区与原文格式，改善有权编辑页面的粘贴体验。**

<sub>Userscript · 人工验收候选版 · MIT fork</sub>

[快速开始](#quick-start) · [升级说明](#changes) · [开发验证](#development) · [验收清单](#acceptance) · [许可](#license)

</div>


基于 [ystemsrx/fuck-educoder-paste](https://github.com/ystemsrx/fuck-educoder-paste) 的 MIT fork。针对上游 [#1](https://github.com/ystemsrx/fuck-educoder-paste/issues/1)、[#2](https://github.com/ystemsrx/fuck-educoder-paste/issues/2)，改进编辑器选区、原文粘贴和错误目标防护。

早期改动已于 2026-10-10 通过本 fork 的 [PR #1](https://github.com/Maximora-byte/fuck-educoder-paste/pull/1) 合并。2026-10-22 整合上游 [3.2.1 / 974b7c6](https://github.com/ystemsrx/fuck-educoder-paste/commit/974b7c61f724965a70952d733ff79eb6d25b86a8) 的头歌适配，保留本 fork 的学习通保护和 Monaco 异常回退。上游已关闭 issue #1、#2；这不替代真实课程页面及脚本管理器验收，也不表示 fork 已发布到 Greasy Fork。

<a id="quick-start"></a>
## 使用候选版

1. 使用你已有的 Tampermonkey / Violentmonkey 等脚本管理器。
2. 打开本 fork 默认分支 `master` 的 [fuck-educoder-paste.user.js](https://github.com/Maximora-byte/fuck-educoder-paste/blob/master/fuck-educoder-paste.user.js)，复制完整内容并替换旧脚本；不要同时启用多个版本。
3. 只在你有权编辑的练习页面刷新并验收。本 fork 的合并不等于原作者 Greasy Fork 发布版已同步；安装前请核对所用脚本来源和版本。

脚本仍使用原来的 educoder.net、chaoxing.com、xueyinonline.com、chaoxingerya.com 域名范围，`@grant none`；与上游一致增加 `@sandbox raw`。没有新增域名、运行时依赖、网络请求或授权项，没有增加剪贴板持久化、剪贴板轮询、答题或试卷提取功能。更新后请刷新页面，避免旧捕获监听器继续生效。

<a id="changes"></a>
## 本次升级

<details>
<summary>展开编辑器适配、选区与原生回退说明</summary>

- **头歌适配同步**：快捷键在 window 捕获阶段处理，支持同源 iframe 及动态挂载；通过全局 API 或附近 React 类组件、ref、hook 发现 Monaco 实例。按实际 DOM 身份匹配并清理已销毁实例，发现过程不执行应用 getter。
- **Monaco**：保留公开 `executeEdits` + `Selection` 路径、撤销边界和原始多行缩进；未暴露全局 API 时使用当前选区实例的构造器。查找框、多光标、只读、实例不确定或无事件文本时交回原生流程。
- **头歌原生输入**：普通 textarea 仅在空选区前调整待替换的空白范围，由浏览器完成粘贴及撤销；事件缺少文本时不启动延迟读取，因此不会在切换焦点后写回旧输入框。正常 Ant Design 消息和通知继续显示。
- **其他头歌编辑器**：沿用上游 CodeMirror 5、ACE、CodeMirror 6 的发现及批量编辑路径，并支持编辑器复制、剪切、全选；真实平台版本仍需验收。
- **CodeMirror 5 风格 API**：使用 `replaceSelection` / `replaceSelections`；只有 `replaceRange` 时使用完整选区起止位置，并在可用时把光标置于插入末尾。以 `paste` 来源保留编辑器的历史机制，同文本替换也能识别成功。
- **尊重只读及验证器**：删除临时关闭 CodeMirror `readOnly`、清空私有 `beforeChange` 回调和强制重试的实现。编辑器拒绝操作时保留原生流程；原生编辑器自己可能再次处理该事件。
- **UEditor**：仅在已有实例的文档、body 或 iframe 身份匹配时使用实例，多个行内宿主还需匹配实际 body。发现实例不再调用会创建编辑器的 `UE.getEditor`。将已验证的实时选区交给 UEditor，再用 `execCommand('insertHTML')` 进入其撤销/内容同步机制；禁用命令不走强制 DOM 回退。
- **普通富文本**：使用浏览器编辑命令保留撤销，`plaintext-only` 使用纯文本命令。缺少命令支持时交回原生粘贴，不再自动走直接 DOM 插入。
- **保留真正的焦点**：Ctrl+V 不再把焦点移到隐藏输入框；自动插入只使用本次 paste / beforeinput 事件文本。同步插入成功后才取消事件；失败保留原生事件和监听器。
- **异常防重复**：站点回调可能在内容已改变后抛错，因此根据编辑后的内容/选区确认结果，避免同一内容又被原生粘贴一次。

动态挂载和切换沿用现有扫描与事件目标发现机制；焦点、iframe 父级焦点和选区端点仍须属于当前可编辑宿主。类名、旧编辑器记录和陈旧选区不作为写入依据。显式异步剪贴板助手仍会校验宿主、选区以及 CodeMirror 模型未改变。

</details>

<a id="development"></a>
## 本地验证

Node.js 18 或更新版本，无需安装依赖：

```sh
node --check fuck-educoder-paste.user.js
node --test tests/*.test.cjs
```

- 当前 126 个隔离回归测试通过。学习通既有回归测试全部保留；头歌测试更新为原生 textarea 范围处理，并增加 React 实例发现、应用 getter 防护、无延迟粘贴、快捷键阶段及复制/剪切测试。
- Monaco 缺少必要 API 或写入前抛错时保留原生事件；写入后抛错时通过原模型版本/内容变化避免重复粘贴，同文本替换使用版本变化判断。异常时仍尝试关闭撤销边界。
- 测试提取实际源码函数，使用编辑器 API / DOM 模拟。包括只读、验证器取消、同文本替换、异常后重复粘贴、错误实例/宿主、动态挂载、旧焦点/选区及异步光标变化。
- 可选 `node tests/browser-smoke.cjs` 使用预装 Playwright 和 Chromium（可用 `CHROMIUM_PATH` 指定路径）。所有页面请求本地填充或阻断；不访问课程站点，UEditor / CodeMirror 仍是 API 模拟。无需为基础测试安装它们。
- 2026-10-22 使用本机 Chrome 运行学习通 6 项浏览器夹具检查，全部通过；`node tests/educoder-browser-smoke.cjs` 的头歌 5 项检查也通过，覆盖原生待替换范围、无延迟粘贴、通知显示、iframe 安装及真实 Ctrl+A 捕获。页面请求均本地填充或阻断。真实课程、脚本管理器扩展注入及真实编辑器版本尚未验收。
- 没有配置或运行 GitHub Actions。

<a id="acceptance"></a>
## 验收清单

在有权编辑的练习页，分别检查：

1. 粘贴含空行、Tab、空格、中文及 `< > &` 的多行文本，内容不执行为 HTML。
2. 正向/反向选中部分内容后替换，光标位于插入末尾；Ctrl+Z 一次恢复此次插入前状态。
3. 连续粘贴两次相同内容，第二次不被吞掉；选中相同文本再粘贴不会重复插入。
4. 在两个编辑器、普通输入框和 iframe 之间切换，内容只落到当前目标。
5. 切换题目或动态打开编辑器后仍能粘贴；只读编辑器、不可编辑区域保持不变。
6. 浏览器/平台拒绝剪贴板或编辑器 API 不可用时，没有旧光标写入、抢焦点或后台剪贴板读取。

平台限制在原生回退时仍可能生效。ACE、CodeMirror 6、React 内部 Monaco 和不同 UEditor 版本尚未完成真实平台兼容性验收。反馈问题时请附浏览器、脚本管理器、编辑器类型、复现步骤和脱敏截图，不要提交课程答案或私人数据。

<a id="license"></a>
## 设计参考与许可

本次采用独立实现，保留原作者 ystemsrx 的署名和 [MIT LICENSE](LICENSE)，不引入以下项目的运行时代码或附属功能：

- [MuQY1818/ChaoXing_Code_Paste](https://github.com/MuQY1818/ChaoXing_Code_Paste/blob/64a1f630ef70fe55528021fd182da74b3854d904/chaoxing-paste-helper.user.js)：脚本头声明 MIT；参考按 CodeMirror / UEditor 区分粘贴方式、恢复选区的设计。未加入图片上传或 localStorage。
- [Wan-JD/educoder-helper](https://github.com/Wan-JD/educoder-helper/tree/f11cf70ab875e3fbe5143e034129bf663c6e22e3)：[MIT](https://github.com/Wan-JD/educoder-helper/blob/f11cf70ab875e3fbe5143e034129bf663c6e22e3/LICENSE)；参考 Monaco 发现与动态页面适配思路，保留本 fork 既有的安全 API 路径，不引入其额外面板或网络功能。
- [iPycc/Fk-Chaoxing-Extension](https://github.com/iPycc/Fk-Chaoxing-Extension/tree/f223ed213311abba83a55ed7a72f2ea60b30487d)：[MIT](https://github.com/iPycc/Fk-Chaoxing-Extension/blob/f223ed213311abba83a55ed7a72f2ea60b30487d/LICENSE)；参考按 iframe / 富文本类型分离处理的思路，未加入 AI 答题、提取题目或 API token 功能。

没有复制许可声明冲突的旧 Chaoxing-CopyPaste-Helper，亦未引入其他项目的考试设置修改、签名采集或 AGPL 代码。

仅用于改善合法编辑体验，请遵守平台规则和学术诚信要求。

[返回顶部](#top)
