/**
 * Path confinement and small formatting helpers.
 *
 * The plugin's whole security story is here: every caller-supplied path is turned into one
 * absolute path inside the configured `root`, and any attempt to leave that directory — through
 * `..`, an absolute path elsewhere, or a symlink — fails before a file is touched.
 */
import { realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { GdriveError } from './errors.js'

/**
 * Resolve the configured mount root to its real path.
 * @param {string} rootPath - configured absolute path.
 * @returns {Promise<string>} the canonical root directory.
 * @throws {GdriveError} `GDRIVE_ROOT_MISSING` when the mount is absent or not a directory.
 */
export async function resolveRoot(rootPath) {
  let real
  try {
    real = await realpath(rootPath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new GdriveError(
        `the Google Drive root "${rootPath}" does not exist. Mount the drive first (for example ` +
          '`rclone mount gdrive: /workspace/GoogleDrive/files`), or point the plugin config "root" ' +
          'at the directory that holds the mounted files.',
        'GDRIVE_ROOT_MISSING',
      )
    }
    throw new GdriveError(`cannot resolve the Google Drive root "${rootPath}": ${error.message}`, 'GDRIVE_IO')
  }
  const info = await stat(real)
  if (!info.isDirectory()) {
    throw new GdriveError(`the configured Google Drive root "${rootPath}" is not a directory`, 'GDRIVE_ROOT_MISSING')
  }
  return real
}

/** @returns {Promise<string | undefined>} the real path, or undefined when the path is absent. */
async function realpathOrUndefined(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
    throw error
  }
}

/** @param {string} root @param {string} candidate */
function assertInside(root, candidate) {
  if (candidate === root) return
  if (!candidate.startsWith(root + sep)) {
    throw new GdriveError(
      `path "${candidate}" escapes the Google Drive root "${root}". Pass a path relative to the ` +
        'root, or an absolute path inside it.',
      'GDRIVE_INVALID_PATH',
    )
  }
}

/**
 * Turn a model-supplied path into a confined absolute path.
 *
 * Lexical confinement happens first (`..` and absolute paths are normalised), then the existing
 * part of the path is resolved through `realpath` so a symlink inside the mount cannot redirect
 * a read, write or delete outside it.
 *
 * @param {string} root - canonical root from {@link resolveRoot}.
 * @param {string | undefined} input - caller path; `''`/undefined/`'/'` mean the root itself.
 * @returns {Promise<string>} absolute path guaranteed to sit inside the root.
 */
export async function confinePath(root, input) {
  const raw = input === undefined || input === null ? '' : String(input)
  if (raw.includes('\0')) {
    throw new GdriveError('paths must not contain NUL bytes', 'GDRIVE_INVALID_PATH')
  }
  const trimmed = raw.trim()
  const lexical = trimmed === '' || trimmed === '/' || trimmed === '.'
    ? root
    : trimmed.startsWith('/')
      ? resolvePath(trimmed)
      : resolvePath(join(root, trimmed))

  assertInside(root, lexical)

  let current = lexical
  /** @type {string[]} */
  const missing = []
  for (;;) {
    const real = await realpathOrUndefined(current)
    if (real !== undefined) {
      const effective = missing.length === 0 ? real : join(real, ...missing.reverse())
      assertInside(root, effective)
      return effective
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new GdriveError(`cannot resolve a path inside "${root}"`, 'GDRIVE_INVALID_PATH')
    }
    missing.push(current.slice(parent.length).replace(/^[/\\]+/, ''))
    current = parent
  }
}

/**
 * Confine a destination on the local filesystem (used by downloads) to its own root.
 * @param {string} root - configured `downloadRoot`.
 * @param {string | undefined} input - caller path.
 * @returns {Promise<string>} absolute destination path.
 */
export async function confineLocalPath(root, input) {
  const realRoot = await resolveRoot(root)
  return confinePath(realRoot, input)
}

/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** @param {number} ms */
export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  return new Date(ms).toISOString().replace('.000Z', 'Z')
}

const MIME_BY_EXTENSION = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.gpg': 'application/pgp-encrypted',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
}

/**
 * Best-effort MIME type from the file extension.
 * @param {string} path
 * @returns {string | undefined}
 */
export function guessMimeType(path) {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return undefined
  return MIME_BY_EXTENSION[lower.slice(dot)]
}

/**
 * Decide whether a byte sample looks like binary content.
 *
 * Text files in a Drive mount are overwhelmingly UTF-8; a NUL byte, a high share of control
 * characters, or a byte sequence that is not valid UTF-8 all mean "read this with
 * `gdrive_download` instead".
 *
 * @param {Buffer} sample - the first bytes of the file.
 * @returns {boolean}
 */
export function looksBinary(sample) {
  if (sample.length === 0) return false
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1
  }
  if (control / sample.length > 0.3) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true })
  } catch {
    return true
  }
  return false
}
