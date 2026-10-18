// Medienpool, reine Teile (Drop-Quellen, Art einer Quelle): npx esbuild scripts/check-media.ts --bundle --platform=node --format=esm --loader:.css=empty --outfile=${TMPDIR:-/tmp}/check-media.mjs && node ${TMPDIR:-/tmp}/check-media.mjs
import { deepStrictEqual as eq, ok } from 'node:assert'
import { MEDIA_MIME, isAudioSrc, isImageSrc, srcFromDrop } from '../src/renderer/ui/timeline/media'

;(globalThis as any).window = { api: { pathOf: (f: { path: string }) => f.path } }
const dt = (data: Record<string, string>, files: { path: string }[]) => ({ getData: (t: string) => data[t] ?? '', files }) as unknown as DataTransfer

const pool = 'asset://local/home/u/DeckwerkPro/assets/a%20b.mp4'
eq(srcFromDrop(dt({ [MEDIA_MIME]: pool }, [{ path: '/home/u/Musik/lied.mp3' }, { path: '/home/u/notiz.txt' }, { path: '/home/u/Bild #1.png' }])), [
  pool, 'asset://local/home/u/Musik/lied.mp3', 'asset://local/home/u/Bild%20%231.png',
])
eq(srcFromDrop(dt({ [MEDIA_MIME]: `${pool}\n${pool}\nasset://local/x/font.ttf` }, [])), [pool], 'doppelt und Schrift fallen weg')
eq(srcFromDrop(dt({ 'text/plain': pool }, [])), [], 'nur MEDIA_MIME zählt')

ok(isAudioSrc('asset://local/a/b.WAV') && isAudioSrc('/a/b.m4a') && !isAudioSrc(pool))
ok(isImageSrc('asset://local/a/b.jpeg') && isImageSrc('/a/b.webp') && !isImageSrc(pool) && !isImageSrc('/a/b.mp3'))
console.log('check-media: ok')
