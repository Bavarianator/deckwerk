// Injiziert <p:transition> und <p:timing> in die Slide-XML einer PptxGenJS-Datei.
// Die XML-Struktur folgt dem, was PowerPoint selbst schreibt (mainSeq → Klick-Gruppe → after-Kette → Effekt).
import JSZip from 'jszip'

// float = „Einschweben“ (von unten), wipe = von links, pan/drift = von links (Canva Schwenken/Treiben), baseline = steigt
// von unten auf, appear = sofort sichtbar (mit by: 'letter' die Schreibmaschine), pulse = Betonung im Dauerlauf (Canva Atmen)
// grow = langsames Vergrößern als Betonung (Canva Foto-Zoom)
export type Effect = 'fade' | 'float' | 'pan' | 'drift' | 'pop' | 'zoom' | 'stomp' | 'baseline' | 'wipe' | 'appear' | 'pulse' | 'grow'
export type Dir = 'right' | 'left' | 'up' | 'down' // Bewegungsrichtung (wie AnimDir in deck.ts)
export interface AnimStep {
  shape: string // cNvPr name, z. B. "dw:kpi-0" (PptxGenJS `objectName`)
  effect: Effect
  trigger: 'click' | 'after' | 'with'
  paragraph?: number // nur diesen Absatz (0-basiert) animieren
  by?: 'word' | 'letter' // Text Wort für Wort bzw. Buchstabe für Buchstabe (p:iterate)
  gapMs?: number // Abstand zwischen Wörtern/Buchstaben; default GAP
  dir?: Dir // für float, pan, drift, wipe; default float nach oben, sonst nach rechts
  durMs?: number // default 500
  delayMs?: number // default 0
}
export interface SlideAnim { transition: keyof typeof TRANSITION; speed?: 'slow' | 'fast'; steps: AnimStep[] } // speed wie AnimSpeed in deck.ts

// slides[i] gehört zu ppt/slides/slide{i+1}.xml
export async function injectAnimations(pptx: Buffer, slides: SlideAnim[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(pptx)
  for (const [i, anim] of slides.entries()) {
    const path = `ppt/slides/slide${i + 1}.xml`
    const file = zip.file(path)
    if (!file) { console.warn(`[animations] ${path} fehlt, übersprungen`); continue }
    zip.file(path, injectSlide(await file.async('string'), anim, path))
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

const TRANSITION = {
  none: '',
  // Canva Slide und Stapel: waagerecht hereinschieben bzw. überdecken; Farbwischen gibt es in PowerPoint nicht, dort Wischen
  slide: '<p:push dir="l"/>',
  stack: '<p:cover dir="l"/>',
  color: '<p:wipe dir="r"/>',
  fade: '<p:fade/>',
  push: '<p:push dir="u"/>',
  // Canva-Übergänge als PowerPoint-2007-Übergänge (laufen in jeder Version, auch LibreOffice)
  dissolve: '<p:dissolve/>',
  wipe: '<p:wipe dir="r"/>',
  cover: '<p:cover dir="l"/>',
  split: '<p:split orient="vert" dir="out"/>',
  circle: '<p:circle/>',
  zoom: '<p:zoom/>',
  morph: '<p159:morph option="byObject"/>',
}
const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
const P14 = 'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"'
const P159 = 'xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main"'
const SPEED = { slow: 1.6, fast: 0.6 } // wie im Präsentieren (PresentScreen SPEED)
// Normal = fast (0,5 s wie Design-Guide §8), Morph slow (1 s). Mit Tempo: spd als nächste Stufe (fast 0,5 s, med 0,75 s,
// slow 1 s) und die genaue Dauer als p14:dur (PowerPoint 2010+, daher in mc:AlternateContent mit spd-Fallback)
function transitionXml(t: keyof typeof TRANSITION, speed?: SlideAnim['speed']): string {
  if (t === 'none') return ''
  const ms = Math.round((t === 'morph' ? 1000 : 500) * (speed ? SPEED[speed] : 1))
  const spd = ms < 625 ? 'fast' : ms < 875 ? 'med' : 'slow'
  const tr = (fx: string, dur = false) => `<p:transition spd="${spd}"${dur ? ` p14:dur="${ms}"` : ''}>${fx}</p:transition>`
  const mc = (choice: string, a: string, b: string) => `<mc:AlternateContent ${MC}><mc:Choice ${choice}>${a}</mc:Choice><mc:Fallback>${b}</mc:Fallback></mc:AlternateContent>`
  if (t === 'morph') return mc(`${P159}${speed ? ` ${P14}` : ''} Requires="p159"`, tr(TRANSITION.morph, !!speed), tr('<p:fade/>'))
  return speed ? mc(`${P14} Requires="p14"`, tr(TRANSITION[t], true), tr(TRANSITION[t])) : tr(TRANSITION[t])
}
// [presetID, presetSubtype] wie in PowerPoints Effektkatalog
const PRESET: Record<Effect, [number, number]> = {
  fade: [10, 0], float: [42, 0], pan: [2, 8], drift: [2, 8], pop: [53, 16], zoom: [53, 16], stomp: [53, 16], baseline: [22, 4], wipe: [22, 8], appear: [1, 0], pulse: [26, 0], grow: [6, 0],
}
// Fly In/Wipe: Subtyp und Filter nach der Seite, von der es kommt (Bewegung nach rechts = von links)
const FROM: Record<Dir, { sub: number; wipe: string }> = { right: { sub: 8, wipe: 'left' }, left: { sub: 2, wipe: 'right' }, up: { sub: 4, wipe: 'down' }, down: { sub: 1, wipe: 'up' } }
const GAP = { word: 120, letter: 45 } // ms zwischen Wörtern bzw. Buchstaben (p:iterate tmAbs)
const NODE = { click: 'clickEffect', after: 'afterEffect', with: 'withEffect' }

interface Shape { id: string; kind: string; txBox: boolean; paras: number; hasText: boolean; chart: boolean; words: number; letters: number }
interface Step extends Required<Omit<AnimStep, 'paragraph' | 'by' | 'gapMs' | 'dir'>> { paragraph?: number; by?: AnimStep['by']; gapMs?: number; dir?: Dir; sh: Shape }

function injectSlide(xml: string, anim: SlideAnim, path: string): string {
  if (/<p:(timing|transition)\b/.test(xml)) { console.warn(`[animations] ${path} hat schon Animationen, übersprungen`); return xml }

  // ponytail: Regex statt XML-Parser – reicht für PptxGenJS-Ausgabe (keine Gruppen-Shapes)
  const shapes = new Map<string, Shape>()
  for (const [el, kind] of xml.matchAll(/<p:(sp|pic|graphicFrame|cxnSp)\b[\s\S]*?<\/p:\1>/g)) {
    const attrs = el.match(/<p:cNvPr\b([^>]*)>/)?.[1] ?? ''
    const id = attrs.match(/\bid="(\d+)"/)?.[1]
    const name = attrs.match(/\bname="([^"]*)"/)?.[1]
    if (!id || !name || shapes.has(name)) continue
    const text = [...el.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ')
    shapes.set(name, {
      id, kind, words: text.split(/\s+/).filter(Boolean).length, letters: text.length,
      txBox: /<p:cNvSpPr\b[^>]*\btxBox="1"/.test(el),
      paras: el.match(/<a:p[\s/>]/g)?.length ?? 0,
      hasText: /<a:t>[^<]*\S/.test(el),
      chart: el.includes('/drawingml/2006/chart"'),
    })
  }

  const steps: Step[] = []
  for (const s of anim.steps) {
    const sh = shapes.get(s.shape)
    if (!sh) { console.warn(`[animations] ${path}: Shape "${s.shape}" nicht gefunden, Schritt übersprungen`); continue }
    if (s.paragraph !== undefined && !(sh.kind === 'sp' && s.paragraph >= 0 && s.paragraph < sh.paras)) {
      console.warn(`[animations] ${path}: "${s.shape}" hat keinen Absatz ${s.paragraph}, Schritt übersprungen`); continue
    }
    steps.push({ durMs: 500, delayMs: 0, ...s, sh })
  }

  // Klick-Gruppe → after-Kette → with-Effekte
  const groups: Step[][][] = []
  for (const s of steps) {
    if (s.trigger === 'click' || !groups.length) groups.push([[s]])
    else if (s.trigger === 'after') groups.at(-1)!.push([s])
    else groups.at(-1)!.at(-1)!.push(s)
  }

  let n = 2 // 1 = tmRoot, 2 = mainSeq
  const outer = groups.map((chains, gi) => {
    const gid = ++n
    const autostart = gi === 0 && steps[0].trigger !== 'click' ? '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : ''
    let t = 0
    const inner = chains.map(chain => {
      const cid = ++n
      const start = t
      t += Math.max(...chain.map(span))
      return `<p:par><p:cTn id="${cid}" fill="hold"><p:stCondLst><p:cond delay="${start}"/></p:stCondLst>` +
        `<p:childTnLst>${chain.map(s => effect(s, () => ++n)).join('')}</p:childTnLst></p:cTn></p:par>`
    }).join('')
    return `<p:par><p:cTn id="${gid}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>${autostart}</p:stCondLst>` +
      `<p:childTnLst>${inner}</p:childTnLst></p:cTn></p:par>`
  }).join('')

  // Pro Shape ein Build-Eintrag; Bilder/Tabellen bekommen keinen
  const blds = new Map<string, string>()
  for (const { sh, paragraph } of steps) {
    if (sh.kind === 'sp' && (paragraph !== undefined || !blds.has(sh.id))) {
      const build = paragraph !== undefined ? ' build="p"' : !sh.hasText || !sh.txBox ? ' animBg="1"' : ''
      blds.set(sh.id, `<p:bldP spid="${sh.id}" grpId="0"${build}/>`)
    } else if (sh.chart) blds.set(sh.id, `<p:bldGraphic spid="${sh.id}" grpId="0"><p:bldAsOne/></p:bldGraphic>`)
  }

  const timing = steps.length === 0 ? '' :
    '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${outer}</p:childTnLst></p:cTn>` +
    '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>' +
    '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>' +
    `</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${blds.size ? `<p:bldLst>${[...blds.values()].join('')}</p:bldLst>` : ''}</p:timing>`

  // Schema-Reihenfolge in p:sld: cSld, clrMapOvr, transition, timing, extLst
  const anchor = xml.includes('</p:clrMapOvr>') ? '</p:clrMapOvr>' : '</p:cSld>'
  return xml.replace(anchor, () => anchor + transitionXml(anim.transition, anim.speed) + timing)
}

// Zeit, die ein Schritt in seiner after-Kette belegt: iterierter Text läuft Wort für Wort nach, Dauerpuls blockiert nichts
const gap = (s: Step) => (s.by ? s.gapMs ?? GAP[s.by] : 0)
const span = (s: Step) => s.effect === 'pulse' || s.effect === 'grow' ? s.delayMs : s.delayMs + s.durMs + (s.by && s.sh.hasText ? (s.by === 'word' ? s.sh.words : s.sh.letters) - 1 : 0) * gap(s)

function effect(s: Step, next: () => number): string {
  const { sh, durMs: dur } = s
  const id = next()
  const [preset, sub] = PRESET[s.effect]
  const subtype = (s.effect === 'pan' || s.effect === 'drift' || s.effect === 'wipe') && s.dir ? FROM[s.dir].sub : sub
  const grp = sh.kind === 'sp' || sh.chart ? ' grpId="0"' : ''
  const txEl = s.paragraph !== undefined ? `<p:txEl><p:pRg st="${s.paragraph}" end="${s.paragraph}"/></p:txEl>` : ''
  const tgt = `<p:tgtEl><p:spTgt spid="${sh.id}"${txEl ? `>${txEl}</p:spTgt>` : '/>'}</p:tgtEl>`

  const set = () => `<p:set><p:cBhvr><p:cTn id="${next()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${tgt}` +
    '<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
  const fx = (filter: string) => `<p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn id="${next()}" dur="${dur}"/>${tgt}</p:cBhvr></p:animEffect>`
  const val = (v: string) => v.startsWith('#') ? `<p:strVal val="${v}"/>` : `<p:fltVal val="${v}"/>`
  // Werte an Zeitpunkten (tm in Tausendstel Prozent), z. B. Pop: 0 → 106 % bei 70 % → 100 %
  const anim = (attr: string, ...tavs: [number, string][]) => `<p:anim calcmode="lin" valueType="num"><p:cBhvr>` +
    `<p:cTn id="${next()}" dur="${dur}" fill="hold"/>${tgt}<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr>` +
    `<p:tavLst>${tavs.map(([tm, v]) => `<p:tav tm="${tm}"><p:val>${val(v)}</p:val></p:tav>`).join('')}</p:tavLst></p:anim>`
  const size = (...tavs: [number, string][]) => anim('ppt_w', ...tavs) + anim('ppt_h', ...tavs.map(([tm, v]): [number, string] => [tm, v.replace('ppt_w', 'ppt_h')]))
  const move = (dx: string, dy: string) => anim('ppt_x', [0, `#ppt_x${dx}`], [100000, '#ppt_x']) + anim('ppt_y', [0, `#ppt_y${dy}`], [100000, '#ppt_y'])
  // Start versetzt gegen die Bewegungsrichtung, in Folienanteilen
  const toward = (d: Dir, by: string) => ({ right: () => move(`-${by}`, ''), left: () => move(`+${by}`, ''), up: () => move('', `+${by}`), down: () => move('', `-${by}`) })[d]()

  const body = {
    fade: () => set() + fx('fade'),
    float: () => set() + fx('fade') + toward(s.dir ?? 'up', '.1'),
    pan: () => set() + fx('fade') + toward(s.dir ?? 'right', '.05'),
    drift: () => set() + fx('fade') + toward(s.dir ?? 'right', '.1'),
    pop: () => set() + size([0, '0'], [70000, '#ppt_w*1.06'], [100000, '#ppt_w']) + fx('fade'),
    zoom: () => set() + size([0, '0'], [100000, '#ppt_w']) + fx('fade'),
    stomp: () => set() + size([0, '#ppt_w*1.6'], [100000, '#ppt_w']) + fx('fade'),
    baseline: () => set() + fx('wipe(down)') + move('', '+.05'),
    wipe: () => set() + fx(`wipe(${FROM[s.dir ?? 'right'].wipe})`),
    appear: () => set(),
    grow: () => `<p:animScale><p:cBhvr><p:cTn id="${next()}" dur="${dur}" fill="hold"/>${tgt}</p:cBhvr><p:by x="108000" y="108000"/></p:animScale>`,
    pulse: () => `<p:animScale><p:cBhvr><p:cTn id="${next()}" dur="${dur}" autoRev="1" repeatCount="indefinite" fill="hold"/>${tgt}</p:cBhvr><p:by x="104000" y="104000"/></p:animScale>`,
  }[s.effect]()

  const iterate = s.by && sh.hasText ? `<p:iterate type="${s.by === 'word' ? 'wd' : 'lt'}"><p:tmAbs val="${gap(s)}"/></p:iterate>` : ''
  return `<p:par><p:cTn id="${id}" presetID="${preset}" presetClass="${s.effect === 'pulse' || s.effect === 'grow' ? 'emph' : 'entr'}" presetSubtype="${subtype}" fill="hold"${grp} nodeType="${NODE[s.trigger]}">` +
    `<p:stCondLst><p:cond delay="${s.delayMs}"/></p:stCondLst>${iterate}<p:childTnLst>${body}</p:childTnLst></p:cTn></p:par>`
}
