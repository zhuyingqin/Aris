# Chat 本地文档读取与编辑会话保护

用户反馈：Chat 读取本地文件时，Word/WPS 中正在编辑的文档被关闭。

当前 `read_file` 的 DOCX 分支、`read_docx` 和 `read_files` 直接从文件系统读取 OOXML，不需要启动 Word/WPS。代码审计发现两个缺口：DOCX 使用指引只存在于备用系统提示词，正常 Chat 使用的 `assets/prompts/system.md` 没有该指引；bash、PowerShell 和 REPL 没有针对 Word/WPS 自动化或结束编辑器进程的执行前保护。本次没有取得原始关闭事件的完整调用记录，因此不将某一条历史命令断言为直接原因。

## 读取约定

- 读取用户已保存的文件快照，不打开、隐藏、保存或关闭编辑器中的文档，也不取得未保存的编辑内容。
- DOCX 优先使用专用读取工具，其他格式使用文件解析器。旧 `.doc` 转换使用副本，不接管用户的 Word/WPS 会话。
- Windows 共享读取锁下继续读取；独占锁或权限拒绝下，返回 `document_read_unavailable` 和使用已保存副本的恢复指引。不结束编辑器进程释放锁。
- `read_files` 保留原来的逐文件错误和部分成功行为。

## 实现

`runtime::document_safety` 集中提供提示词、错误恢复指引和脚本预检。实际系统模板和备用模板都使用同一条指引，Desktop 与 CLI 通过共享 runtime/tools 使用同样的行为。

预检在启动子进程或后台服务前执行，覆盖常见的 Word/WPS COM/Interop 创建与附着、按进程名结束编辑器，以及 Windows 中直接写入命令的编辑器 PID。直接运行的 Python、PowerShell 和 VBScript 辅助文件也检查内容，支持 UTF-8 和带 BOM 的 UTF-16；读取源码的简单查询不会被当成自动化执行。辅助脚本检查有 1 MiB 上限。被拒绝的命令不会因后台执行或 `dangerouslyDisableSandbox` 而放行。

这项预检用于阻止常见脚本误用，不是解释器沙箱。动态构造、编码命令、间接导入和运行时计算的 PID 不能依赖静态检查获得完整覆盖；实际提示词与既有权限机制继续适用。没有放宽进程清理策略，也没有改动文档编辑或保存逻辑。

## 回归证据与验收边界

- 检查正常 Chat 实际使用的系统模板，避免只验证备用模板。
- 检查 COM/Interop、变量 ProgID、名称/PID 结束进程及 UTF-16 辅助脚本。
- 原生 PID 回归使用临时复制的命令程序作为测试进程，验证拒绝后目标仍存活；不启动或控制真实 Word/WPS。
- 工具入口回归把写入标记放在危险命令之前，验证整条命令执行前被拒绝，没有运行前半段；同时覆盖后台执行和沙箱覆盖参数。
- Windows 文件锁回归覆盖 `read_file`、`read_docx` 和 `read_files`，检查共享锁与独占锁仍由原句柄持有，原 DOCX 字节不变。

测试结果和限制记录在 `.somniq/diagnostics/chat-document-read-verification.json`。源码改动需要重新构建应用后进入安装版；真实 Word/WPS 中的未保存编辑窗口尚未做端到端验收。
