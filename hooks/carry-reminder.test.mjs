import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONVERTERS, mediaTokens, pairs, message } from './carry-reminder.mjs'

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'carry-reminder-'))
  const old = Date.now() / 1000 - 3600
  writeFileSync(join(dir, 'hero.png'), 'png')
  utimesSync(join(dir, 'hero.png'), old, old)
  writeFileSync(join(dir, 'hero.webp'), 'webp')
  return dir
}

test('only conversion commands are considered', () => {
  assert.ok(CONVERTERS.test('cwebp -q 80 hero.png -o hero.webp'))
  assert.ok(CONVERTERS.test('npx sharp -i a.png -o a.webp'))
  assert.ok(!CONVERTERS.test('ls hero.png'))
  assert.ok(!CONVERTERS.test('git convertible hero.png'))
})

test('media tokens come out of quotes and redirections', () => {
  assert.deepEqual(mediaTokens('magick "in put.png" -resize 50% out.webp > log.txt'), ['put.png', 'out.webp'])
  assert.deepEqual(mediaTokens('ffmpeg -i=clip.mov clip.mp4'), ['clip.mov', 'clip.mp4'])
})

test('a signed source and a freshly written output make one reminder', () => {
  const dir = workspace()
  const found = pairs('cwebp hero.png -o hero.webp', dir, Date.now(), () => true)

  assert.deepEqual(found, [{ source: join(dir, 'hero.png'), output: join(dir, 'hero.webp') }])
  assert.match(message(found), /c2pa-check carry --from ".*hero\.png" --to ".*hero\.webp"/)
})

test('an unsigned source produces nothing', () => {
  const dir = workspace()

  assert.deepEqual(pairs('cwebp hero.png -o hero.webp', dir, Date.now(), () => false), [])
})

test('a non-conversion command never triggers', () => {
  const dir = workspace()

  assert.deepEqual(pairs('cp hero.png hero.webp', dir, Date.now(), () => true), [])
})
