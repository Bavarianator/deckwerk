/// <reference types="vite/client" />
// KI-Agent: Tool-Runner-Loop (claude-opus-5, adaptive thinking, Streaming), Systemprompt aus
// design-guide.md + Layout-Katalog (+ Thumbnails), Events an die UI. Läuft im Main-Prozess, der Key bleibt dort.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { BetaMessageParam, BetaToolResultContentBlockParam, BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Deck, Measured } from '../shared/deck'
import type { Issue } from '../shared/lint'
import { LAYOUTS, LAYOUT_IDS } from '../shared/layouts'
import { DEFAULT_MODEL, modelOf } from '../shared/models'
import guide from './design-guide.md?raw'
import { buildCatalog, buildTools, houseStyle, mimeOf, type ToolDef, type ToolOutput } from './tools'

// Vertrag zur Engine (implementiert in engine.ts). Alle Maße px auf der 1280x720-Folie.
export interface Engine {
  measure(deck: Deck, indices?: number[]): Promise<Measured[]> // Autofit + Messung, Reihenfolge wie indices
  renderPng(deck: Deck, indices: number[], width?: number): Promise<Buffer[]> // PNG pro Folie (default 1024 px breit)
  renderOverview(deck: Deck): Promise<Buffer> // Kontaktbogen aller Folien, 1 PNG
  lint(deck: Deck): Promise<Issue[]>
  exportDeck(deck: Deck, format: 'pptx' | 'pdf' | 'png' | 'md', outDir: string): Promise<string[]>
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
2. Storyline zuerst als Liste von Action Titles (mit plan_storyline, falls vorhanden, sonst im Chat), dann create_deck und add_slides in Batches.
3. QA-Schleife (max. 3 Runden): Fehler aus den Tool-Rückmeldungen und lint_deck beheben → render_overview kritisch prüfen (Rhythmus, Dichte, Konsistenz) → nachbessern.
4. Animationen prüfen (ein Übergangstyp, maximal ein Build pro Folie, keine Animation auf Titeln), Speaker Notes ergänzen.
5. Kurze Zusammenfassung; exportieren nur, wenn der Nutzer es wünscht.
Antworte auf Deutsch, knapp.`

export function buildSystemPrompt(): string {
  const style = houseStyle()
  return [guide.trim(), buildCatalog(), WORKFLOW, ...(style ? [`## Hausstil des Nutzers (gilt für jedes Deck, hat Vorrang vor dem Design-Guide)\n${style}`] : [])].join('\n\n')
}

const img = (buf: Buffer): BetaContentBlockParam => ({ type: 'image', source: { type: 'base64', media_type: mimeOf(buf), data: buf.toString('base64') } })

// Ein Beispiel-Deck (typ-Sample pro Layout) rendern → Bilder für den ersten User-Turn. Stabil → cachebar.
async function catalogThumbnails(engine: Engine): Promise<BetaContentBlockParam[]> {
  const deck: Deck = {
    title: 'Katalog', theme: { id: 'corporate' }, transition: 'none', mode: 'click',
    slides: LAYOUT_IDS.map((id) => ({ id: `cat-${id}`, layout: id, content: LAYOUTS[id].samples.typ })),
  }
  const pngs = await engine.renderPng(deck, deck.slides.map((_, i) => i), 512)
  return pngs.flatMap((p, i) => [{ type: 'text', text: `Layout ${LAYOUT_IDS[i]}:` } as BetaContentBlockParam, img(p)])
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

function toRunnable(t: ToolDef, emit: (e: AgentEvent) => void) {
  const runnable = betaZodTool({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    async run(input): Promise<string | BetaToolResultContentBlockParam[]> {
      const out = await withEvents(t, emit).run(input) // Fehler macht der Runner zu tool_result mit is_error
      if (!out.images?.length) return out.text
      return [{ type: 'text', text: out.text }, ...out.images.map(img)] as BetaToolResultContentBlockParam[]
    },
  })
  return { ...runnable, eager_input_streaming: true }
}

export class DeckAgent {
  deck: Deck | null
  model: string // pro Nachricht umschaltbar (Auswahl im Chat)
  private history: BetaMessageParam[] = []
  private client: Anthropic
  private tools
  private system = buildSystemPrompt()
  private ctl: AbortController | null = null
  private thumbs: Promise<BetaContentBlockParam[]> | null = null

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
    }).map((t) => toRunnable(t, opts.onEvent))
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
          // Opus 5.5 hat effort-Default medium, deshalb explizit high; Haiku 4.5 kennt weder adaptive noch effort
          ...('legacyThinking' in m
            ? { thinking: { type: 'enabled' as const, budget_tokens: 16000 } }
            : { thinking: { type: 'adaptive' as const, ...('updates' in m && { display: 'updates' as const }) }, output_config: { effort: 'high' as const } }),
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
    const tail = { type: 'text', text: 'Vorschau der Layouts (typische Füllung, Theme corporate). Nur zur Orientierung, nicht kommentieren.', cache_control: { type: 'ephemeral' } } as BetaContentBlockParam
    return [{ role: 'user', content: [...blocks, tail] }]
  }
}
