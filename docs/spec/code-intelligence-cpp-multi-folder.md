# Multi-folder C++ code intelligence — 实施规格(已锁定)

状态:**锁定**(wayfinder 地图 [Multi-folder C++ code intelligence](https://github.com/hyoteis/orca/issues/40) 全部决策票关闭;本文件为 #41–#50 决议汇编,是实施的唯一依据)。改动本文件前须先在 issue tracker 开票复议。

## 1. 目的地

快速多选多个分散文件夹 → 聚合为单个 code intelligence scope → clangd 单会话统一解析。覆盖本地与 SSH 执行主机(远程目录在远程聚合)。scope 覆盖同一执行主机上的任意目录;跨主机聚合明确排除。

## 2. 机制与目录布局(#41 #42 #43)

**机制:客户端合并 compile_commands + `--compile-commands-dir`。** clangd 严格单根(workspaceFolders 从未被读取),symlink 方案因四个未修上游 issue 被拒绝,Windows symlink 权限条款永久关闭。版本下限 clangd 11。WSL 实测(#42):跨文件夹 definition/hover 正常、返回真实绝对路径、统一索引 ~6s/40 文件、CDB 条目删除非破坏性、纯头文件模块经 preamble 传递索引。

目录布局——每 scope 一个独占稳定目录:

| | 路径 |
|---|---|
| 本地 | `<userData>/code-intelligence/cpp/scopes/<dirName>/` |
| SSH 远程 | `~/.orca/code-intelligence/cpp/scopes/<dirName>/` |

- `<dirName>` = `sha256(scopeId).slice(0,16)`(scope id 含 `:`,为 Windows 非法字符;确定性保证稳定)。content-hash 目录命名拒绝:成员变更会触发全量重建 + 孤儿目录。
- 目录内容:`compile_commands.json`(唯一合并产物,成员变更时原子重写)+ `.cache/clangd/index/`(clangd 自建统一索引)+ `build-N/`/`basic/`(生成中间产物)。
- spawn 时必须校验 `--compile-commands-dir` 目录存在,否则拒绝 spawn——缺失时 clangd 会静默降级为逐文件祖先搜索(M17),聚合失效。
- 合并规则(research #22 锁定):arguments-only、无未知键、每 TU 一种规范拼写、原子替换、确定性顺序、≤5s 惰性拾取;`file`/`directory` 的拼写必须与 `didOpen` URI 完全一致(双拼写是 M11/M12 与 FileMatchTrie 歧义的根因)。

## 3. 成员模型(#47 #48,词汇表 `src/shared/CONTEXT.md`)

单一 scope 形态:成员 = 单字符串路径,workspace 相对与主机绝对两形态**共存**(形态是路径字符串自身的 is-absolute 性质,不是标签)。「aggregate scope」概念不存在;纯相对 scope 是退化情形,同一代码路径。Python scope 换壳不换义(仍拒绝对路径)。

校验(`normalizeScopeRelativePath` 扩展):
- 绝对 = `posix.isAbsolute || win32.isAbsolute`;其余归一(反斜杠、前导 `./`、尾斜杠)照搬现有规则
- `..` 段对两种形态一律拒绝(consent 指纹依赖成员字符串)
- `~` 不展开——UI 必须传已展开绝对路径

去重与检测边界:
- 目录级等价去重:相对成员先 `resolve(workspaceRoot, member)` 再与绝对成员比较;win32 盘符形态大小写不敏感、posix 精确;等价保留首个(含 `visibleResults`)。**不做**父子去重(`isCodeIntelligenceResultVisible` 的最长匹配语义依赖嵌套)。
- 嵌套/重叠产生的重复 CDB 条目在合并时做文件级去重(同 `file` 键保留最后一条)兜底。
- cmake 合流(`coalesceCmakeBuildRoots`)与 `.gn` 向上搜索:绝对成员上界到文件系统根(cmake 合流拒绝在 fs 根);相对成员保持 workspaceRoot 界(零回归);跨形态不合流。
- basic include 发现(`collectConventionalIncludeDirectories`):对每个成员根各跑一次,并入全局 include 集。

零条目:单个成员零源文件允许(空分片 + 贡献 include 路径);全体成员零源文件 = setup 失败(需至少一个可编译成员传递 preamble)。

## 4. setup 生成(#47 #50)

`setupStatus` 保持标量 `mode: 'mixed'` + `state`(任一 basic → `limited`);任一成员生成失败 = 整个 setup 原子失败;每成员明细只进 `log`。

同输入跳过生成:稳定目录内 **setup manifest**(输入指纹:成员集、build roots、defines、标准等);指纹未变 → 跳过生成返回缓存状态。

### 4.1 本地执行

现有 `CodeIntelligenceCppSetup` 流程不变:探测 → (按需)安装 → 生成(basic/cmake/gn)→ 合并写盘。

### 4.2 SSH 执行主机(#50)

编排留在本地 main,两个执行原语换 SSH 通道,语义与本地对称:

- 命令执行 = 逐条 `SshConnection.exec`(POSIX 引号转义,沿用 `buildPosixLanguageServerCommand` 模式);**统一串行队列**(system ssh transport 无并发 exec 能力;检测阶段 `Promise.all` 远程退化串行)
- 文件操作 = exec 命令(`test`/`find`/`mkdir -p`/`cat`)+ `exec('cat > file')` 经 stdin 写大文件(无 ARG_MAX 限制;不依赖 SFTP——system ssh transport 下 SFTP 不可用);写回经 `cat > tmp && mv` 原子化
- CDB 分片读回本地合并(合并/去重逻辑保持单份纯 JS),结果写回远程稳定目录
- 平台范围:仅 POSIX(Linux/macOS/WSL);连接后 `uname` 检测,非 POSIX fail-fast。Windows 远程(winget + MSVC + PowerShell 全远程化)不做
- 工具缺失:照跑本地同款安装命令(darwin `brew install`、linux `sudo -n apt-get update && install -y`);`sudo -n` 失败 = 原子失败,fail message 附手动安装命令。Windows GN zip 下载特例不搬;不做用户级自建下载器
- 进度回传:一次性随 result 返回(累积 log),无流式 IPC;运行中对话框标明「正在 <host> 上运行」
- 超时:远程命令同本地 `COMMAND_TIMEOUT_MS`(10min)
- 断线 = 本次 setup 失败(报「连接中断,恢复后重试」),不追杀远端进程、不做恢复——重跑幂等(cmake 增量、CDB 原子重写)。取消 = 关 channel 即返回,不确认远端进程死亡
- `env` 参数:远程 runner 忽略(POSIX 无 MSVC 捕获,无调用点需要注入)
- `runtime:` host(远程 Orca server)不纳入;需要时另立票

## 5. 成员变更与删除生命周期(#43 #48)

**成员变更**:稳定目录内原子重写合并 CDB(仅这一个文件);clangd 不重启,变更只 enqueue 涉及文件,其余 shard 不动(M10 无全量重建);被移除成员的 shard 留盘、回加时直接复用。信任走既有 revision+consent 链,不为成员变更开例外。

**scope 删除**:属主执行主机上 best-effort 删除整个 scope 目录;主机离线则孤儿惰性无害(纯缓存),重连补删。

## 6. 与现有单 root scope 的共存迁移(#48)

scope 功能未发布(2026-08-22 进树,无 tag 包含),真实用户为零——**no-compat 基线**,settings 形态无兼容承诺。

- 迁移 = 惰性 normalize:读取时旧成员 `{relativePath}` 映射为 `{path}`,settings 顺带落盘,无版本门。一次性后果:指纹变 ⇒ consent 失效需重新授权,下次 setup 重跑
- 迁移时丢弃 `setupStatus`(旧 `compileCommandsDir` 指向注定被清扫的 hash 目录),UI 一次性回到 needs-setup,与 consent 失效同步
- 孤儿清扫:启动时 best-effort 删除 `code-intelligence/cpp/` 下、除 `tools/`(住着 provisioned GN 工具)外、名字不属于任何现存 scope 稳定目录的子目录;远程下次连接时同样处理,失败静默

## 7. 多选 UX(#44 概要)

变体 B(manage in place):树右键菜单三分状态规则(路径 == 成员 → Remove;严格子路径 → 禁用 ✓;否则 → Add),scope = 活动工作区 id 三元组,多选行全作用于;首次打开 dialog 预勾选;dialog 扁平可搜索清单 + 手输绝对路径(唯一入口,custom 徽标);面板行内可见性勾选 + 悬停移除(末成员 ✕ 禁用);re-consent = popover 横幅条 + `N folders changed since authorization` 摘要 + Reauthorize 主按钮;pending 时状态栏 segment amber ⚠。两路 UI 写同一个 scope。

## 8. CDB 条目删除后新打开文档的 fallback(#49 定义)

场景:某文件的 CDB 条目因成员移除被删除;该文档此后**新打开**(已打开文档与已建 shard 不受影响,#42 实测)。

**锁定行为:接受 clangd 原生 fallback,不注入补偿机制。**

- clangd 行为链(FixedDir 策略,#41 事实 S2/M6):lookup 在合并 CDB 中无该文件条目 → 无 compile command → clangd 内建 fallback command(无项目 include 路径)
- 后果:该文件自身诊断/补全降级(缺 include 解析);**跨文件导航(definition/references)仍可用**——走统一索引 shard(#42 已建;M10:shard 失效仅看文件内容,与 CDB 条目无关),不依赖该文件当前的 compile command
- 不做的:不写 `.clangd` config、不加 `CompileFlags.Add`、不为被移除成员保留条目——补偿会掩盖「成员已移除」的语义,且成员回加时条目自然恢复
- 验证方式:扩展 #42 WSL 原型脚本一个 case——建索引 → 从合并 CDB 删除某文件条目 → 重新原子替换 CDB → 等 >5s(惰性拾取)→ LSP `didOpen` 该文件 → 断言 definition 跳转仍工作、诊断降级。实施期手动跑一次并记录输出,不进 CI(clangd 行为,非 git 兼容面)

## 9. 失败模式

| 场景 | 行为 |
|---|---|
| 本地 scope 目录创建失败(只读/ACL) | setup 原子失败,`state: 'error'`,log 明示路径 |
| 远程 `sudo -n` 无免密 | setup 原子失败,message 附手动安装命令 |
| 远程 `~/.orca` 不可写 | 同上原子失败 |
| setup 前主机未连接 | fail「connect the host first」 |
| setup 中 SSH 断线 | 本次失败「连接中断,恢复后重试」;远端进程不追杀;重跑幂等 |
| scope 删除时主机离线 | 孤儿惰性无害,重连补删 |
| spawn 时 CDB 目录缺失 | 拒绝 spawn(不静默降级为祖先搜索) |
| 全体成员零源文件 | setup 失败,信息写明补救 |
| ~~链接创建失败~~ | 条款随 #43 拒绝 symlink 整体失效,删除 |

## 10. 明确出范围

Python language server 接入、跨执行主机聚合、Windows 本地 symlink 权限策略、`runtime:` host 的 setup、Windows SSH 主机的 setup。
