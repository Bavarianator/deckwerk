// Schnittliste als Final-Cut-7-XML (ohne ffmpeg): npx esbuild scripts/check-xmeml.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-xmeml.mjs && node ${TMPDIR:-/tmp}/check-xmeml.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clipMarks, xmeml } from '../src/main/export-xmeml'
import { partsLength, type Part } from '../src/shared/video'

const num = (xml: string, tag: string) => Number(new RegExp(`<${tag}>(-?\\d+)</${tag}>`).exec(xml)?.[1])
const items = (track: string) => [...track.matchAll(/<clipitem id="[^"]+"[^>]*>([\s\S]*?)<\/clipitem>/g)].map((m) => ({ body: m[1], start: num(m[1], 'start'), end: num(m[1], 'end'), in: num(m[1], 'in'), out: num(m[1], 'out') }))
const videoTrack = (xml: string) => xml.slice(xml.indexOf('<track>'), xml.indexOf('</track>'))

// Quelle 25 fps; Ausschnitt 2 mit Tempo 2, Ausschnitt 3 mit 1 s Standbild
const src = '/home/nutzer/Videos/Kunden & Partner/roh 01.mp4', info = { duration: 60, w: 1920, h: 1080, fps: 25, audio: true }
const parts: Part[] = [{ start: 2, end: 6 }, { start: 10, end: 14, speed: 2 }, { start: 20, end: 23.5, freeze: 1 }]
const overlays = [{ start: 11, end: 12, art: 'bauchbinde' as const, text: 'Anna', sub: 'Leitung <Vertrieb>' }]
const total = partsLength(parts), name = 'Kunden & Partner – Clip 01'
const xml = xmeml({ name, size: { w: 1080, h: 1920 }, duration: total, scenes: [{ at: 0, src, info, parts, marks: clipMarks('Hook „A“ & B', overlays, parts) }] })

const seqDur = num(xml.slice(xml.indexOf('<sequence')), 'duration')
assert.equal(seqDur, Math.round(total * 30), 'Sequenzdauer = round(partsLength · 30)')
assert.match(xml, /<xmeml version="5">/)
const vs = items(videoTrack(xml))
assert.equal(vs.length, 3, 'drei clipitems in V1')
const freeze = 30
assert.equal(vs.reduce((s, x) => s + x.end - x.start, 0) + freeze, seqDur, 'clipitems + Standbild-Lücke = Sequenzdauer')
assert.equal(vs[0].start, 0, 'Spur beginnt bei 0')
for (let i = 1; i < vs.length; i++) assert.equal(vs[i].start, vs[i - 1].end, `clipitem ${i + 1} schließt lückenlos an`)
assert.equal(seqDur - vs[2].end, freeze, 'Lücke fürs Standbild am Ende')
// in/out in Bildern der Quelle (25 fps), mit Tempo in umgerechneter Zeit (Quellbild / Tempo) wie Premiere/FCP 7
parts.forEach((p, i) => {
  const sp = p.speed ?? 1
  assert.equal(vs[i].in, Math.round((p.start * 25) / sp), `in Ausschnitt ${i + 1}`)
  assert.ok(Math.abs(vs[i].out - Math.round((p.end * 25) / sp)) <= 1, `out Ausschnitt ${i + 1}: ${vs[i].out}`)
  assert.equal(vs[i].out - vs[i].in, Math.round(((vs[i].end - vs[i].start) * 25) / 30), `out − in = Spurlänge in Quellbildern (${i + 1})`)
})
assert.match(vs[0].body, /<timebase>25<\/timebase><ntsc>FALSE<\/ntsc>/, '25 fps → timebase 25')
// Tempo: Time Remap nur am zweiten Ausschnitt (Video und beide Tonspuren)
assert.ok(!/timeremap/.test(vs[0].body) && !/timeremap/.test(vs[2].body), 'ohne Tempo kein Time Remap')
assert.match(vs[1].body, /<effectid>timeremap<\/effectid>[\s\S]*<parameterid>variablespeed<\/parameterid>[\s\S]*?<value>0<\/value>[\s\S]*<parameterid>speed<\/parameterid>[\s\S]*?<value>200<\/value>[\s\S]*<parameterid>reverse<\/parameterid>[\s\S]*?<value>FALSE<\/value>/, 'Time Remap 200 %')
assert.equal(xml.match(/<effectid>timeremap<\/effectid>/g)?.length, 3, 'Time Remap auf V1, A1, A2')
// Stereo: A1/A2 mit je drei verlinkten clipitems, Datei einmal beschrieben
const audio = xml.slice(xml.indexOf('<audio>\n'), xml.lastIndexOf('</audio>'))
assert.equal(items(audio).length, 6, 'je Kanal eine Tonspur')
assert.equal(xml.match(/<link>/g)?.length, 9 * 3, 'jedes clipitem verlinkt V1, A1, A2')
assert.equal(xml.match(/<pathurl>/g)?.length, 1, 'file nur einmal voll, sonst per id')
assert.match(xml, /<pathurl>file:\/\/localhost\/home\/nutzer\/Videos\/Kunden%20&amp;%20Partner\/roh%2001\.mp4<\/pathurl>/, 'pathurl prozent-kodiert')
// Escape und Marker
assert.ok(xml.includes('<name>Kunden &amp; Partner – Clip 01</name>') && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'Titel mit & escaped')
assert.ok(xml.includes('<comment>Hook „A“ &amp; B</comment><name>Hook</name><in>0</in><out>120</out>'), 'Hook-Marker ab 0')
assert.ok(xml.includes('<comment>Anna · Leitung &lt;Vertrieb&gt;</comment><name>Einblendung bauchbinde</name><in>135</in><out>150</out>'), 'Einblendung in Clip-Zeit (Tempo 2)')
assert.ok(xml.includes(`<name>Standbild</name><in>${vs[2].end}</in><out>${seqDur}</out>`), 'Standbild-Marker über der Lücke')

// Bildraten: 29,97 → 30 NTSC, fehlt → 30
const rateOf = (fps?: number) => videoTrack(xmeml({ name: 'x', size: { w: 1920, h: 1080 }, duration: 1, scenes: [{ at: 0, src: '/a.mp4', info: { duration: 5, w: 1920, h: 1080, fps }, parts: [{ start: 0, end: 1 }] }] })).match(/<clipitem[\s\S]*?<rate>([\s\S]*?)<\/rate>/)![1]
assert.equal(rateOf(29.97), '<timebase>30</timebase><ntsc>TRUE</ntsc>', '29,97 → ntsc TRUE')
assert.equal(rateOf(59.94), '<timebase>60</timebase><ntsc>TRUE</ntsc>', '59,94 → 60 ntsc TRUE')
assert.equal(rateOf(undefined), '<timebase>30</timebase><ntsc>FALSE</ntsc>', 'ohne fps 30')

// Zwei Szenen mit Folienblende (0,5 s Überlappung) und Standbild-Folie dazwischen: keine Überlappung in der Spur, Ton fehlt bei der zweiten Quelle
const b: Part[] = [{ start: 0, end: 2 }]
const two = xmeml({ name: 'mp4', size: { w: 1920, h: 1080 }, duration: 4 + 3 + 2 - 0.5, scenes: [
  { at: 0, src: '/a.mp4', info: { duration: 10, w: 1920, h: 1080, fps: 30, audio: true }, parts: [{ start: 0, end: 4 }] },
  { at: 7 - 0.5, src: '/b.mp4', info: { duration: 10, w: 1920, h: 1080, fps: 30, audio: false }, parts: b },
] })
const tv = items(videoTrack(two))
assert.deepEqual(tv.map((x) => [x.start, x.end, x.in, x.out]), [[0, 120, 0, 120], [195, 255, 0, 60]], 'zwei Szenen, Standbild-Folie als Lücke')
assert.equal(items(two.slice(two.indexOf('<audio>\n'))).length, 2, 'Quelle ohne Ton: nur ein Ton-clipitem je Kanal')
const blend = xmeml({ name: 'blende', size: { w: 1920, h: 1080 }, duration: 4 + 2 - 0.5, scenes: [
  { at: 0, src: '/a.mp4', info: { duration: 10, w: 1920, h: 1080 }, parts: [{ start: 0, end: 4 }] },
  { at: 3.5, src: '/a.mp4', info: { duration: 10, w: 1920, h: 1080 }, parts: [{ start: 5, end: 7 }] },
] })
assert.deepEqual(items(videoTrack(blend)).map((x) => [x.start, x.end, x.in, x.out]), [[0, 105, 0, 105], [105, 165, 150, 210]], 'Blende: harter Schnitt am Anfang')

const dir = process.env.TMPDIR ?? tmpdir(), file = join(dir, 'check-xmeml.xml')
mkdirSync(dir, { recursive: true })
writeFileSync(file, xml)
execFileSync('xmllint', ['--noout', file], { stdio: 'inherit' })
writeFileSync(file, two)
execFileSync('xmllint', ['--noout', file], { stdio: 'inherit' })
console.log('check-xmeml: alles grün', file)
