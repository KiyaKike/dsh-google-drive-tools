/**
 * Filesystem operations over the mounted Google Drive directory.
 *
 * This module knows nothing about the harness: it takes parsed, validated arguments and returns
 * plain JSON-ready values, which keeps it unit-testable against a temporary directory. Every
 * public operation re-resolves the mount root, so a tool call that arrives after the mount was
 * unmounted or remounted reports the real state instead of a cached one.
 */
import { randomBytes } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative as relativePath, sep } from 'node:path'
import { DEFAULTS } from './config.js'
import { GdriveError } from './errors.js'
import { clamp, confineLocalPath, confinePath, formatBytes, formatTime, guessMimeType, looksBinary, resolveRoot } from './paths.js'

/** Bytes inspected when deciding whether a file is text. */
const SAMPLE_BYTES = 8192

/** @param {import('node:fs').Dirent | import('node:fs').Stats} entry */
function typeOf(entry) {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

/**
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats | undefined>} lstat result, or undefined when absent.
 */
async function lstatSafe(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
    throw new GdriveError(`cannot inspect "${path}": ${error.message}`, 'GDRIVE_IO')
  }
}

/** @param {string} path */
async function readdirSafe(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new GdriveError(`"${path}" is not a directory`, 'GDRIVE_NOT_A_DIRECTORY')
    }
    throw new GdriveError(`cannot list "${path}": ${error.message}`, 'GDRIVE_IO')
  }
}

/**
 * Build a matcher for `gdrive_search` name mode: `*`/`?` globbing when the query contains them,
 * case-insensitive substring matching otherwise.
 * @param {string} query
 */
function makeNameMatcher(query) {
  const wildcard = query.includes('*') || query.includes('?')
  if (!wildcard) {
    const needle = query.toLowerCase()
    return (candidate) => candidate.toLowerCase().includes(needle)
  }
  const escaped = query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  const regex = new RegExp(`^${escaped}$`, 'i')
  return (candidate) => regex.test(candidate)
}

/**
 * Write bytes through a temp file in the same directory and rename, so a failed write never
 * leaves a half-written destination. Rename is one round trip on an rclone mount; when the mount
 * refuses it, the bytes are written in place instead.
 * @param {string} target
 * @param {Buffer} data
 */
async function writeAtomically(target, data) {
  const temporary = join(dirname(target), `.gdrive-upload-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await writeFile(temporary, data, { flag: 'wx' })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    if (error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EXDEV') {
      await writeFile(target, data)
      return
    }
    throw new GdriveError(`cannot write "${target}": ${error.message}`, 'GDRIVE_IO')
  }
}

/**
 * Stream-copy a file through a temp file and rename (see {@link writeAtomically}).
 * @param {string} source
 * @param {string} target
 */
async function copyAtomically(source, target) {
  const temporary = join(dirname(target), `.gdrive-copy-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await copyFile(source, temporary)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    if (error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EXDEV') {
      await copyFile(source, target)
      return
    }
    throw new GdriveError(`cannot copy "${source}" to "${target}": ${error.message}`, 'GDRIVE_IO')
  }
}

/**
 * Resolve the mount root and one confined target path.
 * @param {{root: string}} config
 * @param {string | undefined} input
 */
async function resolveTarget(config, input) {
  const root = await resolveRoot(config.root)
  const target = await confinePath(root, input)
  return { root, target }
}

/**
 * Create the operation set bound to one resolved config.
 * @param {typeof DEFAULTS} config
 */
export function createOps(config) {
  return {
    /**
     * List one directory, directories first.
     * @param {{path?: string, limit?: number, include_hidden?: boolean}} args
     */
    async list(args = {}) {
      const { target } = await resolveTarget(config, args.path)
      const info = await lstatSafe(target)
      if (info === undefined) {
        throw new GdriveError(`"${target}" does not exist in the mounted drive`, 'GDRIVE_NOT_FOUND')
      }
      if (!info.isDirectory()) {
        throw new GdriveError(`"${target}" is a ${typeOf(info)}, not a directory`, 'GDRIVE_NOT_A_DIRECTORY')
      }
      const includeHidden = args.include_hidden === true
      const all = (await readdirSafe(target)).filter((entry) => includeHidden || !entry.name.startsWith('.'))
      all.sort((left, right) => {
        const leftKind = left.isDirectory() ? 0 : 1
        const rightKind = right.isDirectory() ? 0 : 1
        if (leftKind !== rightKind) return leftKind - rightKind
        return left.name.localeCompare(right.name)
      })
      const limit = clamp(args.limit ?? config.listMaxEntries, 1, config.listMaxEntries)
      const selected = all.slice(0, limit)
      const entries = []
      for (const entry of selected) {
        const full = join(target, entry.name)
        const entryInfo = await lstatSafe(full)
        entries.push({
          name: entry.name,
          path: full,
          type: typeOf(entryInfo ?? entry),
          size: entryInfo?.isFile() ? entryInfo.size : 0,
          modified: formatTime(entryInfo?.mtimeMs),
        })
      }
      return { path: target, entries, total: all.length, truncated: all.length > selected.length }
    },

    /**
     * Report one path's type and metadata without reading it.
     * @param {{path: string}} args
     */
    async info(args = {}) {
      const { target } = await resolveTarget(config, args.path)
      const info = await lstatSafe(target)
      if (info === undefined) {
        return { path: target, exists: false, type: 'missing', size: 0, modified: '-' }
      }
      const mime = info.isFile() ? guessMimeType(target) : undefined
      return {
        path: target,
        exists: true,
        type: typeOf(info),
        size: info.size,
        modified: formatTime(info.mtimeMs),
        ...(mime === undefined ? {} : { mime }),
      }
    },

    /**
     * Read a window of a UTF-8 text file.
     * @param {{path: string, offset?: number, limit_lines?: number}} args
     */
    async read(args = {}) {
      const { target } = await resolveTarget(config, args.path)
      const info = await lstatSafe(target)
      if (info === undefined) {
        throw new GdriveError(`"${target}" does not exist in the mounted drive`, 'GDRIVE_NOT_FOUND')
      }
      if (info.isDirectory()) {
        throw new GdriveError(`"${target}" is a directory; use gdrive_list to inspect it`, 'GDRIVE_NOT_A_FILE')
      }
      if (info.size > config.readMaxBytes) {
        throw new GdriveError(
          `"${target}" is ${formatBytes(info.size)}, larger than the read limit of ` +
            `${formatBytes(config.readMaxBytes)}. Use gdrive_download to copy it locally, or raise ` +
            'the plugin config "readMaxBytes".',
          'GDRIVE_TOO_LARGE',
        )
      }

      const sample = Buffer.alloc(Math.min(SAMPLE_BYTES, info.size))
      if (sample.length > 0) {
        const handle = await open(target, 'r')
        try {
          await handle.read(sample, 0, sample.length, 0)
        } finally {
          await handle.close()
        }
      }
      if (looksBinary(sample)) {
        throw new GdriveError(
          `"${target}" looks like a binary file, so gdrive_read will not return it. Use gdrive_download ` +
            'to copy it to the local workspace.',
          'GDRIVE_BINARY',
        )
      }

      const text = await readFile(target, 'utf8')
      const rawLines = text.split('\n')
      const totalLines = text.endsWith('\n') ? rawLines.length - 1 : rawLines.length
      const offset = Math.max(1, Math.trunc(Number(args.offset ?? 1)) || 1)
      if (totalLines > 0 && offset > totalLines) {
        throw new GdriveError(
          `offset ${offset} is past the end of "${target}" (${totalLines} lines)`,
          'GDRIVE_INVALID_ARGS',
        )
      }
      const limitLines = clamp(args.limit_lines ?? 2000, 1, 100000)

      /** @type {{number: number, text: string}[]} */
      const lines = []
      let bytes = 0
      let truncatedByBytes = false
      for (let index = offset - 1; index < totalLines && lines.length < limitLines; index += 1) {
        const line = rawLines[index].replace(/\r$/, '')
        const size = Buffer.byteLength(line, 'utf8') + 1
        if (bytes + size > config.readMaxBytes) {
          truncatedByBytes = true
          break
        }
        bytes += size
        lines.push({ number: index + 1, text: line })
      }
      return {
        path: target,
        offset,
        lines,
        totalLines,
        truncated: truncatedByBytes || offset - 1 + lines.length < totalLines,
      }
    },

    /**
     * Search file names or file contents below one directory.
     * @param {{query: string, path?: string, mode?: 'name' | 'content', max_results?: number}} args
     */
    async search(args = {}) {
      const query = String(args.query ?? '').trim()
      if (query === '') throw new GdriveError('query must not be empty', 'GDRIVE_INVALID_ARGS')
      const mode = args.mode === 'content' ? 'content' : 'name'
      const { target: scope } = await resolveTarget(config, args.path)
      const scopeInfo = await lstatSafe(scope)
      if (scopeInfo === undefined) {
        throw new GdriveError(`"${scope}" does not exist in the mounted drive`, 'GDRIVE_NOT_FOUND')
      }
      if (!scopeInfo.isDirectory()) {
        throw new GdriveError(`"${scope}" is not a directory; search needs a directory scope`, 'GDRIVE_NOT_A_DIRECTORY')
      }

      const maxResults = clamp(args.max_results ?? config.searchMaxResults, 1, config.searchMaxResults)
      const matchesName = makeNameMatcher(query)
      const needle = query.toLowerCase()
      /** @type {{path: string, type: string, line?: number, snippet?: string}[]} */
      const matches = []
      /** @type {string[]} */
      const queue = [scope]
      let scanned = 0
      let truncated = false

      walk: while (queue.length > 0) {
        const directory = queue.shift()
        const entries = (await readdirSafe(directory)).filter((entry) => !entry.name.startsWith('.'))
        for (const entry of entries) {
          if (scanned >= config.searchMaxFiles) {
            truncated = true
            break walk
          }
          scanned += 1
          const full = join(directory, entry.name)
          const rel = relativePath(scope, full).split(sep).join('/')

          if (entry.isDirectory()) {
            if (mode === 'name' && (matchesName(entry.name) || matchesName(rel))) {
              matches.push({ path: full, type: 'directory' })
            }
            queue.push(full)
          } else if (entry.isFile()) {
            if (mode === 'name') {
              if (matchesName(entry.name) || matchesName(rel)) matches.push({ path: full, type: 'file' })
            } else {
              const info = await lstatSafe(full)
              if (info === undefined || info.size > config.searchMaxFileBytes) continue
              let text
              try {
                text = await readFile(full, 'utf8')
              } catch {
                continue
              }
              const lines = text.split('\n')
              for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index].replace(/\r$/, '')
                if (!line.toLowerCase().includes(needle)) continue
                matches.push({
                  path: full,
                  type: 'file',
                  line: index + 1,
                  snippet: line.trim().slice(0, 200),
                })
                if (matches.length >= maxResults) break
              }
            }
          }

          if (matches.length >= maxResults) {
            truncated = true
            break walk
          }
        }
      }

      return { query, mode, matches, scanned, truncated }
    },

    /**
     * Write a file into the mounted drive.
     * @param {{path: string, content?: string, source_path?: string, overwrite?: boolean}} args
     */
    async upload(args = {}) {
      if (!config.allowWrite) {
        throw new GdriveError('writes are disabled: set the plugin config "allowWrite: true"', 'GDRIVE_WRITE_DISABLED')
      }
      const hasContent = typeof args.content === 'string'
      const hasSource = typeof args.source_path === 'string' && args.source_path !== ''
      if (hasContent === hasSource) {
        throw new GdriveError(
          'pass exactly one of "content" (inline text) or "source_path" (a local file to upload)',
          'GDRIVE_INVALID_ARGS',
        )
      }
      const { target } = await resolveTarget(config, args.path)
      const existing = await lstatSafe(target)
      if (existing?.isDirectory()) {
        throw new GdriveError(`"${target}" is a directory; upload needs a file path`, 'GDRIVE_INVALID_ARGS')
      }
      if (existing !== undefined && args.overwrite !== true) {
        throw new GdriveError(`"${target}" already exists; pass overwrite: true to replace it`, 'GDRIVE_EXISTS')
      }

      let bytes
      if (hasContent) {
        const data = Buffer.from(args.content, 'utf8')
        if (data.length > config.writeMaxBytes) {
          throw new GdriveError(
            `inline content is ${formatBytes(data.length)}, above the write limit of ` +
              `${formatBytes(config.writeMaxBytes)}; write the file locally and upload it with "source_path" instead`,
            'GDRIVE_TOO_LARGE',
          )
        }
        bytes = data.length
        await mkdir(dirname(target), { recursive: true })
        await writeAtomically(target, data)
      } else {
        const source = await confineLocalPath(config.downloadRoot, args.source_path)
        const sourceInfo = await lstatSafe(source)
        if (sourceInfo === undefined || !sourceInfo.isFile()) {
          throw new GdriveError(
            `local source "${source}" does not exist or is not a file (allowed under "${config.downloadRoot}")`,
            'GDRIVE_NOT_FOUND',
          )
        }
        if (sourceInfo.size > config.writeMaxBytes) {
          throw new GdriveError(
            `local source is ${formatBytes(sourceInfo.size)}, above the write limit of ${formatBytes(config.writeMaxBytes)}`,
            'GDRIVE_TOO_LARGE',
          )
        }
        bytes = sourceInfo.size
        await mkdir(dirname(target), { recursive: true })
        await copyAtomically(source, target)
      }

      return { path: target, bytes, overwritten: existing !== undefined }
    },

    /**
     * Copy a file from the mounted drive to the local workspace.
     * @param {{path: string, dest_path?: string, overwrite?: boolean}} args
     */
    async download(args = {}) {
      if (!config.allowWrite) {
        throw new GdriveError('local writes are disabled: set the plugin config "allowWrite: true"', 'GDRIVE_WRITE_DISABLED')
      }
      const { target } = await resolveTarget(config, args.path)
      const info = await lstatSafe(target)
      if (info === undefined) {
        throw new GdriveError(`"${target}" does not exist in the mounted drive`, 'GDRIVE_NOT_FOUND')
      }
      if (!info.isFile()) {
        throw new GdriveError(`"${target}" is a ${typeOf(info)}, not a file`, 'GDRIVE_NOT_A_FILE')
      }

      let destination = await confineLocalPath(config.downloadRoot, args.dest_path ?? basename(target))
      if ((await lstatSafe(destination))?.isDirectory()) destination = join(destination, basename(target))
      if ((await lstatSafe(destination)) !== undefined && args.overwrite !== true) {
        throw new GdriveError(
          `local destination "${destination}" already exists; pass overwrite: true to replace it`,
          'GDRIVE_EXISTS',
        )
      }
      await mkdir(dirname(destination), { recursive: true })
      await copyAtomically(target, destination)
      return { path: target, destPath: destination, bytes: info.size }
    },

    /**
     * Create one directory inside the mounted drive.
     * @param {{path: string, recursive?: boolean}} args
     */
    async mkdir(args = {}) {
      if (!config.allowWrite) {
        throw new GdriveError('writes are disabled: set the plugin config "allowWrite: true"', 'GDRIVE_WRITE_DISABLED')
      }
      const { target } = await resolveTarget(config, args.path)
      const existing = await lstatSafe(target)
      if (existing?.isDirectory()) return { path: target, created: false }
      if (existing !== undefined) {
        throw new GdriveError(`"${target}" already exists and is not a directory`, 'GDRIVE_INVALID_ARGS')
      }
      await mkdir(target, { recursive: args.recursive !== false })
      return { path: target, created: true }
    },

    /**
     * Move or rename one path inside the mounted drive.
     * @param {{from: string, to: string, overwrite?: boolean}} args
     */
    async move(args = {}) {
      if (!config.allowWrite) {
        throw new GdriveError('writes are disabled: set the plugin config "allowWrite: true"', 'GDRIVE_WRITE_DISABLED')
      }
      const source = (await resolveTarget(config, args.from)).target
      const destination = (await resolveTarget(config, args.to)).target
      if (source === destination) throw new GdriveError('"from" and "to" are the same path', 'GDRIVE_INVALID_ARGS')
      const sourceInfo = await lstatSafe(source)
      if (sourceInfo === undefined) {
        throw new GdriveError(`"${source}" does not exist in the mounted drive`, 'GDRIVE_NOT_FOUND')
      }
      const destinationInfo = await lstatSafe(destination)
      if (destinationInfo !== undefined) {
        if (args.overwrite !== true) {
          throw new GdriveError(`"${destination}" already exists; pass overwrite: true to replace it`, 'GDRIVE_EXISTS')
        }
        await rm(destination, { recursive: true, force: true })
      }
      await mkdir(dirname(destination), { recursive: true })
      try {
        await rename(source, destination)
      } catch (error) {
        if (!sourceInfo.isFile()) {
          throw new GdriveError(`cannot move "${source}" to "${destination}": ${error.message}`, 'GDRIVE_IO')
        }
        await copyAtomically(source, destination)
        await unlink(source)
      }
      return { from: source, to: destination }
    },

    /**
     * Delete one file or directory inside the mounted drive.
     * @param {{path: string, recursive?: boolean, confirm?: boolean}} args
     */
    async delete(args = {}) {
      if (!config.allowDelete) {
        throw new GdriveError('deletes are disabled: set the plugin config "allowDelete: true"', 'GDRIVE_DELETE_DISABLED')
      }
      if (args.confirm !== true) {
        throw new GdriveError(
          'deleting from the drive is destructive: pass confirm: true after checking the path with gdrive_info',
          'GDRIVE_CONFIRM_REQUIRED',
        )
      }
      const { root, target } = await resolveTarget(config, args.path)
      if (target === root) {
        throw new GdriveError('refusing to delete the mounted drive root', 'GDRIVE_INVALID_PATH')
      }
      const info = await lstatSafe(target)
      if (info === undefined) {
        throw new GdriveError(`"${target}" does not exist in the mounted drive`, 'GDRIVE_NOT_FOUND')
      }
      if (info.isDirectory()) {
        const children = await readdirSafe(target)
        if (children.length > 0 && args.recursive !== true) {
          throw new GdriveError(
            `"${target}" is not empty (${children.length} entries); pass recursive: true to remove it with its contents`,
            'GDRIVE_NOT_EMPTY',
          )
        }
        if (args.recursive === true) await rm(target, { recursive: true, force: false })
        else await rmdir(target)
        return { path: target, type: 'directory', removed: children.length }
      }
      await unlink(target)
      return { path: target, type: 'file', removed: 1 }
    },
  }
}
