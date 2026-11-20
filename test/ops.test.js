import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.js'
import { createOps } from '../src/ops.js'
import { makeSandbox, seedDrive } from './helpers.js'

/**
 * Build the operation set against the sandbox directories.
 * @param {{drive: string, local: string}} sandbox
 * @param {Record<string, unknown>} [overrides]
 */
function opsFor(sandbox, overrides = {}) {
  const config = resolveConfig({ root: sandbox.drive, downloadRoot: sandbox.local, ...overrides })
  return createOps(config)
}

test('list returns directories first with sizes and timestamps', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)

  const result = await ops.list({})
  assert.equal(result.total, 3)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.entries.map((entry) => entry.name), ['Backups', 'notes', 'readme.md'])
  assert.equal(result.entries[0].type, 'directory')
  assert.equal(result.entries[2].type, 'file')
  assert.equal(result.entries[2].size, 33)
  assert.match(result.entries[2].modified, /^\d{4}-\d{2}-\d{2}T/)
})

test('list honours limit and reports truncation', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)
  const result = await ops.list({ limit: 2 })
  assert.equal(result.entries.length, 2)
  assert.equal(result.truncated, true)
})

test('list hides dot entries unless asked', async (t) => {
  const sandbox = await makeSandbox(t)
  await writeFile(join(sandbox.drive, '.hidden'), 'x')
  const ops = opsFor(sandbox)
  assert.equal((await ops.list({})).total, 0)
  assert.equal((await ops.list({ include_hidden: true })).total, 1)
})

test('list rejects a file and a missing path with distinct codes', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)
  await assert.rejects(ops.list({ path: 'readme.md' }), (error) => error.code === 'GDRIVE_NOT_A_DIRECTORY')
  await assert.rejects(ops.list({ path: 'nope' }), (error) => error.code === 'GDRIVE_NOT_FOUND')
})

test('info distinguishes present and absent paths', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)
  const file = await ops.info({ path: 'readme.md' })
  assert.equal(file.exists, true)
  assert.equal(file.type, 'file')
  assert.equal(file.mime, 'text/markdown')
  const missing = await ops.info({ path: 'nope.txt' })
  assert.equal(missing.exists, false)
  assert.equal(missing.type, 'missing')
})

test('read windows text with line numbers', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)

  const whole = await ops.read({ path: 'readme.md' })
  assert.equal(whole.totalLines, 4)
  assert.equal(whole.lines[0].text, '# Drive')
  assert.equal(whole.truncated, false)

  const window = await ops.read({ path: 'readme.md', offset: 2, limit_lines: 2 })
  assert.deepEqual(window.lines, [
    { number: 2, text: '' },
    { number: 3, text: 'hello world' },
  ])
  assert.equal(window.truncated, true)
})

test('read refuses binary files and files above the read limit', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)
  await assert.rejects(ops.read({ path: 'Backups/blob.bin' }), (error) => error.code === 'GDRIVE_BINARY')

  const strict = opsFor(sandbox, { readMaxBytes: 16 })
  await assert.rejects(strict.read({ path: 'readme.md' }), (error) => error.code === 'GDRIVE_TOO_LARGE')
})

test('read rejects an offset past the end', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)
  await assert.rejects(ops.read({ path: 'readme.md', offset: 99 }), (error) => error.code === 'GDRIVE_INVALID_ARGS')
})

test('search matches names as substrings and globs', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)

  const substring = await ops.search({ query: 'todo' })
  assert.deepEqual(substring.matches.map((match) => match.path), [join(sandbox.drive, 'notes', 'todo.txt')])

  const glob = await ops.search({ query: '*.md' })
  assert.deepEqual(glob.matches.map((match) => match.path), [join(sandbox.drive, 'readme.md')])
})

test('search finds text inside files with line numbers', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)
  const result = await ops.search({ query: 'ship', mode: 'content' })
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].line, 2)
  assert.equal(result.matches[0].snippet, 'ship the plugin')
})

test('search caps results and reports truncation', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)
  const result = await ops.search({ query: 'o', max_results: 1 })
  assert.equal(result.matches.length, 1)
  assert.equal(result.truncated, true)
})

test('upload writes inline content and creates parents', async (t) => {
  const sandbox = await makeSandbox(t)
  const ops = opsFor(sandbox)
  const result = await ops.upload({ path: 'deep/nested/note.txt', content: 'hello\n' })
  assert.equal(result.bytes, 6)
  assert.equal(result.overwritten, false)
  assert.equal(await readFile(join(sandbox.drive, 'deep', 'nested', 'note.txt'), 'utf8'), 'hello\n')
})

test('upload refuses to clobber unless overwrite is set', async (t) => {
  const sandbox = await makeSandbox(t)
  const ops = opsFor(sandbox)
  await ops.upload({ path: 'note.txt', content: 'one' })
  await assert.rejects(ops.upload({ path: 'note.txt', content: 'two' }), (error) => error.code === 'GDRIVE_EXISTS')
  const replaced = await ops.upload({ path: 'note.txt', content: 'two', overwrite: true })
  assert.equal(replaced.overwritten, true)
  assert.equal(await readFile(join(sandbox.drive, 'note.txt'), 'utf8'), 'two')
})

test('upload copies a local file and rejects sources outside the local root', async (t) => {
  const sandbox = await makeSandbox(t)
  const ops = opsFor(sandbox)
  await writeFile(join(sandbox.local, 'payload.txt'), 'from local')
  const result = await ops.upload({ path: 'imported/payload.txt', source_path: 'payload.txt' })
  assert.equal(result.bytes, 10)
  assert.equal(await readFile(join(sandbox.drive, 'imported', 'payload.txt'), 'utf8'), 'from local')

  await assert.rejects(
    ops.upload({ path: 'x.txt', source_path: '/etc/hostname' }),
    (error) => error.code === 'GDRIVE_INVALID_PATH',
  )
})

test('upload needs exactly one of content and source_path', async (t) => {
  const sandbox = await makeSandbox(t)
  const ops = opsFor(sandbox)
  await assert.rejects(ops.upload({ path: 'a.txt' }), (error) => error.code === 'GDRIVE_INVALID_ARGS')
  await assert.rejects(
    ops.upload({ path: 'a.txt', content: 'x', source_path: 'y' }),
    (error) => error.code === 'GDRIVE_INVALID_ARGS',
  )
})

test('upload respects allowWrite', async (t) => {
  const sandbox = await makeSandbox(t)
  const ops = opsFor(sandbox, { allowWrite: false })
  await assert.rejects(ops.upload({ path: 'a.txt', content: 'x' }), (error) => error.code === 'GDRIVE_WRITE_DISABLED')
})

test('download copies into the local root and refuses to clobber', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)

  const result = await ops.download({ path: 'notes/todo.txt' })
  assert.equal(result.destPath, join(sandbox.local, 'todo.txt'))
  assert.equal(await readFile(result.destPath, 'utf8'), 'buy milk\nship the plugin\n')

  await assert.rejects(ops.download({ path: 'notes/todo.txt' }), (error) => error.code === 'GDRIVE_EXISTS')
  const again = await ops.download({ path: 'notes/todo.txt', overwrite: true })
  assert.equal(again.destPath, join(sandbox.local, 'todo.txt'))
})

test('download appends the file name when the destination is a directory', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  await mkdir(join(sandbox.local, 'inbox'), { recursive: true })
  const ops = opsFor(sandbox)
  const result = await ops.download({ path: 'readme.md', dest_path: 'inbox' })
  assert.equal(result.destPath, join(sandbox.local, 'inbox', 'readme.md'))
})

test('mkdir creates parents and is idempotent', async (t) => {
  const sandbox = await makeSandbox(t)
  await writeFile(join(sandbox.drive, 'readme.md'), '# Drive\n')
  const ops = opsFor(sandbox)
  const created = await ops.mkdir({ path: 'a/b/c' })
  assert.equal(created.created, true)
  const again = await ops.mkdir({ path: 'a/b/c' })
  assert.equal(again.created, false)
  await assert.rejects(ops.mkdir({ path: 'readme.md' }), (error) => error.code === 'GDRIVE_INVALID_ARGS')
})

test('move renames and honours overwrite', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)

  await ops.move({ from: 'readme.md', to: 'notes/readme.md' })
  await assert.rejects(access(join(sandbox.drive, 'readme.md')))
  assert.equal((await ops.info({ path: 'notes/readme.md' })).exists, true)

  await ops.upload({ path: 'taken.txt', content: 'x' })
  await assert.rejects(
    ops.move({ from: 'notes/readme.md', to: 'taken.txt' }),
    (error) => error.code === 'GDRIVE_EXISTS',
  )
  await ops.move({ from: 'notes/readme.md', to: 'taken.txt', overwrite: true })
  assert.equal(await readFile(join(sandbox.drive, 'taken.txt'), 'utf8'), '# Drive\n\nhello world\nsecond line\n')
})

test('delete requires confirmation and refuses the root', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)
  await assert.rejects(
    ops.delete({ path: 'readme.md' }),
    (error) => error.code === 'GDRIVE_CONFIRM_REQUIRED',
  )
  await assert.rejects(
    ops.delete({ path: '', confirm: true }),
    (error) => error.code === 'GDRIVE_INVALID_PATH',
  )
})

test('delete removes files, refuses non-empty directories, and supports recursive removal', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox)

  const file = await ops.delete({ path: 'readme.md', confirm: true })
  assert.equal(file.removed, 1)

  await assert.rejects(
    ops.delete({ path: 'notes', confirm: true }),
    (error) => error.code === 'GDRIVE_NOT_EMPTY',
  )
  const directory = await ops.delete({ path: 'notes', confirm: true, recursive: true })
  assert.equal(directory.type, 'directory')
  assert.equal((await ops.info({ path: 'notes' })).exists, false)
})

test('delete respects allowDelete', async (t) => {
  const sandbox = await makeSandbox(t)
  await seedDrive(sandbox.drive)
  const ops = opsFor(sandbox, { allowDelete: false })
  await assert.rejects(
    ops.delete({ path: 'readme.md', confirm: true }),
    (error) => error.code === 'GDRIVE_DELETE_DISABLED',
  )
})

test('every operation reports a missing mount instead of throwing ENOENT', async (t) => {
  const sandbox = await makeSandbox(t)
  const ops = opsFor({ ...sandbox, drive: join(sandbox.base, 'unmounted') })
  await assert.rejects(ops.list({}), (error) => error.code === 'GDRIVE_ROOT_MISSING')
})
