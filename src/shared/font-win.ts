// Selbstprüfung: npx esbuild src/shared/font-win.ts --bundle --platform=node | DW_FONT_WIN_SELFTEST=1 node
// Win-Zeilenhöhe von Schriften für die Vorschau des Video-Exports. Ohne Electron/Node, läuft im Renderer.

// libass skaliert die ASS-Größe so, dass usWinAscent+usWinDescent der Schrift = Größe ergeben (nicht die em, wie CSS): em = Größe / win.
// Chromium kennt nur hhea (canvas.fontBoundingBox), das weicht bei den meisten Schriften ab. Darum die Win-Höhe (in em) der mitgelieferten TTFs fest, nach `embed` (assets/fonts).
// Neue Schrift in assets/fonts: der Selbsttest nennt den Wert.
export const WIN: Record<string, number> = { Archivo: 1.51, ArchivoBlack: 1.347, DMSans: 1.322, DMSerifDisplay: 1.371, Fraunces: 1.474, IBMPlexMono: 1.3, IBMPlexSans: 1.395, IBMPlexSerif: 1.436, InstrumentSerif: 1.3, Inter: 1.43, Lora: 1.5, Manrope: 1.366, PlayfairDisplay: 1.41, PlusJakartaSans: 1.652, SourceSans3: 1.222, SourceSerif4: 1.333, SpaceGrotesk: 1.442 }

/** (usWinAscent + usWinDescent) / unitsPerEm einer TTF in em; undefined bei kaputter Datei, fehlender Tabelle oder Summe 0 (libass nimmt dann hhea). */
export function winOfTtf(buf: ArrayBuffer): number | undefined {
  try {
    const v = new DataView(buf)
    const at = (name: string) => { // Tabellenverzeichnis: je 16 Byte ab 12, Tag @0, Offset @8
      for (let i = 0; i < v.getUint16(4); i++) if (String.fromCharCode(...[0, 1, 2, 3].map((k) => v.getUint8(12 + i * 16 + k))) === name) return v.getUint32(12 + i * 16 + 8)
    }
    const os = at('OS/2'), head = at('head')
    if (os === undefined || head === undefined) return undefined
    const win = v.getUint16(os + 74) + v.getUint16(os + 76), upem = v.getUint16(head + 18)
    return win && upem ? win / upem : undefined
  } catch { return undefined }
}

if (typeof process !== 'undefined' && process.env.DW_FONT_WIN_SELFTEST) {
  void (async () => {
    const assert: typeof import('node:assert/strict') = process.getBuiltinModule('node:assert/strict') // Typ explizit: tsc verlangt ihn für assert-Aufrufe
    const fs = process.getBuiltinModule('node:fs') // getBuiltinModule statt import: das Renderer-Bündel zieht kein node:* mit
    const dir = `${process.cwd()}/assets/fonts/` // vom Projektstamm aus aufrufen
    const stems = new Set<string>()
    for (const f of fs.readdirSync(dir).filter((x: string) => x.endsWith('.ttf'))) {
      const b = fs.readFileSync(dir + f), win = winOfTtf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
      const stem = f.replace(/-(Regular|Bold|Italic|BoldItalic)\.ttf$/, '')
      stems.add(stem)
      assert.ok(win !== undefined && Math.abs((WIN[stem] ?? -1) - win) < 0.0006, `${f}: WIN.${stem} = ${WIN[stem]}, TTF = ${win?.toFixed(3)}`)
    }
    const { FONTS } = await import('./themes')
    for (const [n, f] of Object.entries(FONTS)) assert.ok(!f.embed || f.embed in WIN, `FONTS['${n}'].embed '${f.embed}' fehlt in WIN`)
    for (const k of Object.keys(WIN)) assert.ok(stems.has(k), `WIN.${k} hat keine TTF`)
    assert.equal(winOfTtf(new ArrayBuffer(0)), undefined, 'leer')
    assert.equal(winOfTtf(new Uint8Array(200).fill(255).buffer), undefined, 'kaputt')
    assert.equal(winOfTtf(new Uint8Array(12).buffer), undefined, 'ohne Tabellen')
    console.log('font-win ok')
  })()
}
