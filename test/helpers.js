/**
 * Shared test fixtures: two throwaway directories, one standing in for the rclone mount and one
 * for the local workspace.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create `drive/` and `local/` under one temp directory and register cleanup on the test.
 * @param {import('node:test').TestContext} t
 */
export async function makeSandbox(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-gdrive-'))
  const drive = join(base, 'drive')
  const local = join(base, 'local')
  await mkdir(drive, { recursive: true })
  await mkdir(local, { recursive: true })
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })
  return { base, drive, local }
}

/**
 * Seed a small tree: two directories, a text file and a binary blob.
 * @param {string} drive
 */
export async function seedDrive(drive) {
  await mkdir(join(drive, 'Backups'), { recursive: true })
  await mkdir(join(drive, 'notes'), { recursive: true })
  await writeFile(join(drive, 'readme.md'), '# Drive\n\nhello world\nsecond line\n')
  await writeFile(join(drive, 'notes', 'todo.txt'), 'buy milk\nship the plugin\n')
  await writeFile(join(drive, 'Backups', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
}
