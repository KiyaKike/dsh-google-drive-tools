# Contributing

Thanks for taking a look. This project is small and deliberately dependency-free, so contributing should be quick.

## Requirements

- Node.js 22 or newer (`node --version`).
- Linux or macOS with FUSE if you want to exercise the plugin against a real rclone mount.

The package has zero runtime dependencies and no build step. Do not add runtime dependencies; use Node built-ins (`node:fs/promises`, `node:path`, `node:test`, ...) instead.

## Run the tests

From the repository root:

```bash
node --test test/*.test.js
```

CI runs the same command on Node.js 22.x and 24.x on `ubuntu-latest` for every push and pull request. If you add a test file, name it `test/<something>.test.js` so it is picked up by the glob.

Most tests should run without a real Google Drive mount. If you add integration-style tests that need an rclone FUSE mount, make them skip cleanly when the mount is unavailable, and point them at a temporary directory via the `root` option rather than assuming `/workspace/GoogleDrive/files` exists.

## Before you open a pull request

1. Keep the change focused: one logical change per pull request.
2. Run the test command above and make sure it passes on your machine.
3. Update `README.md` and `README.zh.md` together when behavior, configuration, or a tool's parameters change. The two files are expected to stay in sync.
4. Do not edit `LICENSE` unless the change is intentional.

Open the pull request against the default branch and describe:

- the problem the change solves;
- what a model or user observes before and after;
- any change to a tool's arguments, return value, or failure mode.

Small PRs with a clear description get reviewed fastest.

## Commit messages

Use a short imperative subject line, then a body when the reason is not obvious:

```text
Add gdrive_mkdir recursive creation

Creating intermediate directories is required before uploading into a path
that does not exist yet. recursive=false keeps the old single-level behavior.
```

- Subject line: imperative mood, no trailing period, roughly 72 characters or less.
- Body: explain why, not only what. Wrap at 72 characters.
- Reference the affected tool or config option by name when relevant.
- One topic per commit; squash fixup commits before merging if the history would otherwise be noisy.

## Reporting bugs

Include the DSH version, the Node.js version, your plugin configuration (redact paths if needed), the exact tool call, and the full error text. A failing tool call is much easier to debug when the arguments and the `root` setting are visible.
