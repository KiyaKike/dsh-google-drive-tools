/**
 * DSH plugin entry: expose one mounted Google Drive directory as model-facing read/write tools.
 *
 * The plugin declares only the `tools` service, so it can be mounted into any profile. All
 * filesystem work happens in `src/ops.js` over the directory at `config.root`; nothing here talks
 * to Google's API, which keeps OAuth, sharing and quota entirely out of scope.
 */
import { resolveConfig } from './src/config.js'
import { createOps } from './src/ops.js'
import { createTools } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'google-drive-tools'

/** Services required by the tool suite. */
export const inject = ['tools']

/**
 * Register every enabled tool for this agent.
 *
 * Registrations are effects scoped to `ctx`, so unloading or reloading the plugin removes them
 * without touching the rest of the tool registry.
 *
 * @param {object} ctx - plugin context providing `tools`.
 * @param {object} [rawConfig] - the entry's config from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const ops = createOps(config)
  for (const { definition, enabled } of createTools(ops, config)) {
    if (enabled) ctx.tools.register(definition)
  }
}
