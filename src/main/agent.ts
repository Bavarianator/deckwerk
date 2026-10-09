/// <reference types="vite/client" />
// KI-Agent: Tool-Runner-Loop (claude-opus-5, adaptive thinking, Streaming), Systemprompt aus
// design-guide.md + Layout-Katalog (+ Thumbnails), Events an die UI. Läuft im Main-Prozess, der Key bleibt dort.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { BetaMessageParam, BetaToolResultContentBlockParam, BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { FORMATS, type Deck, type FormatId, type Measured, type PrintOptions } from '../shared/deck'
import type { Issue } from '../shared/lint'
import type { Part, Transcript, VideoInfo } from '../shared/video'
import type { Highlight, Signals } from '../shared/highlights'
import { LAYOUTS, LAYOUT_IDS, type LayoutId } from '../shared/layouts'
import { DEFAULT_MODEL, modelOf, type Effort } from '../shared/models'
import guide from './design-guide.md?raw'
import { buildCatalog, buildTools, houseStyle, mimeOf, recentLooks, type ToolDef, type ToolOutput } from './tools'

// Vertrag zur Engine (implementiert in engine.ts). Alle Maße px auf der 1280x720-Folie.
export type ExportFormat = 'pptx' | 'docx' | 'pdf' | 'png' | 'md' | 'zip' | 'print' | 'mp4' | 'clips' // docx = Word, Text bearbeitbar auf Hintergrundbild; zip = PNG je Folie + PDF in einer Datei (Social-Karussell); print = PDF für die Druckerei (PrintOptions in deck.ts); mp4 = ganzes Deck als Video, clips = je Clip-Folie eine MP4 (export-video.ts)
export interface Engine {
  measure(deck: Deck, indices?: number[]): Promise<Measured[]> // Autofit + Messung, Reihenfolge wie indices
  renderPng(deck: Deck, indices: number[], width?: number): Promise<Buffer[]> // PNG pro Folie (default 1024 px breit)
  renderOverview(deck: Deck): Promise<Buffer> // Kontaktbogen aller Folien, 1 PNG
  lint(deck: Deck): Promise<Issue[]>
  exportDeck(deck: Deck, format: ExportFormat, outDir: string, print?: PrintOptions, onProgress?: (pct: number) => void): Promise<string[]> // print nur bei format 'print'; onProgress nur bei mp4/clips
  thumbnail?(img: Buffer, width: number): Buffer | null // JPEG-Vorschau eines Bildes ohne Rendern; null = Format unbekannt (WebP)
  video?: VideoTools // fehlt in den Mock-Engines der Smoke-Tests
}
// Video-Schnitt (ffmpeg.ts, transcribe.ts); file = absoluter Pfad einer Videodatei
export interface VideoTools {
  probe(file: string): Promise<VideoInfo>
  frames(file: string, times: number[]): Promise<Buffer[]> // JPEG je Zeitpunkt (s), 640 px breit
  transcribe(file: string, onProgress?: (pct: number) => void, o?: { range?: { from: number; to: number }; lang?: string; speakers?: boolean }): Promise<Transcript> // lokal: Parakeet (sherpa-onnx), Whisper nur für Sprachen außerhalb von Parakeet; in 5-min-Stücken gecacht; range = nur diesen Bereich (s), speakers = Sprechertrennung
  highlights?(file: string, onProgress?: (pct: number) => void): Promise<Highlight[]> // Streams/lange Videos: stärkste Momente aus Lautheit, Chat, Ereignissen, Heatmap
  musicIn?(file: string, parts: Part[]): Promise<number[]> // Musik im Hintergrund je Quellsekunde 0..1, getaggt nur in den Sekunden der parts (Rest 0); Fehler → []
  cached?(file: string): Promise<{ signals: Signals | null; highlights: Highlight[]; transcript: Transcript | null; duration: number | null }> // nur Cache lesen, nie rechnen; Fehler → null-Felder
  importUrl?(url: string, onProgress?: (pct: number) => void): Promise<{ file: string; title: string; duration: number; chat: boolean; chapters: { start: number; title: string }[] }> // Video per Link laden (yt-dlp); chat = Chat-Aufzeichnung liegt bei
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; status: 'start' | 'done' | 'error'; summary?: string }
  | { type: 'deck'; deck: Deck } // nach jeder Deck-Änderung (UI aktualisiert live)
  | { type: 'ask'; question: string; options: string[] } // Rückfrage über ask_user
  | { type: 'storyline'; slides: { title: string; layout: string }[] } // geplante Folien über plan_storyline
  | { type: 'choice'; question: string; options: { label: string; image: string }[] } // Auswahl-Karten (propose_looks), Antwort = label als Nachricht
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface DeckAgentOptions {
  engine: Engine
  onEvent: (e: AgentEvent) => void
  apiKey?: string // sonst ANTHROPIC_API_KEY / ant-auth-Profil
  deck?: Deck
  assetDir?: string
  outDir?: string
  thumbnails?: boolean // Katalog-Vorschaubilder in den ersten Turn (default true)
  model?: string
  unsplashKey?: string // default UNSPLASH_ACCESS_KEY
}

const WORKFLOW = `## Arbeitsablauf
1. Höchstens 2–3 Rückfragen (mit ask_user, falls vorhanden), sonst sinnvolle Defaults annehmen.
2. Erst die Leitidee in einem Satz (Guide §2 „Die Idee“: Bild für das Ganze, Haken, ein mutiger Höhepunkt), dann die Storyline als Liste der Titel (Datenfolien als Aussage-Satz, Bühnenfolien kurz) (mit plan_storyline, falls vorhanden, sonst im Chat), dann create_deck und add_slides in Batches.
3. QA-Schleife (max. 3 Runden): Fehler aus den Tool-Rückmeldungen und lint_deck beheben → render_overview kritisch prüfen (Rhythmus, Dichte, Konsistenz) → nachbessern.
4. Animationen prüfen (ein Übergangstyp, maximal ein Build pro Folie, keine Animation auf Titeln), Speaker Notes ergänzen.
5. Kurze Zusammenfassung; exportieren nur, wenn der Nutzer es wünscht.
Antworte auf Deutsch, knapp.`

export function buildSystemPrompt(): string {
  const style = houseStyle(), recent = recentLooks()
  return [guide.trim(), buildCatalog(), WORKFLOW, ...(style ? [`## Hausstil des Nutzers (gilt für jedes Deck, hat Vorrang vor dem Design-Guide)\n${style}`] : []),
    ...(recent.length ? [`## Zuletzt gebaute Decks (nur für neue Decks: im Typ nicht wiederholen, Design-Guide §6 „Abwechslung“; bestehende Decks behalten ihr Design)\n${recent.map(({ title, typ: t }) => `- „${title}“: ${t.hell}, ${t.schrift}-Titel ${t.gewicht} (${t.font}), Grund ${t.grund}, Bauteile ${t.bauteile}, Akzent ${t.akzent}`).join('\n')}`] : [])].join('\n\n')
}

const img = (buf: Buffer): BetaContentBlockParam => ({ type: 'image', source: { type: 'base64', media_type: mimeOf(buf), data: buf.toString('base64') } })

// Ein Beispiel-Deck (typ-Sample pro Layout) rendern → Bilder für den ersten User-Turn. Stabil → cachebar.
async function catalogThumbnails(engine: Engine): Promise<BetaContentBlockParam[]> {
  // Layouts mit sizes (A4-Dokumente, Flyer) im eigenen Format zeigen, sonst sieht die KI sie in 16:9; ein Deck je Format
  const fmt = (id: LayoutId): FormatId => (LAYOUTS[id] as { sizes?: FormatId[] }).sizes?.[0] ?? '16:9'
  const pngs = new Map<LayoutId, Buffer>()
  for (const f of new Set(LAYOUT_IDS.map(fmt))) {
    const ids = LAYOUT_IDS.filter((id) => fmt(id) === f)
    const deck: Deck = {
      title: 'Katalog', theme: { id: 'beratung' }, transition: 'none', mode: 'click', size: { w: FORMATS[f].w, h: FORMATS[f].h },
      slides: ids.map((id) => ({ id: `cat-${id}`, layout: id, content: LAYOUTS[id].samples.typ })),
    }
    const out = await engine.renderPng(deck, ids.map((_, i) => i), 512)
    ids.forEach((id, i) => pngs.set(id, out[i]))
  }
  return LAYOUT_IDS.flatMap((id) => [{ type: 'text', text: `Layout ${id}:` } as BetaContentBlockParam, img(pngs.get(id)!)])
}

// Tool-Status-Chips für die UI (auch für den Chat über Claude Code, claude-agent.ts)
export function withEvents(t: ToolDef, emit: (e: AgentEvent) => void): ToolDef {
  return {
    ...t,
    async run(input) {
      emit({ type: 'tool', name: t.name, status: 'start' })
      let out: ToolOutput
      try {
        out = await t.run(input)
      } catch (e) {
        emit({ type: 'tool', name: t.name, status: 'error', summary: (e as Error).message.split('\n')[0] })
        throw e
      }
      emit({ type: 'tool', name: t.name, status: 'done', summary: out.text.split('\n')[0].slice(0, 120) })
      return out
    },
  }
}

// Der SDK-Runner führt alle Tool-Aufrufe einer Antwort gleichzeitig aus. Deck-Änderungen klonen das Deck und setzen es nach
// einem await zurück; parallel ginge eine davon verloren. Deshalb wie in Claude Code: readOnly parallel, alles andere der Reihe nach.
export function toRunnable(t: ToolDef, emit: (e: AgentEvent) => void, lock: { tail: Promise<unknown> }) {
  const runnable = betaZodTool({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    async run(input): Promise<string | BetaToolResultContentBlockParam[]> {
      const go = () => withEvents(t, emit).run(input) // Fehler macht der Runner zu tool_result mit is_error
      const out = await (t.readOnly ? go() : (lock.tail = lock.tail.catch(() => {}).then(go)) as ReturnType<typeof go>)
      if (!out.images?.length) return out.text
      return [{ type: 'text', text: out.text }, ...out.images.map(img)] as BetaToolResultContentBlockParam[]
    },
  })
  return { ...runnable, eager_input_streaming: true }
}

export class DeckAgent {
  deck: Deck | null
  model: string // pro Nachricht umschaltbar (Auswahl im Chat)
  effort: Effort = 'high' // Auto setzt medium für kleine Änderungen
  private history: BetaMessageParam[] = []
  private client: Anthropic
  private tools
  private system = buildSystemPrompt()
  private ctl: AbortController | null = null
  private thumbs: Promise<BetaContentBlockParam[]> | null = null
  private lock = { tail: Promise.resolve() as Promise<unknown> } // Deck-Tools nacheinander (toRunnable)

  constructor(private opts: DeckAgentOptions) {
    this.deck = opts.deck ?? null
    this.model = opts.model ?? DEFAULT_MODEL
    this.client = new Anthropic({ apiKey: opts.apiKey })
    this.tools = buildTools({
      engine: opts.engine,
      getDeck: () => this.deck,
      setDeck: (deck) => { this.deck = deck; opts.onEvent({ type: 'deck', deck }) },
      assetDir: opts.assetDir ?? `${process.env.HOME}/Deckwerk/assets`,
      outDir: opts.outDir ?? `${process.env.HOME}/Deckwerk/out`,
      unsplashKey: opts.unsplashKey ?? process.env.UNSPLASH_ACCESS_KEY,
      ask: (q) => opts.onEvent({ type: 'ask', ...q }),
      storyline: (slides) => opts.onEvent({ type: 'storyline', slides }),
      choice: (c) => opts.onEvent({ type: 'choice', ...c }),
    }).map((t) => toRunnable(t, opts.onEvent, this.lock))
  }

  // Tool-Loop bis end_turn; History bleibt im Speicher.
  async send(userText: string): Promise<void> {
    const emit = this.opts.onEvent
    if (!this.history.length) this.history.push(...(await this.firstTurnPrefix()))
    this.history.push({ role: 'user', content: userText })
    this.ctl = new AbortController()

    const m = modelOf(this.model)
    for (let attempt = 0; ; attempt++) {
      const runner = this.client.beta.messages.toolRunner(
        {
          model: m.id,
          max_tokens: 64000,
          stream: true,
          max_iterations: 80,
          betas: [...('fallback' in m ? ['server-side-fallback-2026-07-01'] : []), ...('updates' in m ? ['thinking-display-updates-2026-08-18'] : [])],
          ...('fallback' in m && { fallbacks: 'default' as const }),
          // Opus 5.5 hat effort-Default medium, deshalb explizit setzen; Haiku 4.5 kennt weder adaptive noch effort
          ...('legacyThinking' in m
            ? { thinking: { type: 'enabled' as const, budget_tokens: 16000 } }
            : { thinking: { type: 'adaptive' as const, ...('updates' in m && { display: 'updates' as const }) }, output_config: { effort: this.effort } }),
          system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
          // Web-Recherche (Canva „Web Research“) läuft serverseitig; Haiku bekommt nur die Basis-Suche
          tools: [...this.tools, ...('legacyThinking' in m
            ? [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 5 }]
            : [{ type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: 5 }, { type: 'web_fetch_20260209' as const, name: 'web_fetch' as const, max_uses: 5 }])],
          messages: this.history,
        },
        { signal: this.ctl.signal },
      )
      try {
        let last: Anthropic.Beta.BetaMessage | undefined
        for await (const stream of runner) {
          let said = false
          stream.on('text', (delta) => { said = true; emit({ type: 'text', delta }) })
          // Web-Recherche läuft serverseitig und nicht über withEvents: Status-Chip aus den Stream-Blöcken
          stream.on('streamEvent', (ev) => {
            if (ev.type !== 'content_block_start') return
            const b = ev.content_block
            if (b.type === 'server_tool_use' && (b.name === 'web_search' || b.name === 'web_fetch')) emit({ type: 'tool', name: b.name, status: 'start' })
            else if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') emit({ type: 'tool', name: b.type.replace('_tool_result', ''), status: 'done' })
          })
          // display "updates": Zwischennotizen vor Tool-Aufrufen kommen als thinking, nicht als text
          stream.on('thinking', (delta, snap) => delta && emit({ type: 'text', delta: said && snap === delta ? `\n\n${delta}` : delta }))
          last = await stream.finalMessage()
        }
        this.history = [...runner.params.messages]
        if (last?.stop_reason === 'refusal') emit({ type: 'error', message: `Anfrage abgelehnt${last.stop_details?.explanation ? ': ' + last.stop_details.explanation : ''}` })
        else if (last?.stop_reason === 'max_tokens') emit({ type: 'error', message: 'Antwort abgeschnitten (max_tokens). Bitte „weiter“ senden.' })
        emit({ type: 'done' })
        return
      } catch (e) {
        if (e instanceof Anthropic.APIUserAbortError) { this.history = [...runner.params.messages]; emit({ type: 'done' }); return }
        // eager_input_streaming: unparsbares Tool-JSON → Turn einmal neu anfordern (History ist unverändert)
        if (!(e instanceof Anthropic.APIError) && attempt < 1) continue
        emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
        emit({ type: 'done' })
        return
      } finally {
        this.ctl = null
      }
    }
  }

  abort(): void { this.ctl?.abort() }

  // Deck aus der UI übernehmen (Text direkt bearbeitet, Undo) – die KI arbeitet danach mit diesem Stand.
  setDeck(deck: Deck): void { this.deck = deck }

  private async firstTurnPrefix(): Promise<BetaMessageParam[]> {
    if (this.opts.thumbnails === false) return []
    this.thumbs ??= catalogThumbnails(this.opts.engine).catch((e) => { console.warn('[agent] Thumbnails übersprungen:', (e as Error).message); return [] })
    const blocks = await this.thumbs
    if (!blocks.length) return []
    const tail = { type: 'text', text: 'Vorschau der Layouts (typische Füllung, Theme beratung). Zeigt nur die Anordnung; Farbe, Schrift und Struktur kommen aus deinem eigenen Design. Nicht kommentieren.', cache_control: { type: 'ephemeral' } } as BetaContentBlockParam
    return [{ role: 'user', content: [...blocks, tail] }]
  }
}
