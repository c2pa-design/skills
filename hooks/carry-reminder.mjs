#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONVERTERS = /(^|[\s/;&|(])(sharp|cwebp|avifenc|ffmpeg|magick|convert|squoosh|squoosh-cli|gifsicle|vips|vipsthumbnail)(\s|$)/
const MEDIA = /\.(jpe?g|png|webp|avif|heic|heif|gif|tiff?|mp4|mov|m4a|mp3|wav)$/i
const RECENT_MS = 120_000
const CHECK_TIMEOUT_MS = 2_000
const SCAN_BYTES = 4 * 1024 * 1024

export function mediaTokens(command) {
  return command
    .split(/[\s"'=,]+/)
    .map((token) => token.replace(/^[(<>]+|[)<>;]+$/g, ''))
    .filter((token) => MEDIA.test(token))
}

function stat(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function looksSigned(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(SCAN_BYTES)
    const read = readSync(fd, buffer, 0, SCAN_BYTES, 0)
    const head = buffer.subarray(0, read)
    return head.includes('jumb') && head.includes('c2pa')
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function hasCredential(path, run = spawnSync) {
  const result = run('c2pa-check', [path, '--format', 'json', '--offline'], {
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
  })
  if (result.error || result.status === null) return looksSigned(path)
  try {
    const doc = JSON.parse(result.stdout)
    const first = Array.isArray(doc) ? doc[0] : doc
    const status = first?.result?.credential?.status ?? first?.credential?.status
    return Boolean(status) && status !== 'absent'
  } catch {
    return looksSigned(path)
  }
}

export function pairs(command, cwd, now = Date.now(), check = hasCredential) {
  if (!CONVERTERS.test(command)) return []
  const files = [...new Set(mediaTokens(command))]
    .map((token) => (isAbsolute(token) ? token : resolve(cwd, token)))
    .map((path) => ({ path, info: stat(path) }))
    .filter(({ info }) => info?.isFile())
  const written = files.filter(({ info }) => now - info.mtimeMs <= RECENT_MS)
  const sources = files.filter((file) => !written.includes(file) && check(file.path))
  if (sources.length === 0) return []
  return written.map(({ path }) => ({ source: sources[0].path, output: path }))
}

export function message(found) {
  const lines = found.map(
    ({ source, output }) => `npx -y c2pa-check carry --from ${JSON.stringify(source)} --to ${JSON.stringify(output)}`,
  )
  return [
    'The conversion you just ran wrote media from an original that carries a Content Credential.',
    'Re-encoding strips the credential. Carry it into the new file now:',
    ...lines,
    'If carry exits 1, report its reason to the user instead of retrying.',
  ].join('\n')
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw || '{}')
  const command = input?.tool_input?.command
  if (typeof command !== 'string') return
  const found = pairs(command, input.cwd || process.cwd())
  if (found.length === 0) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message(found) },
    }),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0))
}
