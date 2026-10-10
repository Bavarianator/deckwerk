// Selbstprüfung: npx esbuild src/shared/retakes.ts --bundle --platform=node | DW_RETAKES_SELFTEST=1 node
// Neuansätze und Versprecher im Transkript finden: verworfene Anläufe, die beim Schnitt raus sollen. Ohne Electron/Node, läuft in Main und Renderer.
import type { Transcript, Word } from './video'

export interface Retake { drop: [number, number]; keep: number; text: string } // drop: verworfener Anlauf (Quellsekunden), keep: Start des neuen Anlaufs, text: die wiederholten Wörter

const MAX_GAP = 15 // s: so weit nach dem ersten Anlauf darf der neue beginnen; später ist es gewollte Wiederholung
const MIN_MATCH = 3 // gleiche Wörter, wenn der erste Anlauf ein ganzer Satz war
const MIN_BROKEN = 2 // gleiche Wörter reichen, wenn der erste Anlauf ohne Satzende abbricht
const MAX_BROKEN = 8 // Wörter: längere Satzteile ohne Satzende sind kein abgebrochener Anlauf mehr
const PAUSE = 0.6 // s: so lange Pause davor zählt als Satzanfang, falls das Satzzeichen fehlt
const SENTENCE_END = /[.!?…]["'»«“”‘’)\]]*$/
// Funktionswörter allein („und dann … und dann“) machen keinen Neuansatz; ein Bindewort vor dem zweiten Anlauf heißt Aufzählung („… und wir wollen …“)
const DOUBLE = new Set(['der', 'die', 'das', 'den', 'dem']) // doppelt oft Grammatik (Artikel + Relativpronomen)
const CONJ = new Set(['und', 'oder', 'aber', 'sondern', 'denn', 'dann', 'also', 'and', 'or', 'but', 'then', 'so'])
const FUNC = new Set([...CONJ, 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man',
  'ist', 'sind', 'bin', 'war', 'hat', 'habe', 'haben', 'wird', 'in', 'im', 'an', 'am', 'auf', 'mit', 'zu', 'von', 'für', 'ja', 'nein', 'so', 'äh', 'ähm',
  'the', 'a', 'an', 'i', 'you', 'we', 'it', 'is', 'are', 'was', 'to', 'of', 'in', 'on', 'for', 'and', 'uh', 'um'])

const norm = (w: Word) => w.w.replace(/[\p{P}\s]/gu, '').toLowerCase()
const ends = (w: Word) => SENTENCE_END.test(w.w.trim())

export function retakes(t: Transcript): Retake[] {
  const ws = t.segments.flatMap((s) => s.words ?? []) // nur echte Wortzeiten, geschätzte sind zum Schneiden zu ungenau
  const b = ws.map(norm)
  const spk = t.segments.flatMap((s) => (s.words ?? []).map(() => s.speaker)) // anderer Sprecher wiederholt = Interview, kein Neuansatz
  const out: Retake[] = []
  const text = (from: number, k: number) => ws.slice(from, from + k).map((w) => w.w.trim()).join(' ')
  let i = 0
  while (i < ws.length) {
    // Stottern „ich ich ich“: nur die Doppelung raus; „die, die …“ mit Komma ist gewollt
    if (b[i] && b[i] === b[i + 1] && spk[i] === spk[i + 1] && !/\p{P}$/u.test(ws[i].w.trim())) {
      let j = i + 1
      while (b[j + 1] === b[i]) j++
      if (j === i + 1 && DOUBLE.has(b[i])) { i++; continue } // „die die Arbeit machen“: Relativpronomen ohne Komma (ASR) – erst dreifach ist Stottern
      out.push({ drop: [ws[i].start, ws[j].start], keep: ws[j].start, text: ws[i].w.trim() })
      i = j
      continue
    }
    // ein neuer Anlauf kann selbst wieder abbrechen
    const start = i === 0 || ends(ws[i - 1]) || ws[i].start === out[out.length - 1]?.keep || ws[i].start - ws[i - 1].end >= PAUSE
    let next = i + 1
    // ponytail: O(n·Fenster) mit erstem passenden Anlauf; mehrere Anläufe hintereinander ergeben je einen Retake
    for (let j = i + 1; start && j < ws.length && ws[j].start - ws[i].start <= MAX_GAP; j++) {
      let k = 0
      while (k < j - i && j + k < ws.length && b[i + k] && b[i + k] === b[j + k]) k++
      if (!k || spk[i] !== spk[j] || ws.slice(i, i + k).every((_, m) => FUNC.has(b[i + m]))) continue
      const len = j - i, broken = !ws.slice(i, j).some(ends) && !/[,;:–-]$/.test(ws[j - 1].w.trim()) // mit Komma davor ist es eine Anapher („Mut, wir brauchen Zeit“)
      const ok = broken ? k >= MIN_BROKEN && len <= MAX_BROKEN && !CONJ.has(b[j - 1]) : k >= MIN_MATCH && k === len // ganzer Satz: nur wenn er komplett wiederholt wird, sonst Anapher
      if (!ok) continue
      out.push({ drop: [ws[i].start, ws[j].start], keep: ws[j].start, text: text(j, k) })
      next = j
      break
    }
    i = next
  }
  return out
}

if (typeof process !== 'undefined' && process.env.DW_RETAKES_SELFTEST) {
  const eq = (got: unknown, want: unknown, what: string) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: ${JSON.stringify(got)}`) }
  // Stücke [Text, Start]: Wörter im Abstand 0,4 s, je 0,3 s lang
  const mk = (...chunks: [string, number][]): Transcript => ({ duration: 100, lang: 'de', segments: chunks.map(([s, t0]) => {
    const words = s.split(' ').map((w, m) => ({ w: ' ' + w, start: +(t0 + m * 0.4).toFixed(2), end: +(t0 + m * 0.4 + 0.3).toFixed(2) }))
    return { start: t0, end: words[words.length - 1].end, text: s, words }
  }) })
  eq(retakes(mk(['Heute zeige ich euch drei Tricks.', 0], ['Heute zeige ich euch drei Tricks für Excel.', 4])),
    [{ drop: [0, 4], keep: 4, text: 'Heute zeige ich euch drei Tricks' }], 'Neuansatz deutsch')
  eq(retakes(mk(['So today I want to show you.', 0], ['So today I want to show you three things.', 5])),
    [{ drop: [0, 5], keep: 5, text: 'So today I want to show you' }], 'Neuansatz englisch')
  eq(retakes(mk(['Ich wollte euch', 0], ['ich wollte euch heute etwas zeigen.', 1.5])), [{ drop: [0, 1.5], keep: 1.5, text: 'ich wollte euch' }], 'abgebrochen')
  eq(retakes(mk(['Das Projekt', 0], ['Das Projekt läuft gut.', 1])), [{ drop: [0, 1], keep: 1, text: 'Das Projekt' }], 'abgebrochen 2 Wörter')
  eq(retakes(mk(['Heute zeige', 0], ['Heute zeige ich', 1], ['Heute zeige ich euch drei Tricks.', 2.5])).map((r) => r.drop), [[0, 1], [1, 2.5]], 'mehrere Anläufe')
  eq(retakes(mk(['Ich ich ich zeige das das das Projekt.', 0])), [{ drop: [0, 0.8], keep: 0.8, text: 'Ich' }, { drop: [1.6, 2.4], keep: 2.4, text: 'das' }], 'Stottern')
  eq(retakes(mk(['Leute die die Arbeit machen.', 0])), [], 'die die ohne Komma: Grammatik')
  eq(retakes(mk(['Die, die ich kenne.', 0])), [], 'die, die')
  eq(retakes(mk(['Heute zeige ich euch drei Tricks.', 0], ['Heute zeige ich euch drei Tricks.', 60])), [], 'nach 60 s')
  eq(retakes(mk(['Dann gehen wir los.', 0], ['Dann kommt der Rest.', 3])), [], '1 Wort')
  eq(retakes(mk(['und dann', 0], ['und dann kommt der Rest.', 1])), [], 'nur Funktionswörter')
  eq(retakes(mk(['Wir wollen mehr Schulen.', 0], ['Wir wollen mehr Lehrer.', 2])), [], 'Anapher')
  eq(retakes(mk(['Wir wollen mehr Schulen und', 0], ['wir wollen mehr Lehrer.', 2])), [], 'Aufzählung mit und')
  eq(retakes(mk(['Wir brauchen Mut, wir brauchen Zeit.', 0])), [], 'Anapher mit Komma')
  eq(retakes(mk(['Es geht um Schulen, es geht um Lehrer.', 0])), [], 'Anapher mit Komma 3 Wörter')
  const two = mk(['Das Projekt', 0], ['Das Projekt läuft gut.', 1])
  two.segments[1].speaker = 1
  eq(retakes(two), [], 'anderer Sprecher')
  eq(retakes({ duration: 10, lang: 'de', segments: [{ start: 0, end: 5, text: 'Heute zeige ich. Heute zeige ich euch was.' }] }), [], 'ohne words')
  console.log('retakes ok')
}
