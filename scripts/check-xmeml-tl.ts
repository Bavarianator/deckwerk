// Mehrspur-Timeline als Final-Cut-7-XML: npx esbuild scripts/check-xmeml-tl.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-xmeml-tl.mjs && node ${TMPDIR:-/tmp}/check-xmeml-tl.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { xmemlTimeline } from '../src/main/export-xmeml-tl'
import type { TLClip, TimelineContent } from '../src/shared/timeline'

const num = (xml: string, tag: string) => Number(new RegExp(`<${tag}>(-?\\d+)</${tag}>`).exec(xml)?.[1])
const items = (track: string) => [...track.matchAll(/<clipitem id="[^"]+"[^>]*>([\s\S]*?)<\/clipitem>/g)].map((m) => ({ body: m[1], start: num(m[1], 'start'), end: num(m[1], 'end'), in: num(m[1], 'in'), out: num(m[1], 'out') }))
const tracks = (xml: string, kind: 'video' | 'audio') => {
  const part = xml.slice(xml.indexOf(`<${kind}>\n`), xml.indexOf(`</${kind}>\n`))
  return [...part.matchAll(/<track[^>]*>([\s\S]*?)<\/track>/g)].map((m) => m[1])
}

const A = '/home/nutzer/Videos/Kunden & Partner/a.mp4', B = '/home/nutzer/Videos/b.mp4', M = '/home/nutzer/Musik/musik.mp3'
const info = { [A]: { duration: 120, w: 1920, h: 1080, fps: 29.97 }, [B]: { duration: 60, w: 1920, h: 1080, fps: 25 }, [M]: { duration: 200, w: 0, h: 0 } }

// 100 Clips à 1/3 s bei 29,97 auf V1: kein Drift
const many: TLClip[] = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, src: A, at: i / 3, in: i / 3, out: (i + 1) / 3 }))
const tl: TimelineContent = {
  tracks: [
    { id: 'v1', kind: 'video', clips: many },
    { id: 'v2', kind: 'video', hide: true, clips: [{ id: 'p', src: B, at: 2, in: 10, out: 14, speed: 2 }, { id: 'q', src: B, at: 5, in: 0, out: 1, mute: true }] },
    { id: 'a1', kind: 'audio', clips: [{ id: 'm', src: M, at: 0, in: 0, out: 30 }] },
  ],
  markers: [{ t: 10, name: 'Refrain & Schluss' }, { t: 1, name: 'Start' }],
}
const xml = xmemlTimeline(tl, { name: 'Kunden & Partner', fps: 29.97, w: 1920, h: 1080, info })
assert.match(xml, /<xmeml version="5">/)
assert.match(xml.slice(xml.indexOf('<sequence'), xml.indexOf('<media>')), /<timebase>30<\/timebase><ntsc>TRUE<\/ntsc>/, '29,97 → 30 NTSC')

const vt = tracks(xml, 'video'), at = tracks(xml, 'audio')
assert.equal(vt.length, 2, 'V1, V2')
assert.equal(at.length, 6, 'Stereo-Paare: Ton V1, Ton V2, Audiospur')
assert.match(vt[1], /<enabled>FALSE<\/enabled><locked>/, 'hide → Spur aus')

const fps = 30000 / 1001, v1 = items(vt[0])
assert.equal(v1.length, 100)
assert.equal(v1[99].end, Math.round((100 / 3) * fps), 'letztes end = round(Gesamt · fps)')
for (let i = 1; i < v1.length; i++) assert.equal(v1[i].start, v1[i - 1].end, `clipitem ${i + 1} lückenlos`)
assert.equal(num(xml.slice(xml.indexOf('<sequence')), 'duration'), v1[99].end, 'Sequenzdauer')

// Tempo 2: Time Remap am Bild und an beiden Tonkanälen; mute: zweiter V2-Clip ohne Ton
const v2 = items(vt[1])
assert.match(v2[0].body, /<effectid>timeremap<\/effectid>[\s\S]*<parameterid>speed<\/parameterid>[\s\S]*?<value>200<\/value>/, 'Time Remap 200 %')
assert.ok(!/timeremap/.test(v2[1].body), 'ohne Tempo kein Time Remap')
assert.equal(xml.match(/<effectid>timeremap<\/effectid>/g)?.length, 3, 'Time Remap auf V2, A3, A4')
assert.equal(v2[0].in, Math.round((10 * 25) / 2), 'in mit Tempo in umgerechneter Zeit')
assert.equal(items(at[2]).length, 1, 'stummer Clip ohne Ton-clipitem')
assert.equal(items(at[0]).length, 100, 'Ton von V1 auf A1')
assert.match(v1[0].body, /<link><linkclipref>[^<]+<\/linkclipref><mediatype>audio<\/mediatype><trackindex>2<\/trackindex>/, 'Bild verlinkt mit Ton')

// file: jede id genau einmal voll
const full = [...xml.matchAll(/<file id="(file-\d+)">/g)].map((m) => m[1])
assert.equal(full.length, 3, 'drei Quellen')
assert.equal(new Set(full).size, full.length, 'jede file-id einmal voll')
assert.equal(xml.match(/<pathurl>/g)?.length, 3)
for (const m of xml.matchAll(/<file id="(file-\d+)"\/>/g)) assert.ok(full.includes(m[1]), `${m[1]} definiert`)
assert.match(xml, /<pathurl>file:\/\/localhost\/home\/nutzer\/Videos\/Kunden%20&amp;%20Partner\/a\.mp4<\/pathurl>/, 'pathurl prozent-kodiert')

// Marker sortiert, escaped
assert.ok(xml.indexOf('<name>Start</name><in>30</in>') < xml.indexOf('<name>Refrain &amp; Schluss</name><in>300</in>'), 'Marker sortiert')

const dir = process.env.TMPDIR ?? tmpdir(), file = join(dir, 'check-xmeml-tl.xml')
mkdirSync(dir, { recursive: true })
writeFileSync(file, xml)
execFileSync('xmllint', ['--noout', file], { stdio: 'inherit' })
console.log('check-xmeml-tl: ok')
