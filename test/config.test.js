import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS, resolveConfig } from '../src/config.js'

test('resolveConfig returns every default when called without a config', () => {
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULTS })
  assert.equal(resolveConfig(undefined).root, '/workspace/GoogleDrive/files')
  assert.equal(resolveConfig(undefined).allowWrite, true)
})

test('resolveConfig applies overrides and strips trailing slashes', () => {
  const config = resolveConfig({ root: '/mnt/gdrive/', downloadRoot: '/tmp/work/', readMaxBytes: 2048 })
  assert.equal(config.root, '/mnt/gdrive')
  assert.equal(config.downloadRoot, '/tmp/work')
  assert.equal(config.readMaxBytes, 2048)
})

test('resolveConfig rejects unknown keys so typos cannot be silently ignored', () => {
  assert.throws(() => resolveConfig({ rootPath: '/mnt' }), /unknown config key "rootPath"/)
})

test('resolveConfig rejects relative roots', () => {
  assert.throws(() => resolveConfig({ root: 'GoogleDrive/files' }), /must be an absolute path/)
})

test('resolveConfig rejects non-positive limits', () => {
  for (const key of ['readMaxBytes', 'listMaxEntries', 'searchMaxResults', 'writeMaxBytes']) {
    assert.throws(() => resolveConfig({ [key]: 0 }), new RegExp(`"${key}" must be a positive integer`))
    assert.throws(() => resolveConfig({ [key]: 1.5 }), new RegExp(`"${key}" must be a positive integer`))
  }
})

test('resolveConfig rejects non-boolean switches', () => {
  assert.throws(() => resolveConfig({ allowWrite: 'yes' }), /"allowWrite" must be a boolean/)
  assert.throws(() => resolveConfig({ allowDelete: 1 }), /"allowDelete" must be a boolean/)
})

test('resolveConfig rejects an absurd write cap', () => {
  assert.throws(() => resolveConfig({ writeMaxBytes: 2 * 1024 * 1024 * 1024 }), /must not exceed 1 GiB/)
})
