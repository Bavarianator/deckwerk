// Firmenvorlage → Brand-Kit: npx esbuild scripts/check-potx.ts --bundle --platform=node --format=esm --outfile=$SCRATCH/check-potx.mjs && node $SCRATCH/check-potx.mjs (Ausgabe außerhalb von out/)
import { deepStrictEqual as eq, rejects } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { brandFromPotx } from '../src/main/potx'

const dir = await mkdtemp(join(tmpdir(), 'check-potx-'))
try {
  const pres = new PptxGenJS()
  pres.addSlide().addText('x', { x: 1, y: 1 })
  const base = join(dir, 'base.pptx')
  await writeFile(base, (await pres.write({ outputType: 'nodebuffer' })) as Buffer)

  const patch = async (out: string, fix: (xml: string) => string) => {
    const zip = await JSZip.loadAsync(await readFile(base))
    const p = Object.keys(zip.files).find((n) => /ppt\/theme\/theme1\.xml$/.test(n))!
    zip.file(p, fix(await zip.file(p)!.async('string')))
    const f = join(dir, out)
    await writeFile(f, await zip.generateAsync({ type: 'nodebuffer' }))
    return f
  }
  const setClr = (xml: string, slot: string, inner: string) => xml.replace(new RegExp(`<a:${slot}>[\\s\\S]*?</a:${slot}>`), `<a:${slot}>${inner}</a:${slot}>`)
  const setFont = (xml: string, grp: string, face: string) => xml.replace(new RegExp(`(<a:${grp}>\\s*<a:latin typeface=")[^"]*`), `$1${face}`)

  const f1 = await patch('a.potx', (x) => setFont(setFont(setClr(setClr(x, 'accent1', '<a:srgbClr val="c0392b"/>'), 'accent2', '<a:sysClr val="windowText" lastClr="112233"/>'), 'majorFont', 'Georgia'), 'minorFont', 'Firmenschrift Sans XY'))
  const r = await brandFromPotx(f1)
  eq(r.kit, { primary: '#C0392B', secondary: '#112233', headFont: 'Georgia' })
  eq(r.skipped, ['Firmenschrift Sans XY'])

  const f2 = await patch('b.pptx', (x) => x.replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, ''))
  await rejects(brandFromPotx(f2), /accent1/)
  await writeFile(join(dir, 'c.potx'), 'kein zip')
  await rejects(brandFromPotx(join(dir, 'c.potx')), /keine gültige/)
  console.log('check-potx ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
