/**
 * Model-facing tool definitions.
 *
 * Each entry is a plain cordis/DSH tool descriptor: the harness validates arguments against the
 * JSON Schema in `parameters`, runs `execute`, and renders `output.render(args, value)` as the
 * tool result text. Schemas are written by hand so the package needs no harness import at load
 * time and can be exercised by plain `node --test`.
 */
import { formatBytes } from './paths.js'

/** @param {string} path */
function directorySuffix(type) {
  return type === 'directory' ? '/' : ''
}

/**
 * Render one listing as an aligned table.
 * @param {{path: string, entries: {name: string, type: string, size: number, modified: string}[], total: number, truncated: boolean}} value
 */
function renderList(value) {
  const header = `${value.entries.length} of ${value.total} entries in ${value.path}${value.truncated ? ' (truncated)' : ''}`
  const rows = value.entries.map((entry) => {
    const kind = entry.type === 'directory' ? 'd' : entry.type === 'file' ? 'f' : '?'
    const size = entry.type === 'directory' ? '-' : formatBytes(entry.size)
    return `${kind}  ${size.padStart(9)}  ${entry.modified}  ${entry.name}${directorySuffix(entry.type)}`
  })
  return [header, ...rows].join('\n')
}

/** @param {{path: string, exists: boolean, type: string, size: number, modified: string, mime?: string}} value */
function renderInfo(value) {
  if (!value.exists) return `${value.path} does not exist in the mounted drive`
  return [
    `path: ${value.path}`,
    `type: ${value.type}`,
    `size: ${formatBytes(value.size)} (${value.size} bytes)`,
    `modified: ${value.modified}`,
    ...(value.mime === undefined ? [] : [`mime: ${value.mime}`]),
  ].join('\n')
}

/**
 * @param {{path: string, offset: number, lines: {number: number, text: string}[], totalLines: number, truncated: boolean}} value
 */
function renderRead(value) {
  const last = value.lines.at(-1)?.number ?? value.offset - 1
  const header = `${value.path} — lines ${value.offset}-${last} of ${value.totalLines}${value.truncated ? ' (truncated)' : ''}`
  const body = value.lines.map((line) => `${String(line.number).padStart(5)}  ${line.text}`).join('\n')
  return body === '' ? header : `${header}\n${body}`
}

/**
 * @param {{query: string, mode: string, matches: {path: string, type: string, line?: number, snippet?: string}[], scanned: number, truncated: boolean}} value
 */
function renderSearch(value) {
  if (value.matches.length === 0) {
    return `no ${value.mode} matches for "${value.query}" (${value.scanned} entries scanned)`
  }
  const header =
    `${value.matches.length} ${value.mode} match(es) for "${value.query}" (${value.scanned} entries scanned)` +
    `${value.truncated ? ', truncated' : ''}`
  const rows = value.matches.map((match) => {
    if (match.line === undefined) return `${match.type === 'directory' ? 'd' : 'f'}  ${match.path}`
    return `f  ${match.path}:${match.line}  ${match.snippet ?? ''}`
  })
  return [header, ...rows].join('\n')
}

/**
 * Every tool the plugin can register. `enabled` lets the plugin honour the write/delete switches.
 * @param {ReturnType<import('./ops.js').createOps>} ops
 * @param {import('./config.js').DEFAULTS} config
 */
export function createTools(ops, config) {
  /** @type {{definition: object, enabled: boolean}[]} */
  return [
    {
      enabled: true,
      definition: {
        name: 'gdrive_list',
        description:
          'List one directory of the mounted Google Drive. Paths are relative to the drive root ' +
          '("/" or "" means the root); absolute paths inside the root also work. Returns each ' +
          'entry\'s name, type, size and modification time.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'Directory to list. Omit or pass "" for the drive root.' },
            limit: {
              type: 'number',
              description: `Maximum entries to return (default and cap: ${config.listMaxEntries}).`,
            },
            include_hidden: { type: 'boolean', description: 'Include entries whose name starts with ".".' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'entries', 'total', 'truncated'],
            properties: {
              path: { type: 'string' },
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'path', 'type', 'size', 'modified'],
                  properties: {
                    name: { type: 'string' },
                    path: { type: 'string' },
                    type: { type: 'string' },
                    size: { type: 'number' },
                    modified: { type: 'string' },
                  },
                },
              },
              total: { type: 'number' },
              truncated: { type: 'boolean' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: renderList(value) }],
        },
        isConcurrencySafe: () => true,
        execute: (args) => ops.list(args),
      },
    },
    {
      enabled: true,
      definition: {
        name: 'gdrive_info',
        description:
          'Report whether one path exists in the mounted Google Drive and, if so, its type ' +
          '(file/directory/symlink), size, modification time and guessed MIME type. Use it before ' +
          'overwriting or deleting anything.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Path relative to the drive root.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'exists', 'type', 'size', 'modified'],
            properties: {
              path: { type: 'string' },
              exists: { type: 'boolean' },
              type: { type: 'string' },
              size: { type: 'number' },
              modified: { type: 'string' },
              mime: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: renderInfo(value) }],
        },
        isConcurrencySafe: () => true,
        execute: (args) => ops.info(args),
      },
    },
    {
      enabled: true,
      definition: {
        name: 'gdrive_read',
        description:
          'Read a window of a UTF-8 text file from the mounted Google Drive, with line numbers. ' +
          'Binary files are refused: use gdrive_download for those. Files larger than the read ' +
          'limit are refused as well.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'File path relative to the drive root.' },
            offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
            limit_lines: { type: 'number', description: 'Maximum lines to return. Defaults to 2000.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'offset', 'lines', 'totalLines', 'truncated'],
            properties: {
              path: { type: 'string' },
              offset: { type: 'number' },
              lines: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['number', 'text'],
                  properties: {
                    number: { type: 'number' },
                    text: { type: 'string' },
                  },
                },
              },
              totalLines: { type: 'number' },
              truncated: { type: 'boolean' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
        },
        isConcurrencySafe: () => true,
        execute: (args) => ops.read(args),
      },
    },
    {
      enabled: true,
      definition: {
        name: 'gdrive_search',
        description:
          'Search the mounted Google Drive by file name (mode "name", default: substring or ' +
          '`*`/`?` glob) or by text inside files (mode "content"). Hidden entries are skipped and ' +
          'very large files are not scanned for content.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Text or glob pattern to look for.' },
            path: { type: 'string', description: 'Directory to search below. Defaults to the drive root.' },
            mode: {
              type: 'string',
              enum: ['name', 'content'],
              description: '"name" matches entry names, "content" matches text inside files.',
            },
            max_results: {
              type: 'number',
              description: `Maximum matches (default and cap: ${config.searchMaxResults}).`,
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['query', 'mode', 'matches', 'scanned', 'truncated'],
            properties: {
              query: { type: 'string' },
              mode: { type: 'string' },
              matches: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['path', 'type'],
                  properties: {
                    path: { type: 'string' },
                    type: { type: 'string' },
                    line: { type: 'number' },
                    snippet: { type: 'string' },
                  },
                },
              },
              scanned: { type: 'number' },
              truncated: { type: 'boolean' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
        },
        isConcurrencySafe: () => true,
        execute: (args) => ops.search(args),
      },
    },
    {
      enabled: config.allowWrite,
      definition: {
        name: 'gdrive_upload',
        description:
          'Create or replace one file in the mounted Google Drive. Pass inline UTF-8 "content", or ' +
          '"source_path" to upload a local file (resolved under the configured local root). Parent ' +
          'directories are created automatically; existing files need overwrite: true.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Destination file path relative to the drive root.' },
            content: { type: 'string', description: 'Inline UTF-8 text to write.' },
            source_path: { type: 'string', description: 'Local file to upload instead of inline content.' },
            overwrite: { type: 'boolean', description: 'Replace the destination if it already exists.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'bytes', 'overwritten'],
            properties: {
              path: { type: 'string' },
              bytes: { type: 'number' },
              overwritten: { type: 'boolean' },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: `${value.overwritten ? 'replaced' : 'created'} ${value.path} (${formatBytes(value.bytes)})`,
            },
          ],
        },
        execute: (args) => ops.upload(args),
      },
    },
    {
      enabled: config.allowWrite,
      definition: {
        name: 'gdrive_download',
        description:
          'Copy one file from the mounted Google Drive to the local workspace so other tools can ' +
          'work on it. The destination is resolved under the configured local root and defaults to ' +
          'the file name in that root.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Drive file to copy.' },
            dest_path: { type: 'string', description: 'Local destination, relative to the local root.' },
            overwrite: { type: 'boolean', description: 'Replace the local destination if it already exists.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'destPath', 'bytes'],
            properties: {
              path: { type: 'string' },
              destPath: { type: 'string' },
              bytes: { type: 'number' },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: `copied ${value.path} to ${value.destPath} (${formatBytes(value.bytes)})` },
          ],
        },
        execute: (args) => ops.download(args),
      },
    },
    {
      enabled: config.allowWrite,
      definition: {
        name: 'gdrive_mkdir',
        description: 'Create a directory in the mounted Google Drive, creating missing parents.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Directory path relative to the drive root.' },
            recursive: { type: 'boolean', description: 'Create missing parents. Defaults to true.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'created'],
            properties: {
              path: { type: 'string' },
              created: { type: 'boolean' },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: value.created ? `created ${value.path}` : `${value.path} already exists` },
          ],
        },
        execute: (args) => ops.mkdir(args),
      },
    },
    {
      enabled: config.allowWrite,
      definition: {
        name: 'gdrive_move',
        description:
          'Move or rename one file or directory inside the mounted Google Drive. Both paths must ' +
          'stay inside the drive root; an existing destination needs overwrite: true.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: {
            from: { type: 'string', description: 'Existing path to move.' },
            to: { type: 'string', description: 'New path.' },
            overwrite: { type: 'boolean', description: 'Replace the destination if it already exists.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['from', 'to'],
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `moved ${value.from} -> ${value.to}` }],
        },
        execute: (args) => ops.move(args),
      },
    },
    {
      enabled: config.allowDelete,
      definition: {
        name: 'gdrive_delete',
        description:
          'Permanently delete one file or directory from the mounted Google Drive. This is ' +
          'destructive and irreversible (the rclone mount has no trash): confirm the path with ' +
          'gdrive_info first and pass confirm: true. Non-empty directories need recursive: true.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'confirm'],
          properties: {
            path: { type: 'string', description: 'Path to delete, relative to the drive root.' },
            recursive: { type: 'boolean', description: 'Delete a non-empty directory with its contents.' },
            confirm: { type: 'boolean', description: 'Must be true; the call is refused otherwise.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'type', 'removed'],
            properties: {
              path: { type: 'string' },
              type: { type: 'string' },
              removed: { type: 'number' },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: `deleted ${value.type} ${value.path} (${value.removed} entries removed)` },
          ],
        },
        execute: (args) => ops.delete(args),
      },
    },
  ]
}
