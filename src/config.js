/**
 * Plugin configuration: defaults, validation and normalisation.
 *
 * The plugin reads one directory — by default an existing rclone FUSE mount of a Google Drive
 * account — and never talks to Google's API itself. Everything here is plain data, so the
 * module stays dependency-free and cheap to unit-test.
 */

/**
 * Defaults for every supported key. `root` is the rclone mount point; the caps below keep a
 * single tool call bounded regardless of how large the mounted account is.
 */
export const DEFAULTS = Object.freeze({
  root: '/workspace/GoogleDrive/files',
  downloadRoot: '/workspace',
  readMaxBytes: 262144,
  listMaxEntries: 500,
  searchMaxResults: 100,
  searchMaxFileBytes: 1048576,
  searchMaxFiles: 2000,
  writeMaxBytes: 33554432,
  allowWrite: true,
  allowDelete: true,
})

/** Keys that must be positive integers. */
const INTEGER_KEYS = [
  'readMaxBytes',
  'listMaxEntries',
  'searchMaxResults',
  'searchMaxFileBytes',
  'searchMaxFiles',
  'writeMaxBytes',
]

/** Keys that must be booleans. */
const BOOLEAN_KEYS = ['allowWrite', 'allowDelete']

/**
 * Merge a raw plugin config over {@link DEFAULTS} and reject values that would make a tool
 * misbehave silently (a zero limit, a relative root, an unknown key).
 *
 * @param {Record<string, unknown> | undefined} raw - config as written in `cordis.patch.yml`.
 * @returns {typeof DEFAULTS} the resolved config.
 * @throws {Error} when a key is unknown or has the wrong shape.
 */
export function resolveConfig(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('google-drive-tools: config must be an object')
  }
  const known = new Set(Object.keys(DEFAULTS))
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new TypeError(
        `google-drive-tools: unknown config key "${key}" (known: ${[...known].join(', ')})`,
      )
    }
  }

  const config = { ...DEFAULTS, ...raw }

  for (const key of ['root', 'downloadRoot']) {
    const value = config[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`google-drive-tools: config "${key}" must be a non-empty string`)
    }
    if (!value.startsWith('/')) {
      throw new TypeError(`google-drive-tools: config "${key}" must be an absolute path`)
    }
    // Trailing slashes would make the confinement check compare "/root/" against "/root".
    config[key] = value.replace(/\/+$/, '') || '/'
  }

  for (const key of INTEGER_KEYS) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`google-drive-tools: config "${key}" must be a positive integer`)
    }
  }

  for (const key of BOOLEAN_KEYS) {
    if (typeof config[key] !== 'boolean') {
      throw new TypeError(`google-drive-tools: config "${key}" must be a boolean`)
    }
  }

  if (config.writeMaxBytes > 1024 * 1024 * 1024) {
    throw new TypeError('google-drive-tools: config "writeMaxBytes" must not exceed 1 GiB')
  }

  return config
}
