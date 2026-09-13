# nvim-lspconfig 数据形态盘点：语言目录挖矿的事实输入（#186）

- Ticket: https://github.com/hyoteis/orca/issues/186 （地图：#170）
- 调查日期：2026-09-13。除特别标注外，全部结论基于 neovim/nvim-lspconfig **tag v2.11.0**（2026-07-21 发布，commit `b89138d`）源码；出处格式 `文件:行号`（相对 nvim-lspconfig 仓库根）。Neovim 核心行为引用标注 v0.11.3。统计用一次性脚本（括号深度状态机扫描 `return {…}` 顶层键）+ grep 逐字段交叉验证，两法结果完全一致。
- 本文档只陈述事实与数据样本，**不做决策**。

## TL;DR

1. **当前 release 的权威布局是仓库根 `lsp/*.lua`**（406 个文件 = 402 个真实配置 + 4 个改名 alias 桩），不是票面猜的 `lua/lsp/config/*.lua`（不存在）。旧布局 `lua/lspconfig/configs/*.lua`（360 条）整目录标记 DEPRECATED，仅为 Nvim ≤0.10 保留，每个文件头部有删除警告（`lua/lspconfig/configs/clangd.lua:1-9`）。
2. 新布局是**纯数据表 + 可选 Lua 闭包钩子**：`return { cmd=…, filetypes=…, root_markers=…, settings=… }`，类型即 `vim.lsp.Config`。核心字段的静态化率极高：**filetypes 100%、root_markers 98.8%、cmd 93.5%、init_options/settings/workspace_required 100%** 为可直接无损提取的静态数据。
3. root 探测已数据化：**83.6% 条目用 `root_markers` 纯列表**，仅 **14.9%（60 条）残留 `root_dir` 函数**（旧布局是 53.3% 函数式，零 markers）；残留函数按复杂度分三层，顶层是 monorepo/包管理器感知逻辑（eslint 1628 字符、rust_analyzer 甚至子进程调 `cargo metadata`）。
4. 函数型 `cmd` 仅 **24/398（6.0%）**，其中 16 条是同一个可复制的模板：探测 `root_dir/node_modules/.bin/<bin>`，可执行则用之，否则回退全局命令。
5. **clangd 条目全静态**（`cmd={'clangd'}`、7 filetypes、7 项 root_markers、无 root_dir/init_options/settings），`.git` 被收编为 root_markers 末位（最低优先级）；对 compile_commands.json **零处理**——docs 只建议 symlink，不传 `--compile-commands-dir` 等任何旗标。
6. 上游近 12 个月 7 个 release（2026 年 2 月起月度节奏），最新 v2.11.0 落后 master 7 周；tag 可 `--depth 1` 浅取。Apache-2.0、**无 NOTICE 文件** → §4(d) 不触发，最小义务 = 许可证副本 + 修改声明 + 归属标注。
7. 未发现现成的第三方「lspconfig→JSON catalog」提取器；最接近的是第一方 `scripts/docgen.lua`（数据→markdown，CI 自动再生成）与 mason-lspconfig 的两份手工名字映射表。

## 0. 分析对象与布局

- 分析对象：tag **v2.11.0**（2026-07-21 发布；`git log -1` = `b89138d9af0a96e6048e202a15765fc6b6416bd4`）。对照 master HEAD `ac9d2f7c`（2026-09-10），两者布局相同。
- **新布局**：仓库根 **`lsp/*.lua`**（runtimepath 约定，配 Nvim ≥0.11 的 `vim.lsp.enable()`）。共 406 个 `.lua`：
  - 402 个以 `---@type vim.lsp.Config` + `return { … }` 返回配置表（统计分母）；
  - 4 个是改名 alias 桩：`pony_language_server`→`pony_lsp`、`volar`→`vue_ls`、`vscoqtop`→`vsrocq`（`return vim.tbl_extend('force', vim.lsp.config.<new>, { on_init = … vim.deprecate(…) })`，见 `lsp/pony_language_server.lua`、`lsp/volar.lua:6`）及 `systemd_ls`→`systemd_lsp` 包装。
- **旧布局**：`lua/lspconfig/configs/*.lua`，360 条，每文件头部横幅自述 "This config is DEPRECATED … will be DELETED … only to support Nvim 0.10 or older"（`lua/lspconfig/configs/clangd.lua:1-9`）。
- 票面写的「新布局 `lua/lsp/config/*.lua`」在仓库中不存在；实际新布局是根目录 `lsp/`。
- 条目形态：`lsp/<server>.lua` = brief 注释块（`---@brief`）+ 可选文件级局部函数/表 + `return {}` 数据表。例：`lsp/pyright.lua`（`local function set_python_path` 在上，数据表在下）。

## 1. 字段频率全景（分母 = 402 条真实配置）

统计方法：状态机扫描器（跳过字符串/长括号字符串/注释，`{}` 深度 + `()` 深度跟踪，仅取括号深度 0 的顶层键）；对每个关键字段用 `grep -E "^  <key> = "` 交叉验证，计数一致（`on_attach` grep 25 vs 扫描 24：1 处是嵌套表内出现，扫描器只计顶层）。

| 字段 | 条目数 | 占比 | 形态分解 |
|---|---|---|---|
| `cmd` | 398 | 99.0% | 静态字面量表 370（92.0%）；**函数 24（6.0%）**；文件头 local 变量/表达式 4（1.0%） |
| `filetypes` | 391 | 97.3% | 字面量表 390；local 表引用 1（`lsp/ltex.lua:77`） |
| `root_markers` | 336 | 83.6% | 静态字面量表 330；Nvim 版本条件式 4；local 表引用 2 |
| `root_dir` | 60 | 14.9% | 函数 58；`nil` 1（`lsp_ai`）；`vim.fs.root(0, …)` 表达式 1（`lsp/vectorcode_server.lua`） |
| `settings` | 83 | 20.6% | 全部静态表 |
| `init_options` | 52 | 12.9% | 全部静态表 |
| `cmd_env` | 5 | 1.2% | 静态表 4；条件表达式 1（venv→PYTHONPATH） |
| `workspace_required` | 16 | 4.0% | 纯 bool：true 12 / false 4 |
| `capabilities` | 16 | 4.0% | 全部静态表 |
| `on_attach` | 24 | 6.0% | 全部函数（UI 命令注册等，非数据） |
| `before_init` / `on_init` / `get_language_id` / `handlers` / `reuse_client` / `offset_encoding` | 7 / 6 / 8 / 5 / 3 / 2 | ≤2% | 全函数/非提取目标 |
| `single_file_support` | **0** | 0% | 新布局已废除；旧布局 360 条中 203 条（56.4%）仍有 |

静态化率（「可直接无损提取」= 字面量表 + 指向文件头静态 local 表的引用）：

- `filetypes`：391/391 = **100%**
- `root_markers`：332/336 = **98.8%**（例外 4 条为 `vim.fn.has('nvim-0.11.3') == 1 and {嵌套组} or {平铺}` 的版本分支：`lsp/emmylua_ls.lua:72`、`lsp/jdtls.lua:99`、`lsp/lua_ls.lua:84`、`lsp/ocamllsp.lua:80`；另有 julials/kotlin_language_server 的 local 表引用，数据本身静态）
- `cmd`：372/398 = **93.5%**（370 字面量 + `lsp/julials.lua:128`、`lsp/phan.lua:22` 的 local 静态表；非静态 26 条 = 24 函数 + `lsp/gdscript.lua:12` 的 `vim.lsp.rpc.connect`（连接已存在的 TCP 服务器）+ `lsp/tblgen_lsp_server.lua:25` 的 `get_command()`（探测 tablegen_compile_commands.yml 拼 `--tablegen-compilation-database` 参数））
- `init_options` 52/52、`settings` 83/83、`workspace_required` 16/16 = **100%**；`cmd_env` 4/5 = 80%

其他事实：

- `workspace_required = true` 的 12 条：ast_grep, biome, ccls, eslint, glint, oxfmt, oxlint, phpactor, postgres_lsp, tailwindcss, unocss, zk；`= false` 的 4 条：emmylua_ls, hare_lsp, vimdoc_ls, zls。
- **`root_markers` 与 `root_dir` 并存的有 11 条**（angularls, biome, css_variables, denols, eslint, oxfmt, oxlint, stylelint_lsp, ts_ls, tsgo, vtsls）。按 Neovim 核心语义 `root_markers` "Unused if `root_dir` is defined"（neovim v0.11.3 `runtime/lua/vim/lsp.lua:298`），这 11 条的 markers 在原生 Nvim 下被函数遮蔽。
- 顶层还有少量非常规键（`name`、`flags` 等）各 ≤5 条，无 catalog 级意义。

## 2. 函数型 `cmd`（24/398 = 6.0%）

24 条清单：angularls, apex_ls, astro, biome, csharp_ls, cssls, eslint, fallow, flow, glint, hhvm, html, jdtls, jsonls, oxfmt, oxlint, powershell_es, rome, ruby_lsp, svelte, tailwindcss, ts_ls, tsgo, yamlls。

**主形态（16 条）——node 项目本地二进制探测**（astro/biome/cssls/eslint/fallow/glint/html/jsonls/oxfmt/oxlint/rome/svelte/tailwindcss/ts_ls/tsgo/yamlls；全仓库 `node_modules/.bin` 出现于 18 文件、`vim.fn.executable` 20 文件）。模板（`lsp/biome.lua`）：

```lua
cmd = function(dispatchers, config)
  local cmd = 'biome'
  if (config or {}).root_dir then
    local local_cmd = vim.fs.joinpath(config.root_dir, 'node_modules/.bin', cmd)
    if vim.fn.executable(local_cmd) == 1 then
      cmd = local_cmd
    end
  end
  return vim.lsp.rpc.start({ cmd, 'lsp-proxy' }, dispatchers)
end
```

归纳出的逻辑形态（4 类）：

1. **可执行探测**：上例；三级 fallback 版 `lsp/flow.lua`（全局 `flow` → 项目内 `node_modules/.bin/flow` → `npx --no-install flow`）。
2. **cwd 绑定**：`lsp/csharp_ls.lua`、`lsp/hhvm.lua`、`lsp/ruby_lsp.lua`——`vim.lsp.rpc.start(cmd, dispatchers, { cwd = config.root_dir })`（服务端必须以项目根为 cwd 启动）。
3. **workspace/参数拼装**：`lsp/jdtls.lua`（`-data <workspace_dir>/<项目名>` + `get_jdtls_jvm_args()`）；`lsp/apex_ls.lua`（`vim.env.JAVA_HOME` 平台分支 + 按用户 config 追加 `-Xmx` 等旗标）。
4. **环境/脚本启动**：`lsp/powershell_es.lua`（`pwsh -NoLogo -NoProfile -Command <Start-EditorServices.ps1 格式串>`，路径来自 `stdpath('cache')`/`bundle_path`）；`lsp/angularls.lua`（扫描全部 node_modules 拼 `--tsProbeLocations`/`--ngProbeLocations`，读 `@angular/core` 版本）。

共同点：全部以 `vim.lsp.rpc.start(…)` 收尾自建启动器；没有一条做「服务器自身装没装」的预检失败处理（探测失败就静默用全局命令名，交给 spawn 报错）。

## 3. root 探测：markers 数据化覆盖度 vs root_dir 函数残留

- **markers 语义（Neovim 核心，v0.11.3 `runtime/lua/vim/lsp.lua:297-318`）**：`root_markers? (string|string[])[]`——列表顺序即优先级，嵌套列表表示"等优先级组"（0.11.3+）；对每项从 buffer 文件向上搜索，命中目录即 workspace root；`root_dir` 存在时 markers 不生效；派生实现就是 `lsp.start` 里一行 `config.root_dir = vim.fs.root(bufnr, opts._root_markers)`（`runtime/lua/vim/lsp.lua:708-712`）。
- **版本约束**：等优先级嵌套组依赖 Nvim 0.11.3；lspconfig 因此在 4 条 markers + 6 条 root_dir 函数里写 `vim.fn.has('nvim-0.11.3')` 分支（上节清单 + `lsp/biome.lua`、`lsp/denols.lua`、`lsp/eslint.lua` 等；CONTRIBUTING 明文要求这种双写兼容：`CONTRIBUTING.md:110-131`）。
- **覆盖度**：`root_markers` 336/402（83.6%）；`root_dir` 残留 60/402（14.9%）。对比旧布局（360 条）：`root_dir` 函数 192（53.3%）、`root_markers` **0**——数据化迁移就是 v2.x 的主线。
- 残留函数复杂度分层（长度/or 链长/root_pattern 次数来自扫描器）：
  - **A. 薄包装（≈16 条，≤200 字符，单次 `util.root_pattern`）**：ada_ls, agda_ls, arduino_language_server, autotools_ls, fsautocomplete, fsharp_language_server, gitlab_ci_ls, graphql, hls, idris2_lsp, msbuild_project_tools_server, nomad_lsp, ols, pasls, pico8_ls, unison。例（`lsp/ada_ls.lua`）：`on_dir(util.root_pattern('Makefile', '.git', 'alire.toml', '*.gpr', '*.adc')(fname))`——**纯 marker 列表，只是还没搬进数据字段**。
  - **B. 多 pattern or-链（中复杂度）**：csharp_ls（`*.sln or *.slnx or *.csproj`）、omnisharp（5 组）、sourcekit（3 组 + Package.swift 特判）、regal/regols/nim_langserver/nimls/termux_language_server 等。
  - **C. monorepo/包管理器感知（500–1630 字符）**：eslint（1628）、stylelint_lsp（1572）、biome（1557）、ts_ls/tsgo/vtsls（1314–1333，or 链 5 层）、rust_analyzer（1247）、denols（1080）、roslyn_ls（993）、tailwindcss（964）、oxfmt（838）、zizmor（584）、css_variables（522）、elixirls/expert（392，umbrella：`vim.fs.find('mix.exs', {upward=true, limit=2})` 取最高层）。两个代表样本：
    - `lsp/denols.lua`：分别求 `deno_root`（deno.json）/`deno_lock_root`（deno.lock）/`project_root`（锁文件组），用路径长度比较决定挂载点——**deno 项目优先于 node 项目**的特判。
    - `lsp/rust_analyzer.lua`：`is_library(fname)` 复用检测 → `Cargo.toml` → 子进程 `cargo metadata --no-deps` 解析 JSON 取 `workspace_root` → fallback `rust-project.json` → `.git` 目录名。**唯一会为了找 root 起子进程的条目**。
  - 附带发现：eslint/ts_ls/vtsls 家族的 root_dir 兼任 **attach 门控**（先查 buffer 目录树里有无本工具配置文件，无则 `on_dir(nil)` 不激活，如 eslint 的 `is_buffer_using_eslint`）——root_dir 函数在 Nvim 语义里本来就是"可决定不激活"的钩子（`runtime/lua/vim/lsp.lua:292-295`）。

## 4. clangd 条目（`lsp/clangd.lua`，v2.11.0）

完整数据字段逐字引用（66–78 行）：

```lua
  cmd = { 'clangd' },
  filetypes = { 'c', 'c.doxygen', 'cpp', 'cpp.doxygen', 'objc', 'objcpp', 'cuda' },
  root_markers = {
    '.clangd',
    '.clang-tidy',
    '.clang-format',
    'compile_commands.json',
    'compile_flags.txt',
    'configure.ac', -- AutoTools
    '.git',
  },
```

其余字段：`get_language_id`（objc→objective-c、objcpp→objective-cpp、cuda→cuda-cpp 映射，:77）；`capabilities = { textDocument.completion.editsNearCursor = true, offsetEncoding = {'utf-8','utf-16'} }`（:81）；`on_init` 从 InitializeResult 回读 `offsetEncoding`（:90）；`on_attach` 注册两个 buffer 命令 `LspClangdSwitchSourceHeader`（`textDocument/switchSourceHeader` 扩展）与 `LspClangdShowSymbolInfo`（`textDocument/symbolInfo`）（:95 起，函数体在文件头部）。

事实要点：

- **无 `root_dir`、无 `init_options`、无 `settings`、无 `cmd_env`**——clangd 条目在 markers 之后完全静态。
- **`.git` 被收编进 root_markers 末位**：旧布局是 `root_pattern(6 项)(fname) or vim.fs.dirname(vim.fs.find('.git', …))`（`lua/lspconfig/configs/clangd.lua:61-70`）+ `single_file_support = true`；新布局把 git fallback 变成列表第 7 项（最低优先级，`vim.fs.root` 找不到前 6 项时命中它），语义由核心的 markers 算法承载。
- **compile_commands.json 的处理 = 没有**：lspconfig 不传 `--compile-commands-dir`、不设任何 settings/init_options；docs（文件头 `---@brief` 块）只做两件事——(a) 若 compile_commands.json 在 build 目录，建议 symlink 到源码根；(b) 给出 clangd 官方 JSON Compilation Database 文档链接。**找编译数据库完全是 clangd 自身行为**，lspconfig 的参与仅限于 `compile_commands.json` 作为 root marker（该文件所在目录可直接成为 workspace root）。
- 默认 cmd 无任何旗标（无 `--background-index`、`--clang-tidy`、`--offset-encoding` 等）；offsetEncoding 靠 capabilities 协商 + on_init 回读，不是命令行。

## 5. 上游节奏、pin 与许可

- **近 12 个月 release（GitHub Releases API）**：v2.5.0（2025-09-18）→ v2.6.0（2026-02-12，**4.8 个月空窗**）→ v2.7.0（2026-03-12）→ v2.8.0（2026-04-10）→ v2.9.0（2026-05-07）→ v2.10.0（2026-06-07）→ v2.11.0（2026-07-21）。2026 年 2 月起月度节奏，共 7 个/12 个月。
- master HEAD（2026-09-10）领先最新 tag 约 7 周，存在未发布变更；tag 支持浅取（`git fetch --depth 1 origin tag v2.11.0` 实测可用）。上游自己维护「数据→生成物」管线并在 CI 里强制可再生：`scripts/docgen.lua` 生成 `doc/configs.md`/`doc/configs.txt`，`.github/workflows/docgen.yml:31` 自动 `git add` 提交。
- pin 相关事实（供决策票，非本文建议）：release tag 是稳定锚点且月度出现；月度节奏意味着「重生成频率」上限约每月一次；master 无发布保障。
- **许可**：`LICENSE.md` 为 Apache-2.0 全文；仓库**无 NOTICE 文件**（根目录无，`git ls-files` 无）；LICENSE.md 到 "END OF TERMS AND CONDITIONS" 即止，未附填写式 appendix/版权人。
- Apache-2.0 §4 义务对照：§4(a) 向再分发对象提供许可证副本；§4(b) 显著声明对原作品的修改；§4(c) 保留原有版权/归属/免责声明；**§4(d)（NOTICE 义务）因原作品不含 NOTICE 文件而不触发**。对「提取数据生成 catalog」的最小满足形式即：构建产物/仓库内携带 Apache-2.0 文本副本 + 一处归属声明（"config data derived from neovim/nvim-lspconfig"）+ 修改声明（如 catalog 生成脚本 README/注释），无强制 NOTICE 追加义务。

## 6. 旁证：既有的 lspconfig 数据提取/移植

- **第一方（最直接的先例）**：`scripts/docgen.lua` + CI（`.github/workflows/docgen.yml`）把 `lsp/*.lua` 全量提取为 `doc/configs.md`/`doc/configs.txt` 并自动提交——「lspconfig 配置数据 → 生成物」的官方管线，证明该数据可机读再生成。
- **第一方**：`scripts/gen_json_schemas.lua` 维护 server→上游 schema URL 索引（如 `clangd = vscode-clangd/package.json`，:14），拉取各服务器 VSCode 扩展 package.json 生成 `lua/lspconfig/types/lsp/*.lua` 的 settings 类型标注（settings 的 JSON schema 化；上游 issue #4343）。
- **mason-org/mason-lspconfig.nvim**：`lua/mason-lspconfig/mappings.lua`（lspconfig 名 ↔ mason 包名）与 `lua/mason-lspconfig/filetype_mappings.lua`（filetype → server 名）——手工维护的 Lua 派生映射表，非 JSON、不含 cmd/root 数据。https://github.com/mason-org/mason-lspconfig.nvim
- **其他编辑器均为独立维护的配置表，非 lspconfig 派生**：Helix `languages.toml`（https://github.com/helix-editor/helix，https://docs.helix-editor.com/languages.html）；Zed 语言配置内嵌 Rust crate；Emacs eglot 的 `eglot-server-programs` 为 elisp 列表。未发现 helix/lapce/zed 从 lspconfig 移植数据的对照表。
- **结论性事实**：GitHub 仓库/代码/issue 搜索（"lspconfig json/extract/convert/scrape"）未发现任何现成的「lspconfig → JSON catalog」第三方提取器；mason-lspconfig 的两份映射表是最接近的派生数据先例，docgen 是最接近的"全量提取"先例。

---

### 附：数据文件指针（复现）

- 分析快照：neovim/nvim-lspconfig tag v2.11.0（commit b89138d，2026-07-21）；对照 master ac9d2f7（2026-09-10）。
- 关键路径：`lsp/*.lua`（新数据）、`lua/lspconfig/configs/*.lua`（弃用）、`scripts/docgen.lua`、`scripts/gen_json_schemas.lua`、`.github/workflows/docgen.yml`、`CONTRIBUTING.md`、`LICENSE.md`。
- Neovim 语义源：v0.11.3 `runtime/lua/vim/lsp.lua`（root_markers 文档 :297-318、start 派生 :708-712、root_dir 钩子语义 :292-295）。
