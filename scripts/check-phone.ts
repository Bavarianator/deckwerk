// npx esbuild scripts/check-phone.ts --bundle --platform=node --format=esm --outfile=out/check-phone.mjs && node out/check-phone.mjs
// Spracherkennung und ffmpeg auf dem Handy (phone.ts, phone-ffmpeg.ts): Geräteliste, .deb-Eintrag, Ergebniszeilen, WAV-Kopf,
// Pfade und Quoting für die Geräte-Shell, Quell-Cache – ohne Handy und Netz
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { arMember, parseDevices, parseResults, wav } from '../src/main/phone'
import { phoneArgs, quote, stale } from '../src/main/phone-ffmpeg'

assert.deepEqual(parseDevices('List of devices attached\nR5CN30PBM0R            device usb:1-3 product:y2sxeea model:SM_G986B device:y2s transport_id:1\nZY22 unauthorized usb:1-4 transport_id:2\n192.168.1.5:5555 device product:x model:Pixel_8 transport_id:3\n'),
  [{ serial: 'R5CN30PBM0R', model: 'SM G986B' }, { serial: '192.168.1.5:5555', model: 'Pixel 8' }])
assert.deepEqual(parseDevices('List of devices attached\n\n'), [])

// ar: Kopf + Einträge mit 60-Byte-Kopf, ungerade Größen aufgefüllt
const entry = (name: string, data: string) => Buffer.concat([Buffer.from(name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(data.length).padEnd(10) + '`\n', 'latin1'), Buffer.from(data + (data.length % 2 ? '\n' : ''), 'latin1')])
const deb = Buffer.concat([Buffer.from('!<arch>\n'), entry('debian-binary', '2.0\n'), entry('control.tar.xz', 'abc'), entry('data.tar.xz/', 'DATA')])
assert.equal(arMember(deb, 'data.tar').toString(), 'DATA')
assert.throws(() => arMember(deb, 'fehlt'))

// eine Zeile je Datei; nan/inf nur in Zahlenlisten ersetzt, nicht im Text
const r = parseResults('{"text": "nan inf Banane", "timestamps": [0.1, -nan, inf], "durations": [nan], "tokens": ["▁x"]}\nnum threads: 4\n{"text": "", "timestamps": [], "tokens": []}\n')
assert.equal(r.length, 2)
assert.deepEqual([r[0].text, r[0].timestamps, r[0].durations], ['nan inf Banane', [0.1, null, null], [null]])

const w = wav(new Float32Array([0, 1, -1, 2]))
assert.equal(w.length, 44 + 8)
assert.equal(w.toString('latin1', 0, 4) + w.toString('latin1', 8, 12), 'RIFFWAVE')
assert.deepEqual([w.readUInt32LE(24), w.readInt16LE(46), w.readInt16LE(48), w.readInt16LE(50)], [16000, 32767, -32767, 32767])
// Quelle → Cache, Ausgabe unter cwd → entfernter cwd, Filtergraph und lavfi bleiben; ein Ordner „/job-2“ neben cwd gilt nicht als darunter
const src = new Map([['/home/u/Videos/stream.mkv', '/data/local/tmp/deckwerk/src/ab.mkv']])
const graph = "[0:v]setpts=PTS-STARTPTS[v0];[v0]ass=szene-01-01.ass:fontsdir=fonts,drawtext=text='it''s':x=4[v]"
assert.deepEqual(phoneArgs(['-ss', '1.000', '-i', '/home/u/Videos/stream.mkv', '-f', 'lavfi', '-i', 'anullsrc', '-i', '/tmp/job/a/still.png', '-i', '/tmp/job-2/x.png', '-filter_complex', graph, '/tmp/job/szene-01-01.mkv'], '/tmp/job', '/R/export/job', src),
  ['-ss', '1.000', '-i', '/data/local/tmp/deckwerk/src/ab.mkv', '-f', 'lavfi', '-i', 'anullsrc', '-i', '/R/export/job/a/still.png', '-i', '/tmp/job-2/x.png', '-filter_complex', graph, '/R/export/job/szene-01-01.mkv'])

// Quoting: die Shell gibt jedes Argument unverändert zurück (Filtergraph mit ; [ ] : , ' = und Leerzeichen, leeres Argument)
const tricky = [graph, "a'b''c", '', ' $HOME `x` "y" \\n *', 'ass=t.ass:fontsdir=fonts']
assert.deepEqual(execFileSync('sh', ['-c', `printf '%s\\0' ${tricky.map(quote).join(' ')}`]).toString().split('\0').slice(0, -1), tricky)

// Quell-Cache: gebrauchte bleiben, dazu die jüngsten bis insgesamt 2
const cached = [{ path: 'a', t: 1 }, { path: 'b', t: 3 }, { path: 'c', t: 2 }]
assert.deepEqual(stale(cached, ['x']).sort(), ['a', 'c'])
assert.deepEqual(stale(cached, ['a']).sort(), ['c'])
assert.deepEqual(stale(cached, ['a', 'x']).sort(), ['b', 'c'])
assert.deepEqual(stale([], ['x']), [])
console.log('check-phone: ok')
