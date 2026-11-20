/**
 * Errors raised by the Google Drive tools.
 *
 * Every failure carries a stable `code` so the model can tell a recoverable mistake (bad path,
 * missing overwrite) from an environment problem (mount missing, mount not writable). The code
 * is also the first token of the message, because a tool error reaches the model as text.
 */
export class GdriveError extends Error {
  /**
   * @param {string} message - human- and model-readable explanation.
   * @param {string} code - stable `GDRIVE_*` identifier.
   * @param {Record<string, unknown>} [details] - extra fields merged onto the error.
   */
  constructor(message, code = 'GDRIVE_ERROR', details = {}) {
    super(`${code}: ${message}`)
    this.name = 'GdriveError'
    this.code = code
    Object.assign(this, details)
  }
}

/** @param {string} code */
export function isGdriveError(code) {
  return (error) => error instanceof GdriveError && error.code === code
}
