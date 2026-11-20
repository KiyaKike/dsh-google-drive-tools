import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  confinePath,
  formatBytes,
  guessMimeType,
  looksBinary,
  resolveRoot,
} from '../src/paths.js'
import { makeSandbox } from './helpers.js'

test('resolveRoot returns the canonical directory', async (t) => {
  const { drive } = await makeSandbox(t)
  assert.equal(await resolveRoot(drive), drive)
})

test('resolveRoot explains a missing mount', async (t) => {
  const { base } = await makeSandbox(t)
  await assert.rejects(resolveRoot(join(base, 'absent')), (error) => {
    assert.equal(error.code, 'GDRIVE_ROOT_MISSING')
    assert.match(error.message, /rclone mount/)
    return true
  })
})

test('confinePath maps relative and root-relative input onto the root', async (t) => {
  const { drive } = await makeSandbox(t)
  const root = await resolveRoot(drive)
  assert.equal(await confinePath(root, undefined), root)
  assert.equal(await confinePath(root, ''), root)
  assert.equal(await confinePath(root, '/'), root)
  assert.equal(await confinePath(root, 'notes/todo.txt'), join(root, 'notes', 'todo.txt'))
  assert.equal(await confinePath(root, 'notes/../readme.md'), join(root, 'readme.md'))
})

test('confinePath refuses traversal and absolute paths outside the root', async (t) => {
  const { drive } = await makeSandbox(t)
  const root = await resolveRoot(drive)
  await assert.rejects(confinePath(root, '../escape.txt'), (error) => {
    assert.equal(error.code, 'GDRIVE_INVALID_PATH')
    return true
  })
  await assert.rejects(confinePath(root, '/etc/passwd'), (error) => {
    assert.equal(error.code, 'GDRIVE_INVALID_PATH')
    return true
  })
})

test('confinePath refuses a symlink that leaves the root', async (t) => {
  const { base, drive } = await makeSandbox(t)
  const outside = join(base, 'outside')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(outside, join(drive, 'escape-link'))
  const root = await resolveRoot(drive)
  await assert.rejects(confinePath(root, 'escape-link/secret.txt'), (error) => {
    assert.equal(error.code, 'GDRIVE_INVALID_PATH')
    return true
  })
})

test('confinePath rejects NUL bytes', async (t) => {
  const { drive } = await makeSandbox(t)
  const root = await resolveRoot(drive)
  await assert.rejects(confinePath(root, 'a\0b'), /NUL/)
})

test('looksBinary separates text from binary samples', () => {
  assert.equal(looksBinary(Buffer.from('hello world\n')), false)
  assert.equal(looksBinary(Buffer.from('中文内容\n')), false)
  assert.equal(looksBinary(Buffer.from([0, 1, 2, 3])), true)
  assert.equal(looksBinary(Buffer.from([0xff, 0xfe, 0xfd])), true)
  assert.equal(looksBinary(Buffer.alloc(0)), false)
})

test('guessMimeType maps known extensions', () => {
  assert.equal(guessMimeType('/a/b.md'), 'text/markdown')
  assert.equal(guessMimeType('report.PDF'), 'application/pdf')
  assert.equal(guessMimeType('archive.tar.gz'), 'application/gzip')
  assert.equal(guessMimeType('no-extension'), undefined)
})

test('formatBytes stays readable across units', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB')
  assert.equal(formatBytes(Number.NaN), '?')
})
