# 远程 SSH 主机 clangd 来源与版本探测事实（#187）

- Ticket: https://github.com/hyoteis/orca/issues/187 （地图：#170；上游约束票：#174 远程架构、#175 生命周期、#172 磁盘/索引预算、#171 relay 传输盘点）
- 调查日期：2026-09-13。仓库结论以 origin/main（e86cba888b）源码为准，出处格式 `文件:行号`；外部结论以官方包页 / 官方源码 / 官方发布资产为准，出处为 URL。
- 信源强度标注：发行版与上游官方页 = A；上游源码 = A；由 A 级事实直接推出 = B（标 [推断]）；环境相关、无法统一佐证 = C（显式声明不结论）。
- 本文档只陈述事实，**不做决策**。

## TL;DR

1. **发行版默认版本跨度极大**：Ubuntu 22.04 默认 clangd 14（最高 15）、24.04 默认 18（最高 20）、Debian 12 默认 14（最高 15，backports 无更新）、RHEL/Rocky 9 当前 21.1.8、Fedora 43 = 21.1.2、Arch ≈ 最新（22.1.8）、openSUSE Tumbleweed = 23。同一产品要面对 14–23 共约 10 个大版本的现实。
2. **上游补齐渠道**：apt.llvm.org 覆盖 jammy/noble/bookworm（clangd-21/22/23，需 root）；**无 sudo 的官方路径是 clangd 独立 zip（Linux x64 约 109.5 MiB）**，解包即用、零联网、零安装器；LLVM 全量 tarball 1.8 GiB 起步，量级完全不同。
3. **`clangd --version` 第一行格式自 clangd 9 起未变**：`[<厂商前缀>]clangd version <版本>[ <仓库/发行版尾注>]`，由 `getClangToolFullVersion("clangd")` 生成（源码级证实，跨 9/13/18/main 四个分支验证）；13+ 追加 `Features:`/`Platform:` 两行。稳定解析锚点 `clangd version (\d+)\.(\d+)`。
4. **能力随版本出现的官方时间线**：标准 semanticTokens = 11；inlay hints 扩展 = 13（旗标后）、默认开 = 14、标准 LSP 3.17 inlayHint = 15。16 以后官方 release notes 停更（in-tree 空壳 + 独立发布一句话 body），16+ 能力增量没有官方 notes 佐证。
5. **Orca 既有探测先例两套**：daemon 存在前 = raw SSH exec channel 上跑 marker 哨兵脚本（平台/node/npm/原生依赖探针，30s 默认超时）；daemon 存在后 = relay RPC（`preflight.detectAgents` 查存在性、`agent.execNonInteractive` 跑命令）。**版本字符串探测只有前者有先例**，后者现有 preflight 只回布尔不回版本。
6. **`lsp.*` 方法族在 origin/main 不存在**（全仓 grep 零注册），仓库无任何 clangd 引用；relay 侧新增方法按 #171 结论要付 bundle-hash 换目录/strand 旧会话的成本。
7. 探测一次的成本：daemon 前 = 1 条 SSH exec channel 的开关 + 命令执行（部署期已并行化、session-limit 时顺序回退）；daemon 后 = 既有单 channel 上 1 个 JSON-RPC 请求/应答帧（客户端默认 30s 超时）。

## 1. 获取渠道现实

### 1.1 发行版包名与版本（全部为 A 级官方包页/官方构建产物）

| 发行版 | 包名形态 | 默认（`clangd` 虚包指向） | 该 suite 内可得上限 | 出处 |
|---|---|---|---|---|
| Ubuntu 22.04 jammy | `clangd` = llvm-defaults 依赖包（universe）→ `clangd-14`；版本包 `clangd-N` | 14 | **15**（`clangd-15` 1:15.0.7-0ubuntu0.22.04.3，经 -updates）；16/17/18 页面不存在 | https://packages.ubuntu.com/jammy/clangd ；https://packages.ubuntu.com/jammy/clangd-15 |
| Ubuntu 24.04 noble | 同上 → `clangd-18` | 18 | **20**（`clangd-19` 1:19.1.1-1ubuntu1~24.04.2；`clangd-20` 1:20.1.2-0ubuntu1~24.04.3）；21 页面不存在 | https://packages.ubuntu.com/noble/clangd ；https://packages.ubuntu.com/noble/clangd-20 |
| Ubuntu 25.04 questing（参照） | `clangd` 1:20.0-63ubuntu1 | 20 | — | https://packages.ubuntu.com/questing/clangd |
| Debian 12 bookworm | `clangd` = 依赖包 → `clangd-14`（1:14.0-55.7~deb12u1）；suite 内另有 `clangd-13`(13.0.1-11)、`clangd-15`(15.0.6-4) | 14 | **15**；bookworm-backports 的 clangd-16/17/18/19/20 页面全部不存在 | https://packages.debian.org/bookworm/clangd ；https://packages.debian.org/bookworm/clangd-15 |
| Debian 13 trixie（参照，现 stable） | `clangd` 1:19.0-63 | 19 | — | https://packages.debian.org/trixie/clangd |
| RHEL / Rocky 9 | 二进制包名 `clang-tools-extra`（clangd 在其中；源自 `clang` 源码包） | — | **21.1.8**（clang-tools-extra-21.1.8-2.el9.x86_64，当前 9 AppStream os 树） | https://dl.rockylinux.org/pub/rocky/9/AppStream/x86_64/os/Packages/c/ （目录索引）；注：同一发布源 source 树仅存 clang-18.1.8-3.el9.src.rpm，源/二进制树更新不同步，以二进制树为准 |
| Fedora | 二进制包名 `clang-tools-extra` | — | F40 = 18.1.8；F42 = 20.1.1（已 EOL 归档）；F43（当前）= **21.1.2** | F40：https://bodhi.fedoraproject.org/updates/?packages=clang（clang-18.1.8-2.fc40）；F42：https://archive.fedoraproject.org/pub/archive/fedora/linux/releases/42/Everything/x86_64/os/Packages/c/ ；F43：https://dl.fedoraproject.org/pub/fedora/linux/releases/43/Everything/x86_64/os/Packages/c/ |
| Arch | 无独立 clangd 包；`clang` 包 **Provides: clang-tools-extra=22.1.8**（22.1.8-1，extra 仓库） | ≈最新 22.1.8 | 同左 | https://archlinux.org/packages/extra/x86_64/clang/ |
| openSUSE Tumbleweed | 版本化包（`_sonum 23` → llvm23/clang23 系） | 滚动 23 | — | https://api.opensuse.org/public/source/openSUSE:Factory/llvm/llvm.spec（`%define _sonum 23`）；Leap 未核查 |
| macOS Homebrew | `llvm` formula（23.1.1，keg-only；clangd 随包，路径 `$(brew --prefix)/opt/llvm/bin`）；**无独立 `clangd` formula**（404）；版本化 `llvm@19` = 19.1.7 等 | 23.1.1 | — | https://formulae.brew.sh/formula/llvm ；https://formulae.brew.sh/formula/clangd （404）；https://formulae.brew.sh/api/formula/llvm@19.json |

补充：clangd 官方安装页自述——发行版 `clangd` 包"usually give you a slightly older version"；clangd 8 之前在 `clang-tools` 包内；版本包装到 `/usr/bin/clangd-N` 需 update-alternatives 指到默认名（https://clangd.llvm.org/installation ，源 https://github.com/llvm/clangd-www/blob/main/installation.md ）。

### 1.2 LLVM 官方 apt 仓库（apt.llvm.org）

- 覆盖 bullseye / bookworm / jammy / noble / trixie（页面各成节）；当前提供 `llvm-toolchain-21/22/23`，对应 `clangd-21/22/23` 包（https://apt.llvm.org/ ）。
- 即 jammy/bookworm 的版本天花板（14/15）可由该仓库抬到 23；正常安装需 root。

### 1.3 LLVM 官方发布资产（GitHub llvm/llvm-project releases，A 级）

- LLVM 22.1.6 全量 tarball（含 clangd）：
  - `LLVM-22.1.6-Linux-X64.tar.xz` = 1,937,446,204 B ≈ **1.80 GiB**（压缩后）
  - `LLVM-22.1.6-Linux-ARM64.tar.xz` = 1,770,949,840 B ≈ 1.65 GiB
  - `clang+llvm-22.1.6-x86_64-pc-windows-msvc.tar.xz` = 861,999,212 B ≈ 0.80 GiB（Windows 资产沿用 clang+llvm 前缀）
  - 出处：https://github.com/llvm/llvm-project/releases/tag/llvmorg-22.1.6 （GitHub Releases API 资产清单）
  - 布局为标准 CMake 安装前缀（`bin/`、`lib/`、`include/`），clangd 在 `bin/clangd` **[推断-B]**（.jsonl 伴生资产是 sigstore 签名束而非文件清单，tar 内路径未从官方页直接佐证；zip/tarball 为前缀布局是 LLVM 发布惯例）。

### 1.4 clangd 官方独立二进制发布（github.com/clangd/clangd，A 级）

- 最新稳定线：20.1.0/20.1.8 → 21.1.0/**21.1.8**（2025-12-21）→ 22.1.0/**22.1.6**（2026-05-28）；**23.1.0 已发布但标记 prerelease**（2026-09-02）；另有每周 snapshot（tag 形如 `snapshot_20260906`）。
- 22.1.6 资产实测大小（GitHub API）：

| 资产 | 字节 | MiB |
|---|---|---|
| clangd-linux-22.1.6.zip | 114,790,601 | 109.5 |
| clangd-mac-22.1.6.zip | 98,113,276 | 93.5 |
| clangd-windows-22.1.6.zip | 28,198,778 | 26.9 |
| clangd_indexing_tools-linux-22.1.6.zip | 146,710,509 | 139.9 |

- 出处：https://github.com/clangd/clangd/releases （releases 列表与资产 API）。`clangd_indexing_tools` 含 clangd-indexer 等——与 #172 的"预建索引分发（--index-file）是活路线"直接相关。
- 官方安装页明示：macOS/Windows/Linux(x86-64) 可直接下载二进制 zip，snapshot 每周构建（installation.md，§"Standalone .zip releases"）。

## 2. 版本与能力探测

### 2.1 `clangd --version` 输出格式（源码级，A 级）

- 输出由 `llvm::cl::SetVersionPrinter` 注册（clangd/tool/ClangdMain.cpp）：
  - main：`ClangdMain.cpp:783-787` —— 三行：`versionString()`、`"Features: " + featureString()`、`"Platform: " + platformString()`
  - release/13.x：`ClangdMain.cpp:680-684`（同样三行）；release/18.x：`ClangdMain.cpp:728-732`（同样三行）
  - release/9.x：`ClangdMain.cpp:435-437` —— **仅一行** `clang::getClangToolFullVersion("clangd")`，无 Features/Platform 行
- 版本行构成（clang/lib/Basic/Version.cpp:100-111，main）：`getClangVendor() + "clangd" + " version " + CLANG_VERSION_STRING [+ " " + 仓库尾注]`：
  - `getClangVendor()` 上游为空串；发行版经 `CLANG_VENDOR` 注入前缀（"Ubuntu "、"Debian "、"Fedora " 等是发行版构建产物中的已知形态 **[推断-B]**，机制本身 A 级：前缀由构建方注入、上游不设默认）。
  - `CLANG_VERSION_STRING` 可携带发行版修订（如 `-1ubuntu1.1`）；仓库尾注如 `tags/RELEASE_180/final`。
  - `versionString()` 定义在 clangd/Feature.cpp:17（`return clang::getClangToolFullVersion("clangd");`）。
- **结论事实**：第一行自 9 起调用同一函数、格式不变；稳定解析锚点是子串 `clangd version (\d+)\.(\d+)(\.(\d+))?`，厂商前缀在锚点左侧、发行版尾注在版本号右侧，均不进入捕获组。Features/Platform 行 9→13 之间加入，13 起稳定三行（13/18/main 逐字一致）。
- clangd 启动日志同样打印 `versionString()`（ClangdMain.cpp:901，main）——即 daemon 侧进程日志/`--log=verbose` 也能拿到版本串 **[推断-B]**（日志行格式由同一函数生成）。
- 官方检查手段即 `clangd --version`（installation.md："You can check the version currently installed with `clangd --version`"）。

### 2.2 LSP 能力随 clangd 版本出现的时间线（官方 release notes 佐证，A 级）

出处均为 llvm-project 对应 release 分支的 `clang-tools-extra/docs/ReleaseNotes.rst`（raw URL 可复现）：

| 能力 | 版本 | 事实 | 出处 |
|---|---|---|---|
| 背景索引默认开；索引落盘 `.clangd/index`（项目根） | 9 | "Background indexing is on by default"；"The index is written to `.clangd/index`" | release/9.x ReleaseNotes.rst |
| 语义高亮（当时为非标准协议，vscode PR#367 提案） | 9 | "This implements the proposed protocol" | 同上 |
| `--path-mappings`（远程/容器路径翻译） | 10 | "clangd can be more easily used remotely or in a docker container" | release/10.x ReleaseNotes.rst |
| **标准 `textDocument/semanticTokens`（LSP 3.16）** | **11** | "The `semanticTokens` protocol from LSP 3.16 is supported. (Only token types…no modifiers yet)"；非标准 `textDocument/semanticHighlighting` 弃用、12 移除 | release/11.x ReleaseNotes.rst（Highlighting 节） |
| inlay hints（clangd 扩展，`-inlay-hints` 旗标后） | 13 | "There's an extension for inlay-hints…hidden behind -inlay-hints flag"；"Support for legacy semantic tokens extension is dropped" | release/13.x ReleaseNotes.rst |
| inlay hints 默认开启（客户端能力门控） | 14 | "Inlay hints are now on-by-default in clangd, if the client supports and exposes them…the `-inlay-hints` flag has been removed"；`clangd/inlayHints` 扩展文档化 | release/14.x ReleaseNotes.rst（Inlay hints 节） |
| **标准 LSP 3.17 inlayHint 协议** | **15** | "Support for standard LSP 3.17 inlay hints protocol" | release/15.x ReleaseNotes.rst（Inlay hints 节） |
| 16+ | — | **官方 release notes 停更**：release/16.x 起 clangd 章节为空标题壳（16.x 的 Inlay hints/Diagnostics/… 各节全部无内容）；独立发布的 body 只有一句构建指针（如 22.1.0："Stable clangd 22.1.0 release / Built from llvm/llvm-project@4434dabb…"） | release/16.x ReleaseNotes.rst；https://github.com/clangd/clangd/releases/tag/22.1.0 |
| hierarchical document symbols | 未核实 | 9–15 的 release notes 未单列其引入版本，本次未获官方佐证——不臆断 | （核查范围：9/10/11/12/13/14/15 各分支 RST） |

- serverCapabilities 侧 **[推断-B]**（由上表协议采用时间直接推出）：`initialize` 应答中 `semanticTokensProvider` 自 11、标准 `inlayHintProvider` 自 15 出现；客户端按 serverCapabilities 门控即无需自行维护版本→能力映射，但 16+ 无 notes，新能力（如后来的 AST 语法树/类型层次增强）只能以 serverCapabilities 实测为准。
- hover markdown：release notes 未把 hover 渲染格式列为版本门槛（11 的 Hover 节只列内容增强）——渲染格式跟随客户端 `contentFormat` 能力是 LSP 语义 **[推断-B]**，版本门槛无官方佐证。

### 2.3 探测一次的 SSH 往返成本（Orca 拓扑事实）

- **daemon 存在前**（部署期）：每条探测 = 现有 SSH 连接上开一条 exec channel、执行、收尾。实现走 `execCommand`，默认 30s 超时（`src/main/ssh/ssh-relay-exec-command.ts:10,51`，`SSH_EXEC_TIMEOUT` 错误码 :29-33）。部署把平台探测/node 解析/安装态探测并行发起并带 AbortController 级联取消，遇 SSH 会话数上限回退顺序执行（`src/main/ssh/ssh-relay-deploy.ts:285-312`；顺序回退与不重试语义：`src/main/ssh/ssh-relay-deploy.test.ts:302-381,384-395`）。
- **daemon 存在后**：探测 = 单条复用 exec channel 上的一个 JSON-RPC 请求/应答帧；客户端请求默认 30s 超时（`src/main/ssh/ssh-channel-multiplexer.ts:59` `REQUEST_TIMEOUT_MS = 30_000`）。无新 SSH channel、无握手——单次成本 ≈ 1×SSH RTT + 远端命令执行时间。
- 既有探针的超时先例：preflight 单命令查找 5s（`src/relay/preflight-handler.ts:184`）、登录 shell 回退 8s（`src/main/ssh/ssh-remote-node-resolution.ts:23`）、原生依赖健康探针例外 240s（`src/main/ssh/ssh-relay-deploy-timing.ts:3`）。

## 3. 缺失时安装路径（无 sudo / 网络受限 / EDR）

- **clangd 官方 zip 是无 sudo 主路径**（A 级）：installation.md "Standalone .zip releases"——macOS/Windows/Linux(x86-64) 直接下载二进制；发行版包之外的官方推荐渠道。Linux 包 109.5 MiB（§1.4 实测），解包得到带版本号的独立目录、无需安装器/root/服务（zip 内容布局 **[推断-B]**：与 coc-clangd `:CocCommand clangd.install` 解包即用一致，官方页描述为"download binaries directly"）。
- **apt.llvm.org .deb 的无 root 用法**：仓库按 suite/版本发布独立 .deb（https://apt.llvm.org/ 提供包名与 URL）；`dpkg -x <deb> <dir>` 无特权解包（dpkg(1) `--extract`，https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html ）。
- **LLVM 全量 tarball 用户态解包**：1.80 GiB 压缩 / 解压后数 GiB **[推断-B]**；前缀布局理论上解到 `~/.local` 即可用（`bin/clangd` 相对前缀定位资源），与 clangd zip 相比无必要性差异、只多 1.7GiB 传输与磁盘。
- **网络受限**：zip/tarball 一次传输后运行期零联网（静态链接的独立二进制，官方发布形态即为此设计 **[推断-B]**——官方 zip 不声明运行期下载依赖）。编译安装（installation.md "Compiling from sources"）在受限环境不可行。
- **EDR / 执行策略** **[C 级，不结论]**：能否执行 `$HOME` 下二进制、能否写入 `~/.local`、noexec 挂载等属逐环境策略，无公开统一事实；本文档不对其下结论。仓库已有同类先例：远程 node 二进制发现本身就扫 `~/.local/bin`、volta/asdf 家目录等用户态安装位（§4.2），即"用户目录可执行"在 Orca 支持的远程形态里是常态假设。
- **磁盘预算（引 #172，不重查）**：#172 resolution 结论——LLVM 级（~10 万文件）稳态 RSS ~1–3GB[推断]（Chromium 官方 2.7GB 上界）、索引期峰值 4.1GB@-j8、索引落盘 `.cache/clangd/index/`（Chromium 级 ~550MB、单体 llvm.idx ≈270MB）。二进制量级与本票实测吻合：clangd zip 109.5 MiB ≈ #172 所述"二进制 ~100MB 量级"。总预算 = 索引(0.3–3GB) + 二进制(0.1–0.15GB)；全量 LLVM tarball 路线额外 4–6GiB **[推断-B]**。

## 4. Orca 既有远程探测先例（origin/main，文件:行号）

### 4.1 平台探测（daemon 前，raw exec）

- `detectRemoteHostPlatform`：带 marker 的双探针——POSIX 端 `uname` 输出前缀 `__ORCA_REMOTE_PLATFORM__`，Windows 端 PowerShell 探针；失败语义按"传输失败 > uname > PowerShell"优先级归并，且"探测通道被拒后不再烧第二条 exec 超时"（`src/main/ssh/ssh-remote-platform-detection.ts:13`（marker 常量）、`:24-52`（入口）、`:125-163`（两探针）、`:54-61,85-93`（放弃重试与错误优先级））。
- 部署顺序上它是第一步：`ssh-relay-deploy.ts:385-386`（"Detecting remote platform..." → `detectRemoteHostPlatform`），node 解析与安装态探测随后并发（`:285-312`）。

### 4.2 node 发现探测（daemon 前，raw exec）——最完整的"版本管理器感知"先例

- 单条 POSIX `sh` 脚本列出所有候选 node 路径：`command -v node` + 刮取 dotfile 里的 `NVM_DIR`/`MISE_DATA_DIR` + 硬编码候选清单（nvm/mise/fnm/asdf/volta/n、`/usr/local/bin`、`/opt/homebrew/bin`、`$HOME/.local/bin` 等），每候选 `[-x]` 才输出（`src/main/ssh/ssh-remote-node-probe-script.ts:8-69`）。
- **贯穿性约束**（同文件头注释 :5-7）："sshd's exec channel runs without the user's profile, so MISE_DATA_DIR / NVM_DIR set in ~/.zshrc are not in this environment. Reading the assignment out of the dotfiles is the only way to see a relocated data dir."——**exec channel 无用户 profile**，任何 clangd 探测同样受此约束（`~/.local/bin/clangd` 不在默认 PATH）。
- 两级解析：known-paths 盘点（每个候选无条件探测、缺目录静默）→ 登录 shell 兜底 `command -v node`（8s 超时防 conda 类交互配置挂死，`ssh-remote-node-resolution.ts:20-23,54-86,88-132`）。
- 往返预算被测试钉死："One inventory exec plus one candidate probe keeps SSH startup work bounded"（`src/main/ssh/ssh-remote-node-resolution.test.ts:86-87`）。

### 4.3 node/npm 版本探测（daemon 前，raw exec）——版本字符串探测的直接模板

- marker 分隔输出：`__ORCA_NODE_VERSION__` / `__ORCA_NPM_VERSION__` 哨兵行 + `--version` 输出；解析器在两个 marker 之间找首个 `^v?(\d+)(?:\.\d+){1,2}[-+…]` 行取 major（`src/main/ssh/ssh-remote-node-toolchain-probe.ts:5-18`（脚本）、`:37-48`（判定 + legacy 回退）、`:50-66`（marker 解析））。
- 版本门槛常量 `MIN_NODE_MAJOR = 18`（:5）；npm 探测镜像部署的 PATH-prepend 契约（:15-17）。Windows 变体走 PowerShell（:21-35）。

### 4.4 原生依赖健康探针（daemon 前 connect 路径，raw exec）——三值 verdict 语义先例

- 探针 = 远端 `node -e '<脚本>'`：`require("node-pty")`（Windows 还要 `loadNativeModule` conpty）+ `require("@parcel/watcher")`，成功打 `ORCA-NATIVE-DEPS-OK`，失败打 `ORCA-NATIVE-DEPS-MISSING:<names>`（`src/main/ssh/ssh-relay-deploy.ts:790-804`（常量与探针 JS）、`:846-875`（执行与判定））。
- 超时例外 240s（`src/main/ssh/ssh-relay-deploy-timing.ts:3` `NATIVE_DEPS_COMMAND_TIMEOUT_MS`；修复总预算 = 2×240s + 7min :8-13）。
- **verdict 三值语义**：ok / missing / unverifiable；"unverifiable（丢 exec channel / 输出不可解析）不得落入锁内重探、不得触发修复、不得中止连接"——历史上把任何失败都当"全缺"导致 rm -rf 健康节点（`src/main/ssh/ssh-relay-native-deps-probe-verdict.test.ts:1-3`（注释引 `docs/reference/ssh-execution-boundary.md`）、`:163-198`（恰好一次探针的断言））。词汇表本身来自执行边界文档：`live / unverifiable / exited` 三分、禁止合并（`docs/reference/ssh-execution-boundary.md:12-18`）。

### 4.5 agent CLI 存在性探测（daemon 后，relay RPC）——存在性探测的现成通道

- RPC `preflight.detectAgents`：客户端下发命令清单 `{id, cmd, requiredCommands?, unsupportedRuntimes?}`（协议自描述，relay 不必知道 agent 目录，`src/relay/preflight-handler.ts:54-94`）；daemon 侧对每命令做 PATH 查找并 `Promise.all` 并发、去重后回 `{agents: string[]}`。
- PATH 查找走**账号登录 shell**（`-lc`/`-ilc`，fish 有专用脚本；Windows 用 `where.exe`），输出以 `__ORCA_AGENT_PATH__` 前缀标记、要求绝对路径才算 installed；单查找 5s 超时、失败再试继承 PATH 的 `/bin/sh` 兜底（`preflight-handler.ts:35-37,118-124,171-240`）。设计注释明示动机（:118-121）："SSH exec channels give the relay a minimal environment without shell startup files sourced. Ask the user's configured shell so agent dirs added by zsh/bash/fish startup hooks match the remote terminal experience."
- 客户端入口：`src/main/preflight/agent-detection.ts:247-251`（`mux.request('preflight.detectAgents', …)`）、IPC 注册 `src/main/ipc/preflight.ts:40-47`（注释 :40-42 说明按远端选查找命令以兼容原生 Windows OpenSSH）。
- **能力限制事实**：只回 installed 布尔，**不回版本号**（`preflight-handler.ts:80-93` 返回结构）；旧 daemon 对该方法显式 `-32601`，调用方按缺省处理（`src/main/agent-hooks/wsl-hook-relay-manager.test.ts:191-194` 注释）。

### 4.6 通用远程执行 RPC（daemon 后）——跑任意命令的现成通道

- `agent.execNonInteractive` / `agent.cancelExec`（`src/relay/agent-exec-handler.ts:120-123`）：spawn 任意命令、默认 60s / 上限 5min 超时、4MiB 输出上限、Windows batch 注入防护、子进程树终止（:9-13 常量）。语义上可直接承载 `clangd --version` 类一次性探测（事实层面通道存在；选型不做）。

### 4.7 git：无远程版本探测先例

- 远端 git 操作不经 SSH exec 也无版本探针——daemon 的 GitHandler 直接以子进程跑 `git`（`src/relay/git-handler.ts:1,179-200`（execFile/spawn））。git 的存在性检查只在**本地** preflight（`preflight:check` → `git: { installed: true }`，`src/main/ipc/preflight-host-cli-status.test.ts:666-669`）。

### 4.8 模式归纳（事实层）

marker 哨兵（`__ORCA_*__` / `ORCA-NATIVE-DEPS-*`）+ 宽松行级正则解析 + 显式最低版本常量 + 三值 verdict（ok/missing/unverifiable）+ 「exec channel 无用户 profile」的登录 shell/登录文件补偿——是仓库四处探测共享的形状；版本字符串探测先例只在 daemon 前（raw exec）存在，daemon 后现有通道要么只回布尔（preflight），要么是通用执行（agentExec）。

## 5. relay 约束（探测通道的两端既有事实，不做选择）

- **`lsp.*` 方法族不存在**：origin/main 全仓 `onRequest('lsp…')` 零注册（`src/relay/` grep 无结果）；`src/` 下无任何 `clangd` 字样引用。即：无论探测走哪条通道，`lsp.*` 都是**新增** relay 方法面。
- **新增 relay 方法的能力协商先例**（#171 已核实，本次复核行号）：`pty.getCapabilities` 返回 feature 版本三元组（`src/relay/pty-handler.ts:1089` 注册）；`pty.openClient` 携带 `protocolVersion`，不匹配即拒（`src/relay/ssh-pty-consumer-session-adapter.ts:2,222`）。旧 daemon 对未知**请求**显式 `-32601`、对未知**通知**静默吞（#171 引 `dispatcher-rpc-routing.ts:70-78,177-189`）——探测类方法应设计为请求/应答。
- **探测通道候选的两端事实**（并列陈述，不选择）：
  - 通用远程 exec：daemon 后 `agent.execNonInteractive`（§4.6）现成，客户端零 relay 源码改动（不动 bundle-hash）；但输出上限 4MiB、超时 60s 默认，且每次探测起一个远端子进程。
  - `preflight.*` 扩展或新 `lsp.*` 方法：与 `preflight.detectAgents` 同型（请求/应答、daemon 本地查 PATH）；需改 relay bundle——按 #171 §1.7，relay 源码任何改动 → 新 bundle-hash → 新目录/新 socket → 旧 daemon 及其 PTY 全部 `unverifiable` 直到 grace 收割（`docs/reference/ssh-execution-boundary.md:47`）。即"探测通道新增 daemon 侧方法"的成本不是协商失败，而是**换目录+strand 旧会话**这一既有固定成本。
  - daemon 前探测（raw SSH exec）完全不碰 relay bundle——§4.1–4.4 全部先例在此层。
- **执行边界**（对"探谁的版本"的约束事实）：`docs/reference/ssh-execution-boundary.md:24`——"PTYs, agent CLIs → **remote**, children of the detached relay daemon, not of the ssh channel"；配合 #174（ADR 0001：daemon 侧 supervisor 拥有 clangd 进程与 initialize）。探测到的"版本"语义上应是**daemon 所在主机实际会被 spawn 的那个 clangd**——这与 §4.5 的登录 shell 查找口径（匹配用户终端体验）存在事实张力：exec channel 无 profile（§4.2 注释）+ 登录 shell 查找（§4.5）两套口径在仓库里并存，探测结果可能随口径不同而不同（事实陈述，不决策）。
- capability 协商（protocolVersion）先例已在 #171 §1.4 归纳为「方法级 protocolVersion + capabilities」模式；本票无新增事实。
