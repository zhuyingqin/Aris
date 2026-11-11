# 插件能力清单

状态：设计稿，待批准（2026-11-08）；已经过一轮独立审查并修订，处理结果见文末"评审记录"。
基于 `codex/release-0.4.87`（15a7b25a）和工作区里尚未提交的 AI 自建插件 M1–M3
（见 [Agent 自建插件](agent-authored-plugins.md)）。相关文档：
[插件包与信任锚](deepseek-plugin-packages.md)、[Chat UI 插件](chat-ui-plugins.md)。

## 目标

批准卡片现在给用户看的是命令行和环境变量名。用户看不出 `python ./server.py`
会做什么，而且这行命令实际拿到的东西比卡片上写的多。本设计让每个插件 MCP 服务
声明自己需要什么，宿主只给"声明了、用户批准了、这台电脑能做到"的部分，并在卡片上
如实标出哪些限制由宿主设置、哪些只是声明。

这是插件生态的前提：没有它，分发得越广，风险放得越大。

可观察的成功标准：

1. 插件 MCP 进程的环境里只有四类变量：平台基础变量、宿主提供的 `SOMNIQ_PLUGIN_*`
   等变量、清单里点名透传且卡片上列出的用户变量、包自己写的变量。SomniQ 进程里的
   其他变量，包括用户从终端启动时带进来的令牌，一个都不出现。
2. 包里的任何写法都改不了宿主控制项（工作目录、进程树归属、stdio 分帧）。
3. 插件起的子孙进程随 SomniQ 退出一起结束，Windows 上也是。
4. 工作区内容不能借一个已批准的插件运行：插件的工作目录永远不是项目目录，插件需要的
   工作区文件以"批准时的副本"交给它。
5. 卡片和插件页上的每一条能力都标"已强制""尽力""仅声明"之一。标签由这台电脑实际
   可用的执行手段算出，不靠文档；标签的含义写在卡片上，不让人误读成安全隔离。
6. 升级时只改环境变量值（例如 `SERVICE_URL`），Chat 卡片和插件页都显示出来，不能被
   折叠成一行"执行面没变"。

## 现状（已核实）

| # | 现象 | 位置 | 后果 |
| --- | --- | --- | --- |
| 1 | MCP 进程继承 SomniQ 的整个进程环境 | `crates/runtime/src/mcp_stdio.rs` 的 `apply_env` 只追加包声明的变量；`process.rs::hidden_tokio_command` 再叠加执行上下文（变量、工作目录、运行令牌、只读根） | 用户从终端启动 SomniQ 时带进来的 `GITHUB_TOKEN`、`HF_TOKEN`、云凭据，以及 `ARIS_REVIEWER_BASE_URL`、`ARIS_WEB_PROXY_URL` 等配置，插件代码和它的依赖都能读到。托管 key 已改走进程内 `process_secrets`（Desktop `config.rs::set_credential_if_allowed`），不在环境里 |
| 2 | 宿主控制项走环境变量 | `mcp_stdio.rs` 从传输的 `env` 读 `SOMNIQ_MCP_WORKING_DIRECTORY`、`SOMNIQ_MCP_OWN_PROCESS_TREE`、`ARIS_MCP_STDIO_FRAMING` | 前两个本来给内置 Oracle 用（Desktop `oracle_web.rs`），但插件包的 `env` 由作者写（`dsh.rs` 不过滤键），同样生效：包可以自选工作目录、自己决定要不要被纳入进程树管理、改分帧 |
| 3 | 插件进程默认不进 Job Object | 只有 `SOMNIQ_MCP_OWN_PROCESS_TREE=1` 才 `kill_on_drop` 并建 Job（`managed_job.rs`，只设 `KILL_ON_JOB_CLOSE`）；Unix 上每个 MCP 子进程仍有自己的进程组 | Windows 上插件在后台起的子进程会被重新挂靠，SomniQ 退出后继续运行 |
| 4 | 工作目录默认是项目根 | `mcp_stdio.rs` 回落到 `ARIS_WORKSPACE_ROOT` | ① M2 实测的漏洞：服务在运行时加载 `scripts/date_diff.py`，之后改脚本不需要重新批准。② 工作区内容能借正常插件运行：`python -m` / `-c` 把工作目录放在 `sys.path[0]`，`cmd /c` 的垫片先在工作目录里找可执行文件，`npx` 优先 `./node_modules/.bin` 并读项目的 `.npmrc` |
| 5 | 卡片只看键、不看值 | Desktop `plugins.rs::approval_card` 的 `executionUnchanged` 只比较命令行和键的增删；`ChatMessage.tsx` 的升级卡片只渲染 `commands` 和 `envKeys`，`envChanged`（`upgrade.rs` 已算出）只在插件页显示 | 包里的环境变量值都是字面量（`dsh.rs` 拒绝 `${` 模板），却不显示；只改值的升级在 Chat 里被折成一行 |
| 6 | 系统级隔离只有 Linux | `sandbox.rs` 只检查 `unshare` 在不在 PATH；`--net` 全有或全无；文件系统模式只是传给子进程的环境变量提示 | Windows、macOS 上插件进程能读写当前用户能读写的一切，能访问任何网络；限制非特权用户命名空间的发行版上，现有探测会误判 |
| 7 | Skill 可以带脚本 | `authoring.rs` 的契约写明 Skill 目录可带 `scripts/`；已批准快照加进只读根（Desktop `state.rs`） | Agent 按 Skill 用 Bash 运行这些脚本时，脚本拿到完整环境，完全不经过本清单 |
| 8 | 批准不覆盖快照外的代码 | 包摘要只覆盖快照字节（`plugins/mod.rs::digest_files`）；`command`/`args` 原样传递（`dsh.rs`） | `npx -y pkg`、`uvx tool`、指向全局安装的绝对路径，实际运行的代码批准后可以变 |

另外三点影响设计：

- MCP 发现在每个回合开始时进行（`aris_chat::attach_mcp_tools_with_cancel`，5 分钟缓存），
  与权限模式无关，自主只读工作流的回合也会；缓存命中时进程推迟到第一次工具调用才启动。
  只有工具调用要求完全权限。所以限制必须在进程启动那一刻生效，并且对进程的整个生命期
  成立，不能只拦工具调用、只查一次文件。
- `package.json` 里一旦出现 `somniq` 字段就必须有 `ui`（`ui.rs` 用 `deny_unknown_fields`
  解析）。能力声明要加在这里，`ui` 就得改成可选。
- 工作任务里有两个根：插件和批准按登记的项目根解析（`ARIS_PLUGIN_PROJECT_ROOT`），
  `ARIS_WORKSPACE_ROOT` 却是任务的 worktree。本设计里每个"项目"都要说清是哪一个。

## 威胁模型

防什么：

- 插件代码和它拉进来的依赖读取环境变量外传。这是供应链投毒最常见的手法。
- 包借宿主控制项改变自己的运行方式。
- 工作区内容（例如克隆来的仓库）借一个已批准的正常插件运行。
- 用户以为插件已经停了，进程却还在跑。
- 批准之后，借工作区文件或环境变量值悄悄换掉实际执行的东西。
- 用户在不知道实际能力的情况下点批准。

本期不防什么：

- **与 SomniQ 同一用户运行的恶意代码。** 它能用操作系统手段读取别的进程的环境和内存，
  也能读文件。所以"已强制"只表示宿主这样设置了子进程（环境块、Job 归属），不表示
  恶意插件拿不到更多。卡片底部写明这一点。
- 文件读取：任何平台都还没有文件隔离，Windows 上插件进程能读 `~/.ssh`。
- Windows、macOS 上的网络访问。
- 代码里没声明的工作区读取（例如直接读 `SOMNIQ_WORKSPACE_ROOT` 下的文件）。这靠
  Skill 约束，以后再加独立 Reviewer 审包。
- Skill 正文和面板文字里的提示词注入，以及 Skill 附带的脚本经 Agent 的 Bash 以完整环境
  运行（现状第 7 条）。卡片会列出这类脚本，但本期不约束它们。
- 运行时下载的代码的内容（现状第 8 条）。卡片标出，并要求固定版本，见决策 C-D5。
- 完全权限下 Agent 的 Bash 改写信任库（`approvals.json`、快照目录）。完全权限本来就
  等于信任执行者；只读、工作区写权限下文件工具写不到这里。
- 插件体系之外、工作区内容就能运行代码的既有路径（见下）。

**插件体系之外的既有缺口。** 继承来的不变量"工作区内容永远不足以运行任何东西"目前只在
插件这条路上成立：

- `ConfigLoader::load` 会深度合并项目里的 `.claude/settings.json`、`.claude.json`
  （`crates/runtime/src/config.rs`），钩子从合并结果解析（`config.rs` 的
  `parse_optional_hooks_config`）。Desktop 的 Chat 回合用它构造 `HookRunner`
  （`conversation.rs`），钩子经 `cmd` / `sh` 运行（`hooks.rs`）。
- Desktop `mcp.rs::migrate_project_stdio_to_global_if_needed` 在没有全局 MCP 文件时，
  把项目 `.mcp.json` 里的 stdio 服务复制进全局配置。

这两条另立任务处理（给项目级钩子和这次迁移加本机批准），不在本设计里改。

本期的价值在于：能管住的管住（环境、控制项、工作目录、进程树、交给插件的工作区文件），
管不住的明说；同时让声明进入批准和升级差异，给以后的系统级强制和 Reviewer 审包留好挂点。

## 不变量

1. **声明不授予任何东西。** 宿主只给"声明了 ∧ 用户批准了 ∧ 平台允许"的交集。
2. **标签和执行同源。** 卡片上的强制等级由 runtime 的 `capability_enforcement()` 算出，
   执行器用同一个函数决定怎么起进程。凡是标"已强制"的项，都有测试在该平台上证明宿主
   确实这样设置了子进程；"已强制"的含义按威胁模型限定。
3. **批准绑定（包摘要，交给插件的工作区文件摘要，批准时的强制等级）。** 包摘要或文件
   摘要变化都要重新批准；强制等级下降也要重新批准。能力声明写在 `package.json` 里，
   本来就在包摘要内。
4. **宿主控制项只走类型化字段**，不经过包能写的任何通道。
5. **插件进程的工作目录永远不是项目目录。**
6. 沿用已有不变量：插件这条路上工作区内容不足以运行任何东西；批准只来自主窗口的一次
   点击；一个运行冻结一个插件集；插件不能遮盖内置 Skill。
7. 用户手工配置的 MCP（自己的 `mcp.json`）行为不变。本设计只管插件来源的服务。

## 清单格式

在 `package.json` 的 `somniq` 下加 `capabilities`，按 MCP 服务名（DSH 行里的
`serverName`）逐个声明：

```json
{
  "name": "@lab/crossref-lookup",
  "version": "1.0.0",
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "./bundle.yml" } },
  "somniq": {
    "manifestVersion": 1,
    "capabilities": {
      "schemaVersion": 1,
      "mcp": {
        "crossref": {
          "env": ["CROSSREF_MAILTO"],
          "network": { "access": "required", "hosts": ["api.crossref.org"] },
          "workspace": "none",
          "workspaceFiles": ["scripts/normalize_doi.py"]
        }
      }
    }
  }
}
```

| 字段 | 取值 | 含义 | 校验 |
| --- | --- | --- | --- |
| `env` | 变量名数组，可空 | 从用户环境透传哪些变量（值来自这台电脑，卡片只列名称） | 名称 `^[A-Za-z_][A-Za-z0-9_]*$`，最多 32 个；不能是保留名；不能与包自己的 `env` 重名（大小写不敏感）；运行时变量不存在就不设，不报错 |
| `network.access` | `none` / `required` | 是否需要联网 | 必填 |
| `network.hosts` | 主机名数组，可选 | 打算访问的地址，给用户和以后的 Reviewer 核对 | 最多 32 个；`access: none` 时不得出现；省略表示"任意地址" |
| `workspace` | `none` / `read` / `write` | 是否需要直接访问项目目录 | 必填；不为 `none` 时提供 `SOMNIQ_WORKSPACE_ROOT`；实际访问不受限，标"仅声明" |
| `workspaceFiles` | 工作区相对路径数组，可选 | 运行时要用到的工作区文件（依赖闭包），以批准时的副本交给插件 | 只能是普通文件（v1 不收目录）；必须存在、不是符号链接、不在 `.somniq/` 下；最多 16 个，合计不超过 4 MiB；不要求 `workspace` 不为 `none` |

规则：

- 包里每个 MCP 服务都必须有一条声明；声明了不存在的服务名，或缺了某个服务的声明，
  都给诊断（缺声明怎么处理见决策 C-D1）。
- 只有面板的包不需要 `capabilities`。带 Skill 的包也不需要，但 Skill 目录里的脚本会在
  卡片上列出（现状第 7 条）。
- 包自己的 `env` 键同样要符合 `^[A-Za-z_][A-Za-z0-9_]*$`，不许出现只差大小写的重复键。
- `somniq.manifestVersion` 仍为 1；`ui` 和 `capabilities` 都可选，但至少要有其一。
  这是新增字段，旧包不受影响。
- 所有上限、枚举、保留名放进 `runtime::plugins` 的常量，校验器和 `authoring_contract()`
  共用，沿用 M1 的对拍测试。

## 宿主怎么起插件进程

`McpStdioServerConfig` 和 `McpStdioTransport` 增加类型化字段：

- `working_directory`、`own_process_tree`、`framing`：三个宿主控制项，所有来源共用；
- `plugin: Option<PluginProcessPolicy>`：插件来源才有。

`PluginProcessPolicy` 包含：数据目录、透传变量名、宿主变量、网络模式、交给插件的文件
副本目录及其摘要。

手工配置的服务 `plugin` 恒为 `None`。用户写在 `mcp.json` 里的三个旧环境变量键为兼容
继续认，转换进类型化字段。内置 Oracle 直接改用类型化字段。插件包里出现这些键一律报
保留名诊断。

`McpStdioProcess::spawn` 遇到 `plugin: Some(..)` 时：

1. **清空环境**（`env_clear`），执行上下文不再叠加到插件进程上。之后按顺序加入：
   - **平台基础变量**，取自 SomniQ 进程：
     - Windows：`SystemRoot`、`windir`、`SystemDrive`、`ComSpec`、`PATHEXT`、`PATH`、
       `USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`APPDATA`、`LOCALAPPDATA`、`ProgramData`、
       `ALLUSERSPROFILE`、`ProgramFiles`、`ProgramFiles(x86)`、`ProgramW6432`、
       `CommonProgramFiles`、`CommonProgramFiles(x86)`、`PSModulePath`、
       `NUMBER_OF_PROCESSORS`、`PROCESSOR_ARCHITECTURE`、`OS`、`USERNAME`；
     - 其他平台：`PATH`、`HOME`、`USER`、`LOGNAME`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TZ`、
       `XDG_RUNTIME_DIR`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`；
     - 两边都加 `SOMNIQ_PYTHON`。
     - `PATH` 用 SomniQ 当前的值（用户选的 Python 环境加 SomniQ 的工具路径），去掉空段和
       相对路径段。
   - **宿主变量**：
     - `SOMNIQ_PLUGIN_ROOT`：快照目录；
     - `SOMNIQ_PLUGIN_DATA`：本插件的可写数据目录，放在
       `<SomniQ 配置>/plugin-data/<项目键哈希>/<包名哈希>/`。它不在 `plugins/` 下，
       信任库和可写数据分开，以后 C3 的 ACL 才能只放行数据目录；
     - `TEMP`、`TMP`、`TMPDIR`：都指向 `<数据目录>/tmp`；
     - `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`：中文 Windows 默认代码页是 GBK，stdio 上
       的 JSON 会被它弄坏；
     - Windows 上加 `NoDefaultCurrentDirectoryInExePath=1`，让 `cmd` 不在当前目录找程序；
     - 声明了 `workspaceFiles` 时，加 `SOMNIQ_PLUGIN_FILES`，指向批准时副本的只读目录
       （保持原相对路径）；
     - `workspace` 不为 `none` 时，加 `SOMNIQ_WORKSPACE_ROOT`，指向本次运行实际工作的
       目录（Chat 为项目目录，工作任务为它的 worktree）；
     - `network.access: required` 时，加代理（来源见决策 C-D3），并透传 `NO_PROXY` 和
       证书变量 `SSL_CERT_FILE`、`SSL_CERT_DIR`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`、
       `NODE_EXTRA_CA_CERTS`（走 TLS 拦截的校园网、公司网需要）。
   - 声明里 `env` 点名的用户变量。
   - 包自己写的 `env`。它和前面任何一类重名，都在预览时就被拒绝，不存在"后写的覆盖先写
     的"这回事。
2. **工作目录**一律是数据目录。项目目录只经 `SOMNIQ_WORKSPACE_ROOT` 告诉插件。这样
   `python -m`、`cmd` 垫片、`npx` 都不会从项目目录里找代码。
3. **进程树**：插件进程一律进 Job Object（Windows）或进程组（其他平台），`kill_on_drop`
   恒为真。
4. **分帧**：插件 v1 只支持 MCP 标准的换行分隔 JSON。
5. **网络**：`access: none`，并且 `capability_enforcement()` 的探测确认能用时，命令包成
   `unshare --user --map-root-user --net --pid --fork --kill-child -- <command> <args>`
   （不经过 shell）：
   - `--kill-child` 让 `kill_on_drop` 杀掉 `unshare` 时，命名空间里的进程树一起结束；
   - 探测要真的执行一次这个包装，不能只看 `unshare` 在不在 PATH。
   其他情况照常启动，卡片标"仅声明"。

**交给插件的工作区文件。** 批准时，宿主把 `workspaceFiles` 的当前内容按摘要存进
`<SomniQ 配置>/plugins/files/<sha256>`，再为这次批准拼出一个只读视图目录（原相对路径）。
插件从 `SOMNIQ_PLUGIN_FILES` 读，拿到的永远是用户批准过的字节，不受之后工作区改动或
并发写入的影响。插件若绕过副本、直接读工作区原件，属于"仅声明"的范畴。

这样做，"把我的 `scripts/x.py` 包成工具"仍然成立：插件按 `SOMNIQ_PLUGIN_FILES/scripts/x.py`
加载。用户改了原件以后，重新批准就会换成新副本，见"批准与升级"。

**保留名**：包的 `env` 和声明的 `env` 都不许用，大小写不敏感，诊断 `env-reserved`。

- 以 `SOMNIQ_` 或 `ARIS_` 开头的任何键；
- 平台基础变量、宿主变量、代理变量、证书变量；
- 解释器和加载器的控制键：`NODE_OPTIONS`、`NODE_PATH`、`PYTHONPATH`、`PYTHONHOME`、
  `PYTHONSTARTUP`、`PYTHONINSPECT`、`PERL5OPT`、`PERL5LIB`、`RUBYOPT`、`RUBYLIB`、
  `JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`DYLD_` 开头的键、
  `BASH_ENV`、`ENV`、`NoDefaultCurrentDirectoryInExePath`。

包要找自己的文件，用 `SOMNIQ_PLUGIN_ROOT` 或命令行里的 `./`；不需要 `PYTHONPATH`。

**快照外的代码。** 预览时识别两类命令：

- 运行时下载代码的启动器：`npx`、`pnpm dlx`、`yarn dlx`、`bunx`、`uvx`、`pipx run`，
  以及 `deno run` 后面跟 URL 的写法。卡片标"运行时下载 `<包>@<版本>`，批准不覆盖其内容"。
  是否要求固定版本，见决策 C-D5。
- 指向快照外的绝对路径：卡片标"运行快照外的程序"。如果路径落在项目目录里，就报
  `workspace-file` 错误，要求改用 `workspaceFiles`。

## 强制等级

`runtime::plugins::capability_enforcement()` 在运行时探测，返回每一项在这台电脑上的等级。
等级的含义（卡片底部原样写出）：

- **已强制**：宿主这样设置了插件进程，例如它的环境、所在的 Job。同一用户下的恶意代码
  仍可能用别的手段拿到更多。
- **尽力**：宿主做了，但存在已知的绕过方式。
- **仅声明**：宿主做不到，靠插件自觉遵守。

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 环境里只有上文四类变量 | 已强制 | 已强制 | 已强制 |
| 宿主控制项不可改 | 已强制 | 已强制 | 已强制 |
| 工作目录不是项目目录 | 已强制 | 已强制 | 已强制 |
| 子孙进程随 SomniQ 结束 | 已强制（Job Object） | 尽力（进程组，`setsid` 可逃逸） | 尽力；用命名空间包装时为已强制 |
| 交给插件的工作区文件就是批准时的内容 | 已强制 | 已强制 | 已强制 |
| 不访问网络（`access: none`） | 仅声明 | 仅声明 | 探测通过时已强制，否则仅声明 |
| 只访问 `hosts` 里的地址 | 仅声明 | 仅声明 | 仅声明 |
| 工作区访问级别、不直接读工作区原件 | 仅声明 | 仅声明 | 仅声明 |

## 批准与升级

**批准记录。** `approvals.json` 升到 schema 2，每个包从"摘要字符串"改成对象：

```json
{
  "schema": 2,
  "projects": {
    "<项目规范路径>": {
      "@lab/crossref-lookup": {
        "digest": "<包摘要>",
        "workspaceFiles": { "scripts/normalize_doi.py": "<sha256>" },
        "enforcement": { "processTree": "enforced", "networkNone": "declared" }
      }
    }
  }
}
```

- **兼容。** 读 schema 1 时，字符串按 `{digest, workspaceFiles: {}, enforcement: {}}` 理解；
  写一律写 schema 2。旧的开发版读到 schema 2 会在反序列化时报"批准文件不可读"，所有插件
  停下，属于失败即关闭。插件功能还没发布，只影响开发版本。
- **运行条件**变成：项目请求 ∧ 批准的包摘要 = 快照摘要 ∧ 副本存储里有批准的每个文件 ∧
  当前强制等级不低于批准时。
- **`workspaceFiles` 的根**一律是登记的项目根（与批准同一个），工作任务也不例外。插件拿
  的是副本，任务在 worktree 里改原件不影响正在用的插件。
- **原件变了。** `list` 比较项目里的原件和批准的副本，不一致时插件照常用副本运行，插件页
  显示"工作区文件有新版本，重新批准后生效"，并给出文本差异（副本存着旧内容，所以能比）。
  是否改为停下，见决策 C-D4。
- **重新批准必须绑定用户看到的内容。** 卡片载荷和批准请求都带上文件摘要，插件页开关也传入
  预期摘要。写批准时在同一把锁里核对，任何一个不一致就拒绝，与 `PACKAGE_CHANGED_SINCE_SHOWN`
  同一套做法。
- **冻结集。** `FrozenPlugin` 和集合指纹加入文件摘要。这样重新批准后，在途运行会显示
  `needs-restart`；`plugin_set` 事件也记下每个包用的文件摘要，作为审计记录。
- **升级回滚**（`upgrade()` 失败时）恢复整个批准对象，不只是摘要。
- **强制等级下降**（例如 Linux 上的命名空间突然不可用了）：插件进入 `approval-required`，
  原因写"这台电脑上的限制变弱了"，重新批准时卡片显示新的等级。

**升级差异。** `CapabilityDiff` 每个服务增加：透传变量的增删、`network.access` 的变化、
`hosts` 的变化、`workspace` 级别的变化、`workspaceFiles` 的增删和内容变化、快照外命令的
变化。凡是能力扩大，都用用户语言高亮：

- 新增网络访问；
- `hosts` 新增地址，或从列出的地址变成省略（等于"任意地址"），后者也算扩大，不算删除；
- 新增透传变量；
- `workspace` 从 `none` 升到 `read`，或从 `read` 升到 `write`；
- 新增运行时下载或快照外的程序。

**`executionUnchanged` 收紧为**：命令行、环境变量键、环境变量值、能力声明、交给插件的
文件都没变。Chat 卡片照插件页的做法，逐个服务列出值变了的键（`envChanged`，只列名称）。

## 卡片与插件页

每个 MCP 服务一组，每条一行，行尾带强制等级：

```
crossref  python ./server.py
  环境变量    系统基础变量，加上你电脑上的 CROSSREF_MAILTO          已强制
  网络        需要：api.crossref.org                              仅声明
  工作目录    插件自己的数据目录，不是项目目录                        已强制
  项目文件    拿到 scripts/normalize_doi.py 批准时的副本              已强制
  进程        随 SomniQ 退出一起结束                                已强制
```

- 带脚本的 Skill 另起一行："Skill 带 N 个脚本（列出路径）。Agent 用 Bash 运行它们时，
  它们拿到完整环境，不受本清单约束"。
- 有运行时下载或快照外的程序时，另起一行写明，等级为"仅声明"。
- 卡片底部写出三种等级的含义（见"强制等级"）；有任何一项"仅声明"时，再加一句：这些
  限制在这台电脑上靠插件自觉遵守。
- 插件页卡片和 Chat 批准卡片用同一个后端载荷（`capabilities_output` 扩展），前端只负责
  展示，不自己推断等级。
- 手机端只显示，不批准（D3 不变）。

## 作者侧

- `PluginManager inspect` 返回 `capabilities` 的字段、上限、保留名，以及本机的
  `capability_enforcement()`，让 Agent 能如实告诉用户哪些限制宿主做得到。
- 三套模板更新：
  - `mcp-stdio-python` 声明 `env: []`、`network.access: none`、`workspace: none`；
  - 模板 `server.py` 的说明和 `authoring.rs` 契约里"工作目录是项目"的说法改掉；
  - `chat-panel`、`skill-pack` 不变。
  - 模板零诊断测试照旧覆盖。
- Skill `somniq-plugin-development` 增加：
  - 默认把代码放进包里。只有用户明确要"用我工作区里那个脚本"时才写 `workspaceFiles`，
    从 `SOMNIQ_PLUGIN_FILES` 读，并告诉用户改了脚本要重新批准才生效；
  - 能力按最小需要声明；
  - 包内文件用 `SOMNIQ_PLUGIN_ROOT` 找，状态存 `SOMNIQ_PLUGIN_DATA`；
  - 不用运行时下载的启动器，除非用户要接一个现成的 MCP 服务，而且版本要写死。
- 新诊断码：`capabilities-missing`、`capabilities-server`、`capabilities-field`、
  `env-key`、`env-reserved`、`env-overlap`、`workspace-file`、`runtime-fetch`，每个都配
  `hint`。M1 有一项测试扫描插件源文件里的诊断码，要求每个都有 hint 且出现在 inspect 里；
  新增的 `capabilities.rs` 要加进它扫描的文件列表。

## 实现要点

- `scoped_mcp_config_hash`（`crates/runtime/src/mcp.rs`）是手工拼字符串的，要把三个控制项
  和 `PluginProcessPolicy`（含文件摘要）显式拼进去，发现缓存和 MCP 健康才会随之换键。
- `mcp_entries`（`plugins/mod.rs` 的自由函数，`lifecycle.rs` 也调用）现在只接收包本身，
  拿不到批准和冻结集里的文件摘要。要改成接收"这次运行看到的批准"。
- 平台基础变量、保留名、启动器名单都写成常量，校验器、执行器、`inspect` 共用。
- 代理地址用与 Desktop 设置相同的规范化逻辑（`tools::web::normalize_web_proxy_url`，它拒绝
  带用户名密码的地址）。runtime 不依赖 `tools`，所以由 Desktop 传入规范化后的值，或把
  函数下沉到 runtime。

## 分期

| 里程碑 | 内容 | 用户能看到什么 |
| --- | --- | --- |
| C1 宿主卫生 | 三个控制项改类型化字段，Oracle 迁移；插件服务恒进 Job Object（Unix 进程组杀法补 CI 测试）；插件 `env` 键的语法和保留名诊断；工作目录改为数据目录，过渡期总提供 `SOMNIQ_WORKSPACE_ROOT`；`executionUnchanged` 计入值变化，Chat 卡片显示 `envChanged` | 卡片不再漏掉执行面变化；插件进程不再残留；工作区内容不能借插件运行 |
| C2 清单与环境白名单 | 清单解析（`ui` 改可选）、`env_clear` 加白名单、宿主变量、`workspaceFiles` 副本与 schema 2 批准、冻结集与生命周期、差异扩展、快照外代码识别、卡片与插件页、`inspect`、模板、Skill | 满足全部成功标准 |
| C3 系统级强制 | Linux 命名空间包装（含真实探测）；Windows AppContainer 探路；macOS `sandbox-exec` 探路 | 有条件的平台上，"不访问网络"从仅声明变成已强制 |
| 以后 | 已强制只读的工具可在非完全权限下调用（给作者一个声明能力的理由）；独立 Reviewer 审包时对照声明与代码；`hosts` 经出口代理强制；Skill 脚本经 Bash 运行时套用所属插件的环境策略 | — |

C3 里 Windows 的探路要回答：

- 用户选的 Python、python.org 安装的 Python、Node 能不能在 AppContainer（或 LPAC）里启动；
- 快照目录、数据目录、副本目录需要加哪些 ACL；
- `internetClient` 能力能否作为网络开关；
- 用户的杀毒软件会不会拦。

探路结果决定做不做，不预先承诺。

C1 和 C2 都会改到 M1–M3 尚未提交的文件：

- C1 涉及 `dsh.rs`、`plugins/mod.rs`、Desktop `plugins.rs`、`ChatMessage.tsx`；
- C2 再加上 `ui.rs`、`authoring.rs`、`lifecycle.rs`、`PluginPackages.tsx`、`api/plugins.ts`。

所以都应在 M1–M3 入库后开工。C1 改动小，可以紧接着做。

## 待定决策

**C-D1：MCP 服务没有能力声明时怎么办？**
建议：阻止启用（诊断 `capabilities-missing`）。插件功能从 0.4.87 才有，还没发布，没有
存量包要兼容；模板和示例随本设计一起更新。代价是上游 DSH 包里带 MCP 的，要补一段
`somniq.capabilities` 才能启用；只带 Skill 的不受影响。另一个选项是按旧行为运行，并在
卡片上标红。它会让"没声明"成为最省事的写法，生态从一开始就往错的方向长。

**C-D2：`workspaceFiles` 要不要支持？**
建议：支持，以批准时的副本交给插件。用户说"把我的 `scripts/fetch_doi.py` 包成工具"时，
常常希望改了脚本，工具就能跟上；有了副本，改动要经过一次重新批准才生效，并且能看到差异。
另一个选项是完全禁止，只许把代码复制进包。它最简单，但用户每改一次脚本都要让 Agent
升级一次包。

**C-D3：联网的插件用什么代理？**
建议：沿用 SomniQ 的研究网络代理设置 `ARIS_WEB_PROXY_URL`（规范化后），设了就作为
`HTTP_PROXY` / `HTTPS_PROXY` 传入，没设就不给代理。这与 Desktop `config.rs`"缺省即直连，
不回落到继承的代理"的规则一致，而且设置里已经拒绝带密码的地址。另一个选项是透传进程
继承来的 `HTTP(S)_PROXY`，但那些地址里可能带用户名和密码。

**C-D4：工作区里的原件变了以后？**
建议：插件继续用批准时的副本运行，插件页提示有新版本并给出差异，重新批准后生效。因为
插件拿的是副本，继续运行并不会执行没批准过的字节。另一个选项是停下，等重新批准，更醒目，
但用户每改一次脚本插件就停一次。

**C-D5：运行时下载代码的启动器（`npx`、`uvx` 等）？**
建议：允许，但要求写死精确版本（例如 `pkg@1.2.3`），没写死就报 `runtime-fetch` 错误；
卡片标"运行时下载，批准不覆盖其内容"。npm、PyPI 上同一个版本号的内容不可覆盖，写死版本
后实际运行的代码基本固定，而导入现成的 MCP 服务正需要这类启动器。其他选项：完全禁止（导入
现有生态时会挡住大量服务），或不写死版本也允许（批准几乎没有意义）。

## 验收测试

runtime：

- 真实启动一个 stdio MCP 服务（模板加一个只在测试里用的 `env_dump` 工具）：
  - 进程环境里放一个哨兵变量 `SOMNIQ_TEST_CANARY_SECRET`，服务里看不到；执行上下文里的
    变量（`ARIS_READONLY_ROOTS`、`ARIS_PLUGIN_RUN`）也看不到；
  - 声明透传的变量看得到；
  - 平台基础变量齐全，Windows 上 Python 能正常启动（缺 `SystemRoot` 时会起不来，这条正好
    验证白名单没有删过头）；
  - 工作目录是数据目录；`workspace: none` 时没有 `SOMNIQ_WORKSPACE_ROOT`。
- 项目目录里放一个 `json.py`，插件用 `python -m` 启动，导入的仍是标准库。Windows 上在项目
  目录放 `npx.cmd`，插件经 `cmd /c npx` 启动时不会运行它。
- 包的 `env` 里写 `SOMNIQ_MCP_WORKING_DIRECTORY`、`ARIS_MCP_STDIO_FRAMING`、
  `node_options`（小写）、`PATH`、`A=B`、只差大小写的两个键，以及与透传名重名的键，分别
  报相应的诊断，`can_enable = false`。
- 插件服务起一个脱离父进程的孙进程。`McpServerManager` 关闭或丢弃后，Windows 上和 Linux
  命名空间包装下，孙进程都已结束；Unix 进程组杀法有 CI 覆盖。
- 只改环境变量值的升级，`CapabilityDiff` 标为变化，`executionUnchanged` 为 false。
- `workspaceFiles`：
  - 批准后改原件，插件仍拿到旧副本；插件页显示有新版本和差异；
  - 重新批准后拿到新副本，在途运行显示 `needs-restart`；
  - 卡片显示之后原件又被改，重新批准被拒绝；
  - 工作任务里，副本取自登记的项目根，`SOMNIQ_WORKSPACE_ROOT` 指向 worktree。
- `approvals.json` schema 1 能读，写出来是 schema 2；升级失败回滚后整个批准对象不变。
- 强制等级下降时插件进入 `approval-required`。
- `capability_enforcement()` 的每个"已强制"项都有对应平台的测试。Linux 网络探测要真的执行
  包装：在宿主的 127.0.0.1 上监听一个端口，命名空间里连接失败；包装执行失败时，等级降为
  "仅声明"。
- `npx -y pkg` 不写版本报 `runtime-fetch`；写死版本可以启用，卡片带"运行时下载"一行。
- `inspect` 返回的字段、上限、保留名与校验器常量一致（对拍）。
- 模板零诊断；`mcp-stdio-python` 模板经真实 `McpServerManager` 调 `ping`，仍返回 `pong`。

desktop：

- 卡片载荷每个服务都带能力和等级。
- Oracle 改用类型化字段后，工作目录和进程树行为不变，现有 Oracle 测试照旧通过。
- 手工 `mcp.json` 的服务仍继承完整环境，写了三个旧环境变量键时照旧生效。这是回归测试，
  防止误伤。

前端：

- 卡片和插件页按等级显示，底部写出等级说明；能力扩大的差异高亮。
- Chat 升级卡片显示 `envChanged`。
- 带脚本的 Skill 有说明行。

应用内实测（debug 版 + CDP）：

- 让 Agent 做一个查 Crossref 的 MCP 插件，确认卡片上的网络、环境变量行与实际一致；
- 改 `workspaceFiles` 里的脚本，确认插件仍用旧副本，并且能看到差异、重新批准。

## 不做

- 插件之外的 MCP 服务的环境隔离（用户自己的配置，信任级别不同）。
- 项目级钩子和 `.mcp.json` 迁移的批准（另立任务，见威胁模型）。
- 文件系统隔离、`hosts` 白名单的强制、Skill 脚本的环境约束（见分期"以后"）。
- 改变权限模式与 MCP 工具调用的关系（仍要求完全权限）。
- 改变独立 Reviewer 或 Executor → Reviewer → revision 流程。

## 评审记录

2026-11-08，一个不带本设计推理过程的独立审查子代理只读审查了初稿，核对了"现状"里的每条
引用，提出 22 条意见（1 条阻断、10 条主要、11 条次要）。主会话逐条对照代码核实后处理：

- **采纳并改进设计的：**
  - Skill 脚本绕过清单（阻断）：写进现状和威胁模型，卡片列出；约束它放进"以后"。
  - 项目目录作工作目录会让工作区内容借插件运行：工作目录一律改为数据目录，加
    `NoDefaultCurrentDirectoryInExePath`，过滤 `PATH`。
  - `workspaceFiles` 只在启动时核对，而进程活一整个回合、缓存命中时还推迟启动：改为把批准
    时的副本交给插件。
  - "已强制"对同一用户下的恶意代码说过头了：给出等级定义，写在卡片上。
  - 快照外、运行时下载的代码：新增识别和 C-D5。
  - 工作任务里的根没说清：写明。
  - `unshare` 缺 `--kill-child`，探测不真实：已修。
  - Chat 卡片不显示 `envChanged`：已加。
  - 重新批准没绑定文件摘要：已加。
  - 包 `env` 键没校验语法：已加。
  - `hosts` 省略算扩大：已改。
  - 第三个控制项 `ARIS_MCP_STDIO_FRAMING`：已补。
  - 配置哈希、`mcp_entries` 的实现约束：写进"实现要点"。
  - 冻结集没记文件摘要：已加。
  - schema 2 的报错文案和回滚：已改。
  - 包 `env` 与透传重名：改为拒绝。
  - 基础变量缺项（证书、`NO_PROXY`、`PSModulePath` 等）：已补。
  - 强制等级下降：改为要求重新批准。
  - 文中不一致：已改。
  - 数据目录放在信任库里：已挪出。
  - Unix 进程组杀法要有 CI：已加。
- **另立任务的：** 项目级钩子、`.mcp.json` 迁移让工作区内容在插件体系之外运行代码。已核实
  Desktop Chat 回合确实用合并后的钩子构造 `HookRunner`。
- **没有采纳的：** schema 2 只在需要时才写（为了让旧开发版还能读）。插件未发布，这点兼容
  不值得增加分支。
