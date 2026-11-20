import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../index.js'
import { resolveConfig } from '../src/config.js'
import { createOps } from '../src/ops.js'
import { createTools } from '../src/tools.js'
import { makeSandbox } from './helpers.js'

const READ_TOOLS = ['gdrive_list', 'gdrive_info', 'gdrive_read', 'gdrive_search']
const WRITE_TOOLS = ['gdrive_upload', 'gdrive_download', 'gdrive_mkdir', 'gdrive_move']

/** @param {Record<string, unknown>} [overrides] */
function toolsFor(overrides = {}) {
  const config = resolveConfig(overrides)
  const ops = createOps(config)
  return createTools(ops, config).filter((entry) => entry.enabled).map((entry) => entry.definition)
}

const SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
])

/**
 * Walk a schema and assert it stays inside the keyword subset DSH accepts, so registration cannot
 * fail on an unsupported keyword at load time.
 * @param {unknown} node
 * @param {string} path
 */
function assertSupportedSchema(node, path) {
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${path} must be an object`)
  const record = /** @type {Record<string, unknown>} */ (node)
  for (const key of Object.keys(record)) {
    assert.ok(SCHEMA_KEYWORDS.has(key), `${path}.${key} is not a supported schema keyword`)
  }
  if (record.type === 'object') {
    assert.equal(typeof record.additionalProperties, 'boolean', `${path}.additionalProperties must be explicit`)
    const properties = /** @type {Record<string, unknown>} */ (record.properties ?? {})
    if (record.required !== undefined) {
      assert.ok(Array.isArray(record.required), `${path}.required must be an array`)
      for (const key of record.required) assert.ok(key in properties, `${path}.required names unknown "${key}"`)
    }
    for (const [key, child] of Object.entries(properties)) assertSupportedSchema(child, `${path}.properties.${key}`)
  }
  if (record.type === 'array') assertSupportedSchema(record.items, `${path}.items`)
}

test('the plugin entry declares its name and required service', () => {
  assert.equal(name, 'google-drive-tools')
  assert.deepEqual(inject, ['tools'])
})

test('all nine tools are registered by default', () => {
  const names = toolsFor().map((tool) => tool.name)
  assert.deepEqual(names, [...READ_TOOLS, ...WRITE_TOOLS, 'gdrive_delete'])
})

test('write and delete switches remove the matching tools', () => {
  const readOnly = toolsFor({ allowWrite: false, allowDelete: false }).map((tool) => tool.name)
  assert.deepEqual(readOnly, READ_TOOLS)

  const noDelete = toolsFor({ allowDelete: false }).map((tool) => tool.name)
  assert.deepEqual(noDelete, [...READ_TOOLS, ...WRITE_TOOLS])
})

test('every definition carries a supported schema and a renderer', () => {
  for (const tool of toolsFor()) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `${tool.name} needs a useful description`)
    assertSupportedSchema(tool.parameters, `${tool.name}.parameters`)
    assert.equal(tool.parameters.type, 'object')
    assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('read-only tools are marked concurrency-safe and writers are not', () => {
  for (const tool of toolsFor()) {
    const safe = tool.isConcurrencySafe?.() === true
    if (READ_TOOLS.includes(tool.name)) assert.equal(safe, true, `${tool.name} should be concurrency-safe`)
    else assert.equal(safe, false, `${tool.name} must not be concurrency-safe`)
  }
})

test('renderers produce a single text block', async (t) => {
  const sandbox = await makeSandbox(t)
  const config = resolveConfig({ root: sandbox.drive, downloadRoot: sandbox.local })
  const ops = createOps(config)
  const byName = new Map(createTools(ops, config).map((entry) => [entry.definition.name, entry.definition]))

  const rendered = {
    gdrive_list: await byName.get('gdrive_list').output.render({}, await ops.list({})),
    gdrive_info: await byName.get('gdrive_info').output.render({}, await ops.info({ path: 'absent.txt' })),
    gdrive_search: await byName.get('gdrive_search').output.render(
      {},
      { query: 'zzz', mode: 'name', matches: [], scanned: 0, truncated: false },
    ),
  }
  for (const blocks of Object.values(rendered)) {
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
    assert.ok(blocks[0].text.length > 0)
  }
})

test('apply registers every enabled tool against the context tools service', () => {
  /** @type {string[]} */
  const registered = []
  apply({ tools: { register: (definition) => registered.push(definition.name) } }, {
    root: '/tmp/does-not-matter-for-registration',
  })
  assert.deepEqual(registered, [...READ_TOOLS, ...WRITE_TOOLS, 'gdrive_delete'])
})

test('apply rejects an invalid config before registering anything', () => {
  /** @type {string[]} */
  const registered = []
  assert.throws(
    () => apply({ tools: { register: (definition) => registered.push(definition.name) } }, { root: 'relative' }),
    /must be an absolute path/,
  )
  assert.deepEqual(registered, [])
})
