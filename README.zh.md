# dsh-google-drive-tools

[English](README.md) | 中文

一个 DeepSeek Harness 插件：把已经用 rclone FUSE 挂载到本地的 Google Drive 目录，变成 9 个模型可调用的文件工具——list、info、read、search、upload、download、mkdir、move、delete。

插件本身不实现 Google Drive API。它直接操作挂载目录，因此模型能看到的内容就是 rclone 在配置的 `root` 下暴露的内容，并且所有 Drive 路径都被限制在该根目录内。

## 用途

用 rclone 挂载的 Drive 目录在模型眼里就是普通本地文件，但直接给模型不受限的文件系统访问不可接受。本插件提供的是一个范围很窄、处处有界的接口：只允许一个根目录；每次读取、列目录、搜索都受字节数与条目数上限约束；拒绝读取二进制文件；删除必须显式提供 `confirm: true`。同时它给出稳定的 `GDRIVE_*` 错误码，让模型能区分是参数写错了还是挂载没就绪。

## 环境要求

- Node.js 22 或更新版本。
- DeepSeek Harness，以及一个可编辑的 profile（`dsh web` 使用 `web` profile）。
- rclone，且已配置好 Google Drive remote。
- Drive 已通过 FUSE 挂载到配置的 `root`（默认 `/workspace/GoogleDrive/files`）。插件不负责挂载、卸载、认证或重试：工具被调用时挂载必须已就绪。

## 快速开始

### 1. 挂载 Drive 目录（只需一次）

```bash
# 创建一个名为 "gdrive"、指向你的 Google Drive 账号的 remote。
rclone config

mkdir -p /workspace/GoogleDrive/files
rclone mount gdrive: /workspace/GoogleDrive/files \
  --vfs-cache-mode writes \
  --daemon
```

`--daemon` 在 Linux 与 macOS 上把挂载放到后台。生产环境请把同样的命令交给 systemd、launchd 或容器的 init 进程管理，让挂载在重启后仍然存在。用 `ls /workspace/GoogleDrive/files` 检查是否挂载成功。

### 2. 在 DSH profile 中注册插件

在 profile 的 patch 文件 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中加入一条 `insert`（`dsh web` 的 profile 通常就是 `web`）：

```yaml
- insert:
    - id: google-drive-tools
      name: dsh-google-drive-tools
      config:
        root: /workspace/GoogleDrive/files
```

所有配置项都是可选的；示例中的 `root` 只是重复了默认值。如果 profile 还无法解析 `dsh-google-drive-tools`，先把包装进 profile，例如：

```bash
dsh plugin --profile web add /path/to/dsh-google-drive-tools
```

如果你用 profile bundle 管理插件、而不是手写 patch，把 `dsh-google-drive-tools` 加进 profile 的 `dsh.profile.bundles` 列表即可。本包自带的 `cordis.patch.yml` 包含同样的 `insert` 行，不需要再复制一份。

### 3. 重启 profile

```bash
dsh web
```

或者你平时启动该 profile 的命令。没有开启配置 HMR 时，需要重启 profile 才会加载新增的插件行。

### 4. 让模型使用

例如对模型说：

> 列出 Google Drive 里 `notes/` 下的文件，然后读取 `notes/todo.md` 的前 50 行。

模型会调用：

```text
gdrive_list({ path: "notes" })
gdrive_read({ path: "notes/todo.md", offset: 1, limit_lines: 50 })
```

### 其他组合方式

如果你自己维护 cordis 组合、而不是通过 profile patch 加载，把同样的插件行加到函数插件所在的位置即可：

```yaml
- name: dsh-google-drive-tools
  config:
    root: /workspace/GoogleDrive/files
```

## 配置

所有配置项都是可选的，作为插件行的 `config` 映射传入。

| 配置项 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `root` | string | `/workspace/GoogleDrive/files` | 所有工具路径的解析根目录。指向 rclone FUSE 挂载点。 |
| `readMaxBytes` | number | `262144` | `gdrive_read` 可接受的文件最大字节数；更大的文件会被拒绝，并提示改用 `gdrive_download`。 |
| `listMaxEntries` | number | `500` | 单次 `gdrive_list` 返回的最大条目数。 |
| `searchMaxResults` | number | `100` | 单次 `gdrive_search` 返回的最大匹配数。 |
| `searchMaxFileBytes` | number | `1048576` | content 模式下，`gdrive_search` 会扫描的文件最大字节数。 |
| `searchMaxFiles` | number | `2000` | content 模式下，`gdrive_search` 最多访问的文件数。 |
| `writeMaxBytes` | number | `33554432` | 单次 `gdrive_upload` 可写入的最大字节数。 |
| `allowWrite` | boolean | `true` | 设为 `false` 时拒绝写入类操作：upload、mkdir、move，以及会写本地文件系统的 download。读取、列目录、搜索和 info 仍然可用。 |
| `allowDelete` | boolean | `true` | 设为 `false` 时拒绝 `gdrive_delete`。读取与下载不受影响。 |
| `downloadRoot` | string | `/workspace` | 本地侧路径的根目录：`gdrive_download` 写入其下，`gdrive_upload` 的 `source_path` 从其下读取。 |

这些上限都是单次调用的限制，不是存储配额。

## 工具

Drive 路径相对 `root` 解析并被限制在 `root` 内：既可以是相对于根目录的路径，也可以是位于根目录内的绝对路径。本地侧路径（download 的 `dest_path`、upload 的 `source_path`）同样相对 `downloadRoot` 解析并受其限制。失败时返回以 `GDRIVE_` 开头的稳定错误码。

name 模式下，`gdrive_search` 把 `query` 当作不区分大小写的子串匹配；如果 query 含有 `*` 或 `?`，则按 shell 风格通配符处理。两种模式都会跳过隐藏条目，content 模式还会跳过大于 `searchMaxFileBytes` 的文件。

| 工具 | 作用 | 参数 |
| --- | --- | --- |
| `gdrive_list` | 列出某个目录直接包含的文件与子目录，不递归。 | `path`（可选 string）：相对于 `root` 的目录，默认为根目录本身。`limit`（可选 number）：最大条目数，受 `listMaxEntries` 限制。`include_hidden`（可选 boolean）：是否包含以 `.` 开头的条目，默认 `false`。 |
| `gdrive_info` | 返回单个文件或目录的元数据：类型、大小、修改时间、路径。路径不存在时返回 `exists: false`，而不是报错。 | `path`（必填 string）：相对于 `root` 的路径。 |
| `gdrive_read` | 读取 UTF-8 文本文件，可只读一段行区间。 | `path`（必填 string）：相对于 `root` 的文件。`offset`（可选 number）：起始行号，**从 1 开始**，默认 `1`。`limit_lines`（可选 number）：最多返回的行数，默认 `2000`，并进一步受 `readMaxBytes` 字节上限截断。 |
| `gdrive_search` | 在某个目录下按文件名或文件内容搜索。 | `query`（必填 string）：要查找的文本。`path`（可选 string）：搜索起始目录，默认 `root`。`mode`（可选 `"name"` 或 `"content"`）：默认 `"name"`。`max_results`（可选 number）：受 `searchMaxResults` 限制。 |
| `gdrive_upload` | 向 Drive 写入一个文件：写入内联文本，或复制本地文件。父目录会自动创建。 | `path`（必填 string）：相对于 `root` 的目标路径。`content`（可选 string）：要写入的 UTF-8 文本。`source_path`（可选 string）：`downloadRoot` 下的本地源文件。`content` 与 `source_path` 必须且只能提供一个。`overwrite`（可选 boolean）：覆盖已存在的目标，默认 `false`。写入大小不得超过 `writeMaxBytes`。 |
| `gdrive_download` | 把 Drive 中的单个文件复制到本地文件系统。目标的父目录会自动创建。 | `path`（必填 string）：相对于 `root` 的文件。`dest_path`（可选 string）：`downloadRoot` 下的本地目标路径；默认为 `downloadRoot` 下的同名文件。`overwrite`（可选 boolean）：覆盖已存在的本地文件，默认 `false`。 |
| `gdrive_mkdir` | 创建目录。 | `path`（必填 string）：相对于 `root` 的目录。`recursive`（可选 boolean）：自动创建缺失的父目录，默认 `true`。 |
| `gdrive_move` | 在 Drive 内移动或重命名文件/目录。 | `from`（必填 string）：相对于 `root` 的源路径。`to`（必填 string）：相对于 `root` 的目标路径。`overwrite`（可选 boolean）：覆盖已存在的目标，默认 `false`。 |
| `gdrive_delete` | 永久删除文件或目录。挂载没有回收站，删除不可恢复。 | `path`（必填 string）：相对于 `root` 的路径。`recursive`（可选 boolean）：删除非空目录时必须为真；默认 `false`。`confirm`（必填 boolean）：必须严格为 `true`，否则调用被拒绝。 |

`gdrive_read` 只读文本。它会拒绝二进制文件和大于 `readMaxBytes` 的文件，这两种情况请改用 `gdrive_download`。`gdrive_upload` 的 `content` 用于文本；复制二进制文件请用 `source_path`。

## 错误

所有失败都带以 `GDRIVE_` 开头的稳定错误码，让模型能区分自己的参数错误和挂载不可用。示例：

| 错误码 | 含义 |
| --- | --- |
| `GDRIVE_INVALID_PATH` | 路径格式非法、包含 `..`、解析后超出根目录，或通过符号链接逃逸。 |
| `GDRIVE_ROOT_MISSING` | 配置的 `root`（或 `downloadRoot`）不存在、不是目录，或挂载尚未就绪。 |
| `GDRIVE_EXISTS` | 目标已存在，且 `overwrite` 未设为 `true`。 |
| `GDRIVE_CONFIRM_REQUIRED` | 调用 `gdrive_delete` 时没有提供 `confirm: true`。 |
| `GDRIVE_BINARY` | `gdrive_read` 检测到二进制内容，应改用 `gdrive_download`。 |

其他错误码包括 `GDRIVE_NOT_FOUND`、`GDRIVE_NOT_A_FILE`、`GDRIVE_NOT_A_DIRECTORY`、`GDRIVE_TOO_LARGE`、`GDRIVE_NOT_EMPTY`、`GDRIVE_WRITE_DISABLED`、`GDRIVE_DELETE_DISABLED`、`GDRIVE_INVALID_ARGS`、`GDRIVE_IO`。

## 安全模型

- **单一根目录。** 所有 Drive 路径都相对 `root` 解析，解析 `..` 和符号链接后必须仍在 `root` 内；越界路径直接拒绝，而不是截断或修正。
- **单一本地根目录。** 本地侧路径相对 `downloadRoot` 解析，并受同样的越界限制。
- **删除必须显式确认，且不可恢复。** `gdrive_delete` 只有在 `confirm` 严格为 `true` 时才执行；删除非空目录还需要 `recursive: true`。挂载没有回收站，确认后的删除无法撤销。
- **不静默覆盖。** upload、download、move 在目标已存在时都会拒绝，除非显式设置 `overwrite: true`。
- **I/O 有界。** 读取、列目录、搜索、写入都受配置上限约束；二进制读取被拒绝并提示改用 `gdrive_download`。
- **写开关。** `allowWrite: false` 禁用 upload、mkdir、move 与 download（后者会写本地磁盘）；`allowDelete: false` 禁用 delete。两者由插件强制执行，与挂载本身的权限无关。

这些防护限制的是插件接受什么，而不是挂载能触达什么：DSH 进程用户在文件系统其他位置仍可访问的内容，依然由 DSH 自身的文件策略管辖。

## 已知限制

- **依赖已有的 rclone FUSE 挂载。** 插件不是 Google Drive API 客户端：没有 OAuth 登录、没有共享与权限管理、没有版本历史、也没有 Drive 原生搜索。所有访问都经过挂载所暴露的内容。
- **搜索是本地且有界的。** 它在 `path` 下遍历挂载树，受 `searchMaxFiles` 与 `searchMaxFileBytes` 限制；不使用 Google 服务端搜索，超出限制的文件可能被漏掉。
- **吞吐受 rclone 与 FUSE 影响。** 延迟、列目录速度和大文件传输主要取决于挂载与网络。写入经过 rclone 的 VFS 缓存；若缓存模式不合适，写入可能很慢甚至失败。
- **挂载必须就绪。** 挂载缺失、为空或返回 I/O 错误时，工具返回 `GDRIVE_*` 错误，不会回退到其他路径。挂载是否就绪由运维方负责。
- **没有事务与锁。** 没有原子化的多步操作，也没有跨会话锁；并发删除文件或挂载中断都可能让一次调用中途失败。
- **上限按调用计。** 这些上限不预留配额，修改后会立即改变模型可读写的范围。

## 仓库结构

```text
dsh-google-drive-tools/
├── index.js            # DSH plugin entry: name / inject / apply
├── src/
│   ├── config.js       # defaults + validation
│   ├── errors.js       # GdriveError with stable codes
│   ├── ops.js          # filesystem operations
│   ├── paths.js        # path confinement, mime, formatting
│   └── tools.js        # 9 tool definitions (JSON Schema + render)
├── test/
│   ├── helpers.js
│   ├── config.test.js
│   ├── ops.test.js
│   ├── paths.test.js
│   └── tools.test.js
├── scripts/publish-github.sh
├── cordis.patch.yml
├── package.json
└── .github/workflows/ci.yml
```

`cordis.patch.yml` 是随包发布的 bundle patch，用于插入插件行。文档文件：`README.md`、`README.zh.md`、`CONTRIBUTING.md`、`LICENSE`。

## 插件契约

- 包名 `dsh-google-drive-tools`；ESM；入口 `index.js`；零运行时依赖。
- 导出 `name = "google-drive-tools"`、`inject = ["tools"]`、`apply(ctx, config)`。
- `apply` 校验可选配置，然后在 `ctx.tools` 上注册 9 个 `gdrive_*` 工具；销毁时注销它们。
- 每次调用都会解析并约束路径，在挂载上执行文件系统操作，返回结构化结果或抛出带错误码的 `GDRIVE_*` 错误。

## 开发

```bash
node --test test/*.test.js
```

无需安装依赖：本包没有运行时依赖，也没有开发依赖。CI 在 `ubuntu-latest` 上用 Node.js 22.x 与 24.x 对每次 push 和 pull request 运行同一条命令。

## 发布到 GitHub

`scripts/publish-github.sh` 会在仓库不存在时创建它，并推送当前分支，且不会把 token 写入 `.git/config`：

```bash
GH_TOKEN=github_pat_... GH_OWNER=your-login scripts/publish-github.sh dsh-google-drive-tools public
```

## 许可证

[MIT](LICENSE)
