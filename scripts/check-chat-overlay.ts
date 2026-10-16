// Chat-Einblendung als ASS (Zeiten, Zeilen, Zusammenfassung): npx esbuild scripts/check-chat-overlay.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-chat-overlay.mjs && node ${TMPDIR:-/tmp}/check-chat-overlay.mjs
import assert from 'node:assert/strict'
import { chatAss, type ChatMsg } from '../src/main/chat-overlay'

const o = { size: { w: 1920, h: 1080 }, font: 'Inter' }
const sec = (ts: string) => { const [h, m, s] = ts.split(':').map(Number); return h * 3600 + m * 60 + s }
const parse = (e: string) => { const f = e.split(','); return { a: sec(f[1]), b: sec(f[2]), y: Number(/\\pos\(\d+,(\d+)\)/.exec(e)![1]), text: e.slice(e.indexOf('}') + 1) } }
const firsts = (ev: string[]) => ev.filter((e) => e.includes('\\fad(150')).map(parse) // erstes Erscheinen je Nachricht

// (a) Zeitverschiebung über 2 parts, zweiter mit speed 2; (b) außerhalb fällt weg
const parts = [{ start: 10, end: 20 }, { start: 100, end: 110, speed: 2 }]
const r = chatAss([{ t: 5, x: 'vorher' }, { t: 12, x: 'eins' }, { t: 104, x: 'zwei' }, { t: 50, x: 'dazwischen' }, { t: 120, x: 'danach' }], parts, o)
const f = firsts(r.events)
assert.deepEqual(f.map((e) => e.text), ['eins', 'zwei'])
assert.equal(f[0].a, 2); assert.equal(f[1].a, 12) // 10 + (104 − 100) / 2
assert.match(r.style, /^Style: Chat,Inter,\d+,&H00FFFFFF,/)
assert.equal(r.style.split(',').length, 23)

// (c) höchstens zeilen gleichzeitig sichtbar
const many: ChatMsg[] = Array.from({ length: 30 }, (_, i) => ({ t: 10 + i, x: `nachricht ${i}` }))
const ev = chatAss(many, [{ start: 0, end: 100 }], { ...o, zeilen: 4 }).events.map(parse)
for (let t = 0; t < 50; t += 0.25) assert.ok(ev.filter((e) => e.a <= t && t < e.b).length <= 4, `zu viele bei ${t}`)
assert.ok(ev.some((e) => e.a <= 20 && 20 < e.b && e.y < ev[0].y), 'ältere rücken nach oben')

// (d) LUL ×20 binnen weniger Sekunden → eine Zeile
const lul = chatAss(Array.from({ length: 20 }, (_, i) => ({ t: 1 + i * 0.15, x: i % 2 ? 'lul ' : 'LUL' })), [{ start: 0, end: 30 }], o).events
assert.equal(firsts(lul).length, 1); assert.match(lul[0], /LUL ×20$/)

// (e) Drossel: höchstens eine neue Nachricht je 0,5 s
const fast = firsts(chatAss([{ t: 1, x: 'a' }, { t: 1.2, x: 'b' }, { t: 1.4, x: 'c' }, { t: 1.6, x: 'd' }], [{ start: 0, end: 10 }], o).events)
assert.deepEqual(fast.map((e) => e.text), ['a', 'd'])

// (f) Namen nur auf Wunsch, dann in der (aufgehellten) Chat-Farbe
const named = [{ t: 1, n: 'Zuschauer', c: '#FFD700', x: 'hallo' }]
assert.ok(!chatAss(named, [{ start: 0, end: 10 }], o).events.join().includes('Zuschauer'))
assert.ok(chatAss(named, [{ start: 0, end: 10 }], { ...o, namen: true }).events[0].includes('{\\c&H00D7FF&}Zuschauer{\\c&HFFFFFF&}: hallo'))
assert.ok(chatAss([{ ...named[0], c: '#000080' }], [{ start: 0, end: 10 }], { ...o, namen: true }).events[0].includes('\\c&HC08080&'))

// (g) eingeschleuste Override-Tags werden entschärft
const inj = chatAss([{ t: 1, x: '{\\b1}fett\nneu' }], [{ start: 0, end: 10 }], o).events[0]
assert.ok(!inj.includes('{\\b1}') && inj.includes('\\{＼b1\\}fett neu'))

// (h) Hochformat: Spalte unter der Mitte; rechts bündig am rechten Rand
const hoch = chatAss([{ t: 1, x: 'hi' }], [{ start: 0, end: 10 }], { ...o, size: { w: 1080, h: 1920 }, pos: 'rechts' })
assert.ok(parse(hoch.events[0]).y > 960 && parse(hoch.events[0]).y < 1920 * 0.8)
assert.match(hoch.events[0], /\\pos\(1037,/); assert.match(hoch.style, /,3,0,0,0,1$/)

// lange Texte bleiben eine Zeile
assert.match(chatAss([{ t: 1, x: 'x'.repeat(200) }], [{ start: 0, end: 10 }], o).events[0], /\\q2.*x…$/)

// (i) leer bzw. ohne x → keine events
assert.deepEqual(chatAss([], parts, o).events, [])
assert.deepEqual(chatAss([{ t: 12 }, { t: 13, x: '  ' }], parts, o).events, [])

console.log('check-chat-overlay ok')
