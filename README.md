# 头歌 / 学习通复制粘贴助手：3.1.0 候选版

基于 [ystemsrx/fuck-educoder-paste](https://github.com/ystemsrx/fuck-educoder-paste) 的 MIT fork。针对上游 [#1](https://github.com/ystemsrx/fuck-educoder-paste/issues/1)、[#2](https://github.com/ystemsrx/fuck-educoder-paste/issues/2)，改进编辑器选区、原文粘贴和错误目标防护。

当前改动在本 fork 的 [Draft PR #1](https://github.com/Maximora-byte/fuck-educoder-paste/pull/1)，尚未合并或发布到 Greasy Fork。真实课程页面和脚本管理器兼容性仍需验收，不能据此宣称两个 issue 已在所有页面解决。

## 本次升级

- **Monaco**：保留 3.0.1 的公开 `executeEdits` + `Selection` 路径、撤销边界和原始多行缩进；在事件发生时发现当前编辑器，避免依赖旧实例。查找框、多光标、只读、未暴露 API 或无事件文本时交回原生流程。
- **CodeMirror 5 风格 API**：使用 `replaceSelection` / `replaceSelections`；只有 `replaceRange` 时使用完整选区起止位置，并在可用时把光标置于插入末尾。以 `paste` 来源保留编辑器的历史机制，同文本替换也能识别成功。
- **尊重只读及验证器**：删除临时关闭 CodeMirror `readOnly`、清空私有 `beforeChange` 回调和强制重试的实现。编辑器拒绝操作时保留原生流程；原生编辑器自己可能再次处理该事件。
- **UEditor**：仅在已有实例的文档、body 或 iframe 身份匹配时使用实例，多个行内宿主还需匹配实际 body。发现实例不再调用会创建编辑器的 `UE.getEditor`。将已验证的实时选区交给 UEditor，再用 `execCommand('insertHTML')` 进入其撤销/内容同步机制；禁用命令不走强制 DOM 回退。
- **普通富文本**：使用浏览器编辑命令保留撤销，`plaintext-only` 使用纯文本命令。缺少命令支持时交回原生粘贴，不再自动走直接 DOM 插入。
- **保留真正的焦点**：Ctrl+V 不再把焦点移到隐藏输入框；自动插入只使用本次 paste / beforeinput 事件文本。同步插入成功后才取消事件；失败保留原生事件和监听器。
- **异常防重复**：站点回调可能在内容已改变后抛错，因此根据编辑后的内容/选区确认结果，避免同一内容又被原生粘贴一次。

动态挂载和切换沿用现有扫描与事件目标发现机制；焦点、iframe 父级焦点和选区端点仍须属于当前可编辑宿主。类名、旧编辑器记录和陈旧选区不作为写入依据。显式异步剪贴板助手仍会校验宿主、选区以及 CodeMirror 模型未改变。

## 使用候选版

1. 使用你已有的 Tampermonkey / Violentmonkey 等脚本管理器。
2. 打开当前分支的 [fuck-educoder-paste.user.js](https://github.com/Maximora-byte/fuck-educoder-paste/blob/fix/paste-issues-1-2/fuck-educoder-paste.user.js)，复制完整内容并替换旧脚本；不要同时启用多个版本。
3. 只在你有权编辑的练习页面刷新并验收。原作者 Greasy Fork 发布版不包含这些未合并改动。

脚本仍使用原来的 educoder.net、chaoxing.com、xueyinonline.com、chaoxingerya.com 域名范围，`@grant none`。本次没有新增域名、运行时依赖、网络请求或权限，没有增加剪贴板持久化、剪贴板轮询、答题或试卷提取功能。原作者的复制、全选、空白剪贴板写入保护等基础逻辑继续保留。

## 本地验证

Node.js 18 或更新版本，无需安装依赖：

```sh
node --check fuck-educoder-paste.user.js
node --test tests/*.test.cjs
```

- 当前 94 个隔离回归测试通过。原有 54 项防护仍覆盖；其中旧 Ctrl+V 隐藏输入框集成用例改为验证真实焦点保留和普通粘贴事件。新增 40 项适配器及事件回退测试。
- 测试提取实际源码函数，使用编辑器 API / DOM 模拟。包括只读、验证器取消、同文本替换、异常后重复粘贴、错误实例/宿主、动态挂载、旧焦点/选区及异步光标变化。
- 可选 `node tests/browser-smoke.cjs` 使用预装 Playwright 和 Chromium（可用 `CHROMIUM_PATH` 指定路径）。所有页面请求本地填充或阻断；不访问课程站点，UEditor / CodeMirror 仍是 API 模拟。无需为基础测试安装它们。
- **浏览器夹具未运行通过**：本次环境在 Chromium 启动时拒绝创建进程单例 socket，六个浏览器断言均未执行；仅脚本语法检查通过。真实浏览器撤销栈、扩展注入时序和真实编辑器版本兼容性尚未验证。
- 没有配置或运行 GitHub Actions。

## 验收清单

在有权编辑的练习页，分别检查：

1. 粘贴含空行、Tab、空格、中文及 `< > &` 的多行文本，内容不执行为 HTML。
2. 正向/反向选中部分内容后替换，光标位于插入末尾；Ctrl+Z 一次恢复此次插入前状态。
3. 连续粘贴两次相同内容，第二次不被吞掉；选中相同文本再粘贴不会重复插入。
4. 在两个编辑器、普通输入框和 iframe 之间切换，内容只落到当前目标。
5. 切换题目或动态打开编辑器后仍能粘贴；只读编辑器、不可编辑区域保持不变。
6. 浏览器/平台拒绝剪贴板或编辑器 API 不可用时，没有旧光标写入、抢焦点或后台剪贴板读取。

平台限制在原生回退时仍可能生效。ACE、CodeMirror 6、未暴露 Monaco API 的构建和不同 UEditor 版本没有专门适配或完整验证。反馈问题时请附浏览器、脚本管理器、编辑器类型、复现步骤和脱敏截图，不要提交课程答案或私人数据。

## 设计参考与许可

本次采用独立实现，保留原作者 ystemsrx 的署名和 [MIT LICENSE](LICENSE)，不引入以下项目的运行时代码或附属功能：

- [MuQY1818/ChaoXing_Code_Paste](https://github.com/MuQY1818/ChaoXing_Code_Paste/blob/64a1f630ef70fe55528021fd182da74b3854d904/chaoxing-paste-helper.user.js)：脚本头声明 MIT；参考按 CodeMirror / UEditor 区分粘贴方式、恢复选区的设计。未加入图片上传或 localStorage。
- [Wan-JD/educoder-helper](https://github.com/Wan-JD/educoder-helper/tree/f11cf70ab875e3fbe5143e034129bf663c6e22e3)：[MIT](https://github.com/Wan-JD/educoder-helper/blob/f11cf70ab875e3fbe5143e034129bf663c6e22e3/LICENSE)；参考 Monaco 发现与动态页面适配思路，保留本 fork 既有的安全 API 路径，不引入其额外面板或网络功能。
- [iPycc/Fk-Chaoxing-Extension](https://github.com/iPycc/Fk-Chaoxing-Extension/tree/f223ed213311abba83a55ed7a72f2ea60b30487d)：[MIT](https://github.com/iPycc/Fk-Chaoxing-Extension/blob/f223ed213311abba83a55ed7a72f2ea60b30487d/LICENSE)；参考按 iframe / 富文本类型分离处理的思路，未加入 AI 答题、提取题目或 API token 功能。

没有复制许可声明冲突的旧 Chaoxing-CopyPaste-Helper，亦未引入其他项目的考试设置修改、签名采集或 AGPL 代码。

仅用于改善合法编辑体验，请遵守平台规则和学术诚信要求。
