# dsh-google-drive-tools

English | [中文](README.zh.md)

A DeepSeek Harness plugin that exposes a Google Drive folder already mounted locally with rclone FUSE as nine model-callable file tools: list, info, read, search, upload, download, mkdir, move, and delete.

The plugin does not implement Google Drive's API. It works on the mounted directory, so the model sees exactly what rclone exposes under the configured `root`, and every Drive path is confined to that root.

## Why it exists

A Drive folder mounted with rclone behaves like ordinary local files, but handing a model unrestricted filesystem access is not acceptable. This plugin adds a narrow, bounded interface instead: one root directory, byte and entry caps on every read/listing/search, refusal to read binaries, and a hard `confirm: true` requirement for deletion. It also gives the model stable `GDRIVE_*` error codes so it can tell a bad argument apart from an unready mount.

## Requirements

- Node.js 22 or newer.
- DeepSeek Harness with a profile you can edit (`dsh web` uses the `web` profile).
- rclone, with a Google Drive remote configured.
- The Drive mounted with FUSE at the configured `root` (default `/workspace/GoogleDrive/files`). The plugin does not mount, unmount, authenticate, or retry: the mount must be ready when a tool is called.

## Quick start

### 1. Mount the Drive folder (once)

```bash
# Create a remote named "gdrive" pointing at your Google Drive account.
rclone config

mkdir -p /workspace/GoogleDrive/files
rclone mount gdrive: /workspace/GoogleDrive/files \
  --vfs-cache-mode writes \
  --daemon
```

`--daemon` puts the mount in the background on Linux and macOS. In production, run the same command under systemd, launchd, or your container's init so the mount survives restarts. Check it with `ls /workspace/GoogleDrive/files`.

### 2. Register the plugin in the DSH profile

Add an `insert` row to the profile's patch file, `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (for `dsh web`, the profile is usually `web`):

```yaml
- insert:
    - id: google-drive-tools
      name: dsh-google-drive-tools
      config:
        root: /workspace/GoogleDrive/files
```

All configuration keys are optional; the example only restates the default `root`. If the profile cannot already resolve `dsh-google-drive-tools`, install the package into the profile first, for example:

```bash
dsh plugin --profile web add /path/to/dsh-google-drive-tools
```

If you manage profile bundles instead of editing the patch file, add `dsh-google-drive-tools` to the profile's `dsh.profile.bundles` list. The package ships the same `insert` row in its own `cordis.patch.yml`, so the plugin is mounted without copying the row.

### 3. Restart the profile

```bash
dsh web
```

or the command your profile normally starts with. Without configuration HMR, a profile restart is what loads the new row.

### 4. Ask the model

A prompt such as:

> List `notes/` in Google Drive and read the first 50 lines of `notes/todo.md`.

makes the model call:

```text
gdrive_list({ path: "notes" })
gdrive_read({ path: "notes/todo.md", offset: 1, limit_lines: 50 })
```

### Other compositions

If you maintain your own cordis composition instead of a profile patch, add the same row wherever function plugins are listed:

```yaml
- name: dsh-google-drive-tools
  config:
    root: /workspace/GoogleDrive/files
```

## Configuration

Every option is optional and is passed as the `config` mapping of the plugin row.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | `/workspace/GoogleDrive/files` | Directory every tool path is resolved under. Point this at the rclone FUSE mount. |
| `readMaxBytes` | number | `262144` | Maximum size of a file `gdrive_read` will accept; larger files are rejected with a hint to use `gdrive_download`. |
| `listMaxEntries` | number | `500` | Maximum entries returned by one `gdrive_list` call. |
| `searchMaxResults` | number | `100` | Maximum matches returned by one `gdrive_search` call. |
| `searchMaxFileBytes` | number | `1048576` | In content mode, maximum size of a file that `gdrive_search` will scan. |
| `searchMaxFiles` | number | `2000` | In content mode, maximum number of files `gdrive_search` will visit. |
| `writeMaxBytes` | number | `33554432` | Maximum bytes one `gdrive_upload` may write. |
| `allowWrite` | boolean | `true` | Set `false` to reject write operations: upload, mkdir, move, and download (which writes to the local filesystem). Reads, listings, searches, and info still work. |
| `allowDelete` | boolean | `true` | Set `false` to reject `gdrive_delete`. Downloads and reads are unaffected. |
| `downloadRoot` | string | `/workspace` | Root for local-side paths: `gdrive_download` writes under it and `gdrive_upload` reads `source_path` under it. |

The caps are per-call limits, not storage quotas.

## Tools

Drive paths are resolved against `root` and confined to it: a path may be relative to the root or an absolute path inside it. Local-side paths (`dest_path` for download, `source_path` for upload) are resolved under `downloadRoot` the same way. Failures are reported with a stable code starting with `GDRIVE_`.

In name mode, `gdrive_search` matches `query` as a case-insensitive substring; if the query contains `*` or `?`, it is treated as a shell-style glob instead. Hidden entries are skipped in both modes, and content mode skips files larger than `searchMaxFileBytes`.

| Tool | What it does | Parameters |
| --- | --- | --- |
| `gdrive_list` | List the files and directories directly inside one directory. Not recursive. | `path` (optional string): directory relative to `root`; defaults to the root itself. `limit` (optional number): maximum entries; capped by `listMaxEntries`. `include_hidden` (optional boolean): include entries whose names start with `.`; defaults to `false`. |
| `gdrive_info` | Return metadata for one file or directory: type, size, modified time, and path. A missing path is reported as `exists: false` rather than as an error. | `path` (required string): path relative to `root`. |
| `gdrive_read` | Read a UTF-8 text file, optionally a line range. | `path` (required string): file relative to `root`. `offset` (optional number): 1-based line number to start at; defaults to `1`. `limit_lines` (optional number): maximum lines to return; defaults to `2000`, further truncated by `readMaxBytes`. |
| `gdrive_search` | Search file names, or scan file contents, under a directory. | `query` (required string): text to find. `path` (optional string): directory to search under; defaults to `root`. `mode` (optional `"name"` or `"content"`): defaults to `"name"`. `max_results` (optional number): capped by `searchMaxResults`. |
| `gdrive_upload` | Write one file into the Drive: either inline text or a copy of a local file. Parent directories are created automatically. | `path` (required string): destination relative to `root`. `content` (optional string): UTF-8 text to write. `source_path` (optional string): local file under `downloadRoot` to copy. Exactly one of `content` and `source_path` is required. `overwrite` (optional boolean): replace an existing destination; defaults to `false`. The written size must not exceed `writeMaxBytes`. |
| `gdrive_download` | Copy one Drive file to the local filesystem. Parent directories for the destination are created automatically. | `path` (required string): file relative to `root`. `dest_path` (optional string): local destination under `downloadRoot`; defaults to the file name under `downloadRoot`. `overwrite` (optional boolean): replace an existing local file; defaults to `false`. |
| `gdrive_mkdir` | Create a directory. | `path` (required string): directory relative to `root`. `recursive` (optional boolean): create missing parents; defaults to `true`. |
| `gdrive_move` | Move or rename a file or directory inside the Drive. | `from` (required string): source relative to `root`. `to` (required string): destination relative to `root`. `overwrite` (optional boolean): replace an existing destination; defaults to `false`. |
| `gdrive_delete` | Permanently delete a file or directory. The mount has no trash, so deletion is irreversible. | `path` (required string): path relative to `root`. `recursive` (optional boolean): required for a non-empty directory; defaults to `false`. `confirm` (required boolean): must be exactly `true`, otherwise the call is rejected. |

`gdrive_read` is text-only. It rejects binary files and files larger than `readMaxBytes`; use `gdrive_download` for those. `gdrive_upload` with `content` is for text; use `source_path` to copy binary files.

## Errors

Every failure carries a stable code beginning with `GDRIVE_`, so a model can distinguish its own argument mistakes from an unavailable mount. Examples:

| Code | Meaning |
| --- | --- |
| `GDRIVE_INVALID_PATH` | The path is malformed, uses `..`, resolves outside its root, or escapes through a symbolic link. |
| `GDRIVE_ROOT_MISSING` | The configured `root` (or `downloadRoot`) does not exist, is not a directory, or the mount is not ready. |
| `GDRIVE_EXISTS` | The destination already exists and `overwrite` was not set to `true`. |
| `GDRIVE_CONFIRM_REQUIRED` | `gdrive_delete` was called without `confirm: true`. |
| `GDRIVE_BINARY` | `gdrive_read` found binary content; use `gdrive_download` instead. |

Additional codes include `GDRIVE_NOT_FOUND`, `GDRIVE_NOT_A_FILE`, `GDRIVE_NOT_A_DIRECTORY`, `GDRIVE_TOO_LARGE`, `GDRIVE_NOT_EMPTY`, `GDRIVE_WRITE_DISABLED`, `GDRIVE_DELETE_DISABLED`, `GDRIVE_INVALID_ARGS`, and `GDRIVE_IO`.

## Safety model

- **One root.** Every Drive path is resolved against `root` and must remain inside it after resolving `..` and symbolic links. Paths that escape are rejected, not clamped.
- **One local root.** Local-side paths are resolved against `downloadRoot` with the same confinement.
- **Deletion is explicit and permanent.** `gdrive_delete` refuses to run unless `confirm` is literally `true`. Deleting a non-empty directory additionally requires `recursive: true`. The mount has no trash, so a confirmed delete cannot be undone.
- **No silent overwrites.** Upload, download, and move refuse to replace an existing destination unless `overwrite: true`.
- **Bounded I/O.** Reads, listings, searches, and writes are capped by configuration; binary reads are refused with a pointer to `gdrive_download`.
- **Write switches.** `allowWrite: false` disables upload, mkdir, move, and download (which writes locally); `allowDelete: false` disables delete. Both are enforced by the plugin, independently of the mount's own permissions.

These guards bound what the plugin accepts, not what the mount can reach: anything the DSH process user can access elsewhere on the filesystem is still governed by DSH's own file policy.

## Known limitations

- **Requires an existing rclone FUSE mount.** The plugin is not a Google Drive API client: there is no OAuth login, no sharing or permission management, no version history, and no native Drive search. All access happens through whatever the mount exposes.
- **Search is local and bounded.** It walks the mounted tree under `path`, limited by `searchMaxFiles` and `searchMaxFileBytes`; it does not use Google's server-side search and can miss files outside those limits.
- **Throughput depends on rclone and FUSE.** Latency, listing speed, and large-file transfers are dominated by the mount and the network. Writes use rclone's VFS cache; without a suitable cache mode, writes can be slow or fail.
- **The mount must be ready.** If the mount is missing, empty, or returning I/O errors, the tools report `GDRIVE_*` errors instead of falling back to anything else. Mount readiness is the operator's responsibility.
- **No transactionality or locking.** There is no atomic multi-step operation and no cross-session locking; a concurrently deleted file or a dropped mount can fail a call midway.
- **Caps are per call.** They do not reserve quota, and changing them changes what the model can read or write immediately.

## Repository layout

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

`cordis.patch.yml` is the packaged bundle patch that inserts the plugin row. Documentation lives in `README.md`, `README.zh.md`, `CONTRIBUTING.md`, and `LICENSE`.

## Plugin contract

- Package name `dsh-google-drive-tools`; ESM; entry `index.js`; zero runtime dependencies.
- Exports `name = "google-drive-tools"`, `inject = ["tools"]`, and `apply(ctx, config)`.
- `apply` validates the optional config, then registers the nine `gdrive_*` tools on `ctx.tools`. Disposal unregisters them.
- Each call resolves and confines the path, performs the filesystem operation on the mount, and returns a structured result or throws a coded `GDRIVE_*` error.

## Development

```bash
node --test test/*.test.js
```

There is no install step: the package has no runtime or development dependencies. CI runs the same command on Node.js 22.x and 24.x on `ubuntu-latest` for every push and pull request.

## Publishing

`scripts/publish-github.sh` creates the repository if it does not exist and pushes the current branch, without writing the token into `.git/config`:

```bash
GH_TOKEN=github_pat_... GH_OWNER=your-login scripts/publish-github.sh dsh-google-drive-tools public
```

## License

[MIT](LICENSE)
