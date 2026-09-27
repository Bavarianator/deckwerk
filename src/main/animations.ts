// Injiziert <p:transition> und <p:timing> in die Slide-XML einer PptxGenJS-Datei.
// Die XML-Struktur folgt dem, was PowerPoint selbst schreibt (mainSeq → Klick-Gruppe → after-Kette → Effekt).
import JSZip from 'jszip'

export type Effect = 'fade' | 'float' | 'wipe' | 'zoom' // float = „Einschweben“ (von unten), wipe = von links
export interface AnimStep {
  shape: string // cNvPr name, z. B. "dw:kpi-0" (PptxGenJS `objectName`)
  effect: Effect
  trigger: 'click' | 'after' | 'with'
  paragraph?: number // nur diesen Absatz (0-basiert) animieren
  durMs?: number // default 500
  delayMs?: number // default 0
}
export interface SlideAnim { transition: keyof typeof TRANSITION; steps: AnimStep[] }

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
  fade: '<p:transition spd="fast"><p:fade/></p:transition>',
  push: '<p:transition spd="fast"><p:push dir="u"/></p:transition>',
  // Canva-Übergänge als PowerPoint-2007-Übergänge (laufen in jeder Version, auch LibreOffice)
  dissolve: '<p:transition spd="med"><p:dissolve/></p:transition>',
  wipe: '<p:transition spd="med"><p:wipe dir="r"/></p:transition>',
  cover: '<p:transition spd="fast"><p:cover dir="l"/></p:transition>',
  split: '<p:transition spd="med"><p:split orient="vert" dir="out"/></p:transition>',
  circle: '<p:transition spd="med"><p:circle/></p:transition>',
  zoom: '<p:transition spd="med"><p:zoom/></p:transition>',
  morph: '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    '<mc:Choice xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main" Requires="p159">' +
    '<p:transition spd="slow"><p159:morph option="byObject"/></p:transition></mc:Choice>' +
    '<mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>',
}
// [presetID, presetSubtype] wie in PowerPoints Effektkatalog
const PRESET: Record<Effect, [number, number]> = { fade: [10, 0], float: [42, 0], wipe: [22, 8], zoom: [53, 16] }
const NODE = { click: 'clickEffect', after: 'afterEffect', with: 'withEffect' }

interface Shape { id: string; kind: string; txBox: boolean; paras: number; hasText: boolean; chart: boolean }
interface Step extends Required<Omit<AnimStep, 'paragraph'>> { paragraph?: number; sh: Shape }

function injectSlide(xml: string, anim: SlideAnim, path: string): string {
  if (/<p:(timing|transition)\b/.test(xml)) { console.warn(`[animations] ${path} hat schon Animationen, übersprungen`); return xml }

  // ponytail: Regex statt XML-Parser – reicht für PptxGenJS-Ausgabe (keine Gruppen-Shapes)
  const shapes = new Map<string, Shape>()
  for (const [el, kind] of xml.matchAll(/<p:(sp|pic|graphicFrame|cxnSp)\b[\s\S]*?<\/p:\1>/g)) {
    const attrs = el.match(/<p:cNvPr\b([^>]*)>/)?.[1] ?? ''
    const id = attrs.match(/\bid="(\d+)"/)?.[1]
    const name = attrs.match(/\bname="([^"]*)"/)?.[1]
    if (!id || !name || shapes.has(name)) continue
    shapes.set(name, {
      id, kind,
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
      t += Math.max(...chain.map(s => s.delayMs + s.durMs))
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
  return xml.replace(anchor, () => anchor + TRANSITION[anim.transition] + timing)
}

function effect(s: Step, next: () => number): string {
  const { sh, durMs: dur } = s
  const id = next()
  const [preset, subtype] = PRESET[s.effect]
  const grp = sh.kind === 'sp' || sh.chart ? ' grpId="0"' : ''
  const txEl = s.paragraph !== undefined ? `<p:txEl><p:pRg st="${s.paragraph}" end="${s.paragraph}"/></p:txEl>` : ''
  const tgt = `<p:tgtEl><p:spTgt spid="${sh.id}"${txEl ? `>${txEl}</p:spTgt>` : '/>'}</p:tgtEl>`

  const set = () => `<p:set><p:cBhvr><p:cTn id="${next()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${tgt}` +
    '<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
  const fx = (filter: string) => `<p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn id="${next()}" dur="${dur}"/>${tgt}</p:cBhvr></p:animEffect>`
  const val = (v: string) => v.startsWith('#') ? `<p:strVal val="${v}"/>` : `<p:fltVal val="${v}"/>`
  const anim = (attr: string, from: string, to: string) => `<p:anim calcmode="lin" valueType="num"><p:cBhvr>` +
    `<p:cTn id="${next()}" dur="${dur}" fill="hold"/>${tgt}<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr>` +
    `<p:tavLst><p:tav tm="0"><p:val>${val(from)}</p:val></p:tav><p:tav tm="100000"><p:val>${val(to)}</p:val></p:tav></p:tavLst></p:anim>`

  const body = {
    fade: () => set() + fx('fade'),
    float: () => set() + fx('fade') + anim('ppt_x', '#ppt_x', '#ppt_x') + anim('ppt_y', '#ppt_y+.1', '#ppt_y'),
    wipe: () => set() + fx('wipe(left)'),
    zoom: () => set() + anim('ppt_w', '0', '#ppt_w') + anim('ppt_h', '0', '#ppt_h') + fx('fade'),
  }[s.effect]()

  return `<p:par><p:cTn id="${id}" presetID="${preset}" presetClass="entr" presetSubtype="${subtype}" fill="hold"${grp} nodeType="${NODE[s.trigger]}">` +
    `<p:stCondLst><p:cond delay="${s.delayMs}"/></p:stCondLst><p:childTnLst>${body}</p:childTnLst></p:cTn></p:par>`
}
