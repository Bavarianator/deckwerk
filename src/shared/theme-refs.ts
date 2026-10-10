// Referenz-Themes: sieben bewusst verschiedene Richtungen auf Weltklasse-Niveau. Sie stehen gekürzt im Systemprompt
// (Beispiele, wie aus einer Leitidee Tokens werden) und in der Galerie (npm run check:themes). Hex-Werte sind am
// Kontaktbogen justiert; wer eine Referenz ändert, schaut sich danach exports/themes/ an.
import type { ThemeSpec } from './deck'

export interface ThemeRefSpec { direction: string; why: string; spec: ThemeSpec }

export const THEME_REFS: ThemeRefSpec[] = [
  {
    direction: 'Leitsystem',
    why: 'Beschilderung: Schwarz trägt, Signalgelb nur als Fläche, Hierarchie allein über Gewicht und Größe',
    spec: { name: 'Leitsystem', bg: '#F6F6F3', text: '#151515', accent: '#151515', field: '#F2C200', headFont: 'Schibsted Grotesk', bodyFont: 'Schibsted Grotesk', headWeight: 800, headTracking: -0.03, titleSize: 'large', labels: 'caps', signature: { kind: 'edge', side: 'top', size: 12, color: 'field' }, heroTone: 'field', radius: 0, decor: 'none' },
  },
  {
    direction: 'Rubrik',
    why: 'Buchsatz: rote Rubrizierung, eine Haarlinie wie ein Kolumnentitel, breiter Bundsteg links',
    spec: { name: 'Rubrik', bg: '#FAFAF7', text: '#1B1A18', accent: '#A3242B', headFont: 'Newsreader', bodyFont: 'Public Sans', titleSize: 'large', leading: 'tight', labels: 'caps', margin: 'asymmetric', signature: { kind: 'rule', size: 1, length: 'full', color: 'text' }, images: 'mono', radius: 0, decor: 'none' },
  },
  {
    direction: 'Werkstatt',
    why: 'Braun-Gerät: warmes Gerätegrau, ein Orange wie die Einschalttaste, mittleres Gewicht statt fett',
    spec: { name: 'Werkstatt', bg: '#F3F2EF', text: '#232323', accent: '#D9531A', headFont: 'Hanken Grotesk', bodyFont: 'Hanken Grotesk', headWeight: 500, titleSize: 'normal', margin: 'generous', radius: 6, decor: 'none' },
  },
  {
    direction: 'Ma',
    why: 'Leerraum als Material: leichte Serif-Titel, schmaler Satz, ein Zinnober nur für die eine Zahl',
    spec: { name: 'Ma', bg: '#F7F6F2', text: '#1F1F1D', accent: '#B3372E', headFont: 'Spectral', bodyFont: 'Work Sans', headWeight: 300, titleSize: 'normal', measure: 'narrow', margin: 'generous', leading: 'open', radius: 0, decor: 'none' },
  },
  {
    direction: 'Feuilleton',
    why: 'Magazinsatz: große Didone, eine Schmuckfarbe, das Cover wie ein Titelblatt in Schwarz',
    spec: { name: 'Feuilleton', bg: '#FFFFFF', text: '#111111', accent: '#0B6E4F', headFont: 'Bodoni Moda', bodyFont: 'Libre Franklin', titleSize: 'huge', leading: 'tight', labels: 'caps', signature: { kind: 'rule', size: 1, length: 'full', color: 'text' }, heroTone: 'invert', radius: 0, decor: 'none' },
  },
  {
    direction: 'Bühne',
    why: 'Bühnenlicht: fast schwarz, riesige halbfette Titel, ein warmer Spot statt Neon',
    spec: { name: 'Bühne', bg: '#0F0F10', text: '#ECECEA', accent: '#FF7A45', headFont: 'Inter Tight', bodyFont: 'Inter', headWeight: 600, headTracking: -0.04, titleSize: 'huge', measure: 'wide', radius: 2, decor: 'none' },
  },
  {
    direction: 'Befund',
    why: 'Tufte: Daten-Tinte statt Deko, Grau für den Kontext, ein Rot nur für den Befund; offline-sicher',
    spec: { name: 'Befund', bg: '#FCFCFA', text: '#141414', accent: '#B5121B', headFont: 'Source Serif 4', bodyFont: 'Source Sans 3', titleSize: 'normal', chart: 'focus', radius: 0, decor: 'none' },
  },
]

// Für den Systemprompt: eine Zeile je Referenz (Richtung, Leitidee, Kern-Tokens)
export const refsPrompt = () => THEME_REFS.map(({ direction, why, spec: s }) =>
  `- ${direction}: ${why}. {bg ${s.bg}, text ${s.text}, accent ${s.accent}${s.field ? `, field ${s.field}` : ''}, ${s.headFont}${s.headWeight ? ` ${s.headWeight}` : ''} / ${s.bodyFont}` +
  [s.titleSize && `titleSize ${s.titleSize}`, s.headTracking && `headTracking ${s.headTracking}`, s.leading && `leading ${s.leading}`, s.labels && `labels ${s.labels}`, s.margin && `margin ${s.margin}`, s.measure && `measure ${s.measure}`,
    s.signature && `signature ${s.signature.kind}`, s.heroTone && `heroTone ${s.heroTone}`, s.images && `images ${s.images}`].filter(Boolean).map((t) => `, ${t}`).join('') + '}').join('\n')
