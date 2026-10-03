// Rendert die Folienbilder und Beispiel-Downloads der Website mit Deckwerk selbst: npm run folien (in website/)
// DW_REPO=<Pfad> rendert mit einem anderen Checkout, z. B. einer sauberen Kopie, wenn parallel am Code gearbeitet wird.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const site = fileURLToPath(new URL('..', import.meta.url))
const repo = resolve(process.env.DW_REPO ?? join(site, '..'))
const dest = join(site, 'src/assets/folien')
const downloads = join(site, 'public/beispiele')
const tmp = mkdtempSync(join(tmpdir(), 'dw-folien-'))
symlinkSync(join(repo, 'examples/assets'), join(tmp, 'assets')) // Bildpfade der Beispiele sind relativ zum Deck
for (const d of [dest, downloads]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }) }

// Auf die Website darf nichts Privates: findet sich in einem Beispiel wieder ein Name oder Kontakt, bricht das Skript ab.
// Folien ohne Bild (Platzhalter) fallen weg.
const PRIVAT = /\b(Besener|Christoph)\b|@|\+49/
const example = (name) => {
  const text = readFileSync(join(repo, 'examples', `${name}.json`), 'utf8')
  const fund = text.match(PRIVAT)
  if (fund) throw new Error(`examples/${name}.json enthält Privates: ${fund[0]}`)
  const deck = JSON.parse(text)
  return { ...deck, slides: deck.slides.filter((s) => !/"image":""/.test(JSON.stringify(s.content))) }
}

const THEMES = ['beratung', 'keynote', 'schweiz', 'redaktion', 'zen'] // CATALOG_THEMES in src/shared/themes.ts
const SIZES = { '1:1': { w: 1080, h: 1080 }, '9:16': { w: 720, h: 1280 }, a4: { w: 794, h: 1123 } } // FORMATS in src/shared/deck.ts
const OG = { title: 'Deckwerk', theme: { id: 'keynote' }, slides: [{ id: 'og', layout: 'cover', content: { eyebrow: 'Deckwerk', title: 'Ein Satz rein. Ein Deck raus.', subtitle: 'KI-Präsentationsstudio für Linux und macOS. Open Source.' } }] }

// Ganze Decks für Live-Demo und Galerie; dl: PPTX und PDF zum Herunterladen (die Foto-Decks sind dafür zu groß)
const DECKS = [{ name: 'strategie', dl: true }, { name: 'pitch' }, { name: 'quartal', dl: true }, { name: 'foto' }]
const JOBS = [
  ...DECKS.map((d) => ({ ...d, deck: example(d.name) })),
  ...THEMES.map((t) => ({ name: `look-${t}`, deck: example('strategie'), slides: [1, 5, 4], theme: { id: t } })),
  { name: 'format-16-9', deck: example('foto'), slides: [2] },
  ...Object.entries(SIZES).map(([f, size]) => ({ name: `format-${f.replace(':', '-')}`, deck: example('foto'), slides: [2], size })),
  { name: 'og', deck: OG, size: { w: 1200, h: 630 } },
  { name: 'pruefung', deck: example('quartal'), slides: [1, 2, 6, 2, 8], images: false }, // nur der Lint-Auszug: drei Listen hintereinander
]

const titleOf = (c = {}) => String(c.title ?? c.label ?? c.text ?? '').replace(/\*\*/g, '')
const manifest = { decks: {}, folien: {}, lint: [] }

for (const job of JOBS) {
  const deck = { ...job.deck, slides: job.slides ? job.slides.map((n) => job.deck.slides[n - 1]) : job.deck.slides }
  if (job.theme) deck.theme = job.theme
  if (job.size) deck.size = job.size
  const file = join(tmp, `${job.name}.json`)
  writeFileSync(file, JSON.stringify(deck))
  console.log(`→ ${job.name}`)
  const out = join(tmp, 'out', job.name)
  const log = execFileSync('sh', [join(repo, 'scripts/deckwerk.sh'), '--render', file, '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const lint = log.split('\n').filter((l) => /^[✗!] Folie/.test(l))
  if (job.images === false) { manifest.lint = lint; continue }
  if (lint.length) console.log(lint.join('\n'))
  const entries = readdirSync(out, { withFileTypes: true })
  const pngs = join(out, entries.find((e) => e.isDirectory()).name) // <out>/<slug(titel)>/NN.png, daneben .pptx und .pdf
  if (job.name === 'og') { await sharp(join(pngs, '01.png')).resize({ width: 1200 }).jpeg({ quality: 88 }).toFile(join(site, 'public/og.jpg')); continue }
  const ids = []
  for (const [i, slide] of deck.slides.entries()) {
    const id = `${job.name}-${i + 1}`
    await sharp(join(pngs, `${String(i + 1).padStart(2, '0')}.png`)).resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 90 }).toFile(join(dest, `${id}.webp`))
    manifest.folien[id] = { title: titleOf(slide.content), layout: slide.layout, theme: deck.theme.id, notes: slide.notes ?? '' }
    ids.push(id)
  }
  if (!DECKS.some((d) => d.name === job.name)) continue
  const dl = job.dl ? ['pptx', 'pdf'].map((ext) => {
    copyFileSync(join(out, entries.find((e) => e.name.endsWith(`.${ext}`)).name), join(downloads, `${job.name}.${ext}`))
    return `beispiele/${job.name}.${ext}`
  }) : []
  manifest.decks[job.name] = { title: deck.title, brief: deck.brief ?? {}, theme: deck.theme.id, slides: ids, dl }
}

writeFileSync(join(dest, 'folien.json'), JSON.stringify(manifest, null, 2) + '\n')
rmSync(tmp, { recursive: true, force: true })
console.log(`${Object.keys(manifest.folien).length} Folien nach ${dest}`)
