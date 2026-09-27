// App-Hülle: hält Deck, Undo-Stapel und Chat-Verlauf und wählt den Screen.
import { useCallback, useEffect, useRef, useState } from 'react'
import '@fontsource-variable/inter'
import './ui/app.css'
import './ui/shell.css'
import { FORMATS, type Deck, type FormatId, type Item, type Slide } from '../shared/deck'
import { newId, resizeDeck } from '../shared/items'
import { LAYOUTS, type LayoutId } from '../shared/layouts'
import { THEMES } from '../shared/themes'
import { DEFAULT_MODEL, pickAvailable, type ChatModels } from '../shared/models'
import type { Target } from './ui/AskBar'
import { BuildView, type StoryItem } from './ui/BuildView'
import { ChatChoices, type Msg } from './ui/Chat'
import { EditorScreen } from './ui/EditorScreen'
import { KeyDialog } from './ui/KeyDialog'
import { Logo } from './ui/Logo'
import { FormatSheet } from './ui/FormatSheet'
import { LookSheet } from './ui/LookSheet'
import { PresentScreen } from './ui/PresentScreen'
import { SetupSheet } from './ui/SetupSheet'
import { Start } from './ui/Start'
import { Overview } from './ui/Overview'
import { TopBar, type Panel, type Status, type View } from './ui/TopBar'
import { setAt } from './slide'

const api = window.api
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// local = Änderung kam aus der UI und muss an Main/Agent; Agent-Änderungen sind dort schon bekannt.
interface Doc { deck: Deck | null; past: Deck[]; future: Deck[]; tag?: string; local?: boolean }
const fresh = (deck: Deck | null): Doc => ({ deck, past: [], future: [] })

export default function App() {
  const [doc, setDoc] = useState<Doc>(fresh(null))
  const [path, setPath] = useState<string | null>(null)
  const [hasKey, setHasKey] = useState(true)
  const [choices, setChoices] = useState<ChatModels | null>(null) // Modell-Dropdown: Claude, Vibe, Codex
  const [askKey, setAskKey] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState(0)
  const [picked, setPicked] = useState<string[]>([]) // gewählte freie Elemente auf der angezeigten Folie
  const [presenting, setPresenting] = useState<{ i: number; dual: boolean } | null>(null) // dual = Publikum auf zweitem Bildschirm
  const [status, setStatus] = useState<Status | null>(null)
  const [nav, setNav] = useState(true) // Folienübersicht links
  const [panel, setPanel] = useState<Panel>(null) // rechts: Einfügen oder Anpassen
  const [look, setLook] = useState(false)
  const [setup, setSetup] = useState(false) // Einrichtung: beim ersten Start von selbst (state().setupDone), sonst über das Zahnrad
  const [formats, setFormats] = useState(false)
  const [view, setView] = useState<View>('slide') // einzelne Folie oder Übersicht aller Folien
  const [target, setTarget] = useState<Target | null>(null) // gewähltes Element als Bezug für die KI-Leiste
  const [story, setStory] = useState<StoryItem[] | null>(null) // geplante Storyline der KI (plan_storyline)
  const turnStart = useRef<Deck | null>(null)
  // automatisch sichern wie in Apple-Apps: jede Änderung nach kurzer Pause nach ~/Deckwerk/<titel>/deck.json
  const [saved, setSaved] = useState(true)
  const skipSave = useRef(true) // frisch geladenes Deck nicht gleich wieder schreiben // Stand vor der letzten KI-Runde, für „Rückgängig“ in der Blase
  // Modell und damit Chat-Weg; „vibe:…“/„codex:…“ unverändert laden, gültig macht es pickAvailable, sobald die Liste da ist
  const [model, setModel] = useState<string>(() => { try { return localStorage.getItem('dw.model') || DEFAULT_MODEL } catch { return DEFAULT_MODEL } })
  const pickModel = useCallback((id: string) => {
    setModel(id)
    try { localStorage.setItem('dw.model', id) } catch { /* ohne Speicher gilt die Wahl nur bis zum Neustart */ }
  }, [])
  const loadChoices = useCallback(() => api.chatModels().then(setChoices, () => {}), [])
  useEffect(() => { void loadChoices() }, [])
  // Gewähltes Modell hier nicht verfügbar (z. B. Vibe deinstalliert, nur Vibe da): automatisch das erste verfügbare
  useEffect(() => { if (choices && pickAvailable(model, choices) !== model) pickModel(pickAvailable(model, choices)) }, [choices])
  const deck = doc.deck
  const index = deck ? Math.max(0, Math.min(sel, deck.slides.length - 1)) : 0

  useEffect(() => {
    api.state().then((s) => {
      skipSave.current = true
      setDoc(fresh(s.deck))
      setPath(s.path)
      setHasKey(s.hasKey)
      if (s.setupDone) setAskKey(!s.hasKey && !s.deck) // mit geöffnetem Deck erst beim ersten Senden fragen; beim ersten Start übernimmt die Einrichtung
      else setSetup(true)
    })
    return api.onEvent((e) => {
      if (e.type === 'text')
        setMsgs((m) => {
          const last = m.at(-1)
          return last?.kind === 'ai' ? [...m.slice(0, -1), { ...last, text: last.text + e.delta }] : [...m, { kind: 'ai', text: e.delta }]
        })
      else if (e.type === 'tool')
        setMsgs((m) => {
          if (e.status === 'start') return [...m, { kind: 'tool', name: e.name, status: 'start', summary: e.summary }]
          const i = m.findLastIndex((x) => x.kind === 'tool' && x.name === e.name && x.status === 'start')
          return i < 0 ? m : m.with(i, { kind: 'tool', name: e.name, status: e.status, summary: e.summary })
        })
      else if (e.type === 'deck') setDoc((d) => ({ deck: e.deck, past: d.deck ? [...d.past, d.deck].slice(-100) : d.past, future: [] }))
      else if (e.type === 'ask') setMsgs((m) => [...m, { kind: 'ask', question: e.question, options: e.options }])
      else if (e.type === 'storyline') setStory(e.slides)
      else if (e.type === 'choice') setMsgs((m) => [...m, { kind: 'choice', question: e.question, options: e.options }])
      else if (e.type === 'error') setMsgs((m) => [...m, { kind: 'error', text: e.message }])
      else if (e.type === 'done') setBusy(false)
    })
  }, [])

  useEffect(() => {
    if (!doc.deck) return
    if (skipSave.current) { skipSave.current = false; return }
    setSaved(false)
    const t = setTimeout(() => api.save().then((p) => { setPath(p); setSaved(true) }, (e) => setStatus({ text: errText(e), error: true })), 1500)
    return () => clearTimeout(t)
  }, [doc.deck])

  // Beim Schließen: Text, der gerade auf der Folie bearbeitet wird, übernehmen (onBlur); Main speichert ihn danach
  useEffect(() => {
    const blur = () => (document.activeElement as HTMLElement | null)?.blur()
    addEventListener('beforeunload', blur)
    return () => removeEventListener('beforeunload', blur)
  }, [])

  // UI-Änderungen an Main (und damit an den Agenten) weitergeben
  useEffect(() => {
    if (doc.local && doc.deck) api.setDeck(doc.deck).catch((e) => setStatus({ text: errText(e), error: true }))
  }, [doc.deck])

  useEffect(() => {
    if (!status || status.error) return
    const t = setTimeout(() => setStatus(null), 4000)
    return () => clearTimeout(t)
  }, [status])

  // tag: aufeinanderfolgende Änderungen mit gleichem Tag (Farbwähler, Notizen) ergeben nur einen Undo-Schritt
  const commit = useCallback((fn: (d: Deck) => Deck, tag?: string) =>
    setDoc((d) => {
      if (!d.deck) return d
      const coalesce = tag !== undefined && tag === d.tag
      return { deck: fn(d.deck), past: coalesce ? d.past : [...d.past, d.deck].slice(-100), future: [], tag, local: true }
    }), [])
  const undo = useCallback(() => setDoc((d) => {
    const prev = d.past.at(-1)
    return prev && d.deck ? { deck: prev, past: d.past.slice(0, -1), future: [d.deck, ...d.future], local: true } : d
  }), [])
  const redo = useCallback(() => setDoc((d) => {
    const [next, ...rest] = d.future
    return next && d.deck ? { deck: next, past: [...d.past, d.deck], future: rest, local: true } : d
  }), [])

  const patchDeck = useCallback((p: Partial<Deck>, tag?: string) => commit((d) => ({ ...d, ...p }), tag), [commit])
  const patchSlide = useCallback((i: number, p: Partial<Slide>, tag?: string) =>
    commit((d) => ({ ...d, slides: d.slides.map((s, j) => (j === i ? { ...s, ...p } : s)) }), tag), [commit])
  // freie Elemente der angezeigten Folie
  const onItems = useCallback((fn: (items: Item[]) => Item[], tag?: string) =>
    commit((d) => ({ ...d, slides: d.slides.map((s, j) => (j === index ? { ...s, items: fn(s.items ?? []) } : s)) }), tag), [commit, index])
  const onEdit = useCallback((slot: string, text: string) => {
    if (slot.startsWith('items.')) {
      const id = slot.slice(6)
      if (deck?.slides[index]?.items?.find((it) => it.id === id)?.text !== text) onItems((l) => l.map((it) => (it.id === id ? { ...it, text } : it)))
      return
    }
    commit((d) => ({ ...d, slides: d.slides.map((s, j) => (j === index ? { ...s, content: setAt(s.content, slot, text) } : s)) }))
  }, [commit, index, deck, onItems])
  useEffect(() => setPicked([]), [index])
  // Folien anlegen (Vorlage aus dem Layout-Katalog oder leer), duplizieren, löschen
  const addSlide = useCallback((layout: LayoutId = 'blank', at = index + 1) => {
    commit((d) => {
      const slides = [...d.slides]
      slides.splice(at, 0, { id: `s-${newId()}`, layout, content: structuredClone(LAYOUTS[layout].samples.typ) })
      return { ...d, slides }
    })
    setSel(at)
  }, [commit, index])
  const dupSlide = useCallback((i: number) => {
    commit((d) => {
      const slides = [...d.slides]
      const copy = structuredClone(d.slides[i])
      slides.splice(i + 1, 0, { ...copy, id: `s-${newId()}`, items: copy.items?.map((it) => ({ ...it, id: newId() })) })
      return { ...d, slides }
    })
    setSel(i + 1)
  }, [commit])
  const delSlide = useCallback((i: number) => commit((d) => ({ ...d, slides: d.slides.filter((_, j) => j !== i) })), [commit])
  const onMove = useCallback((from: number, to: number) => {
    commit((d) => {
      const slides = [...d.slides]
      slides.splice(to, 0, ...slides.splice(from, 1))
      return { ...d, slides }
    })
    setSel(to)
  }, [commit])

  const guard = (fn: () => Promise<void>) => fn().catch((e) => setStatus({ text: errText(e), error: true }))
  const load = (d: Deck | null, p: string | null) => {
    skipSave.current = true
    setSaved(true)
    setDoc(fresh(d))
    setPath(p)
    setMsgs([])
    setSel(0)
    setStory(null)
    setTarget(null)
    turnStart.current = null
  }
  useEffect(() => api.onDeckOpened((s) => load(s.deck, s.path)), []) // Doppelklick auf eine deck.json bei laufender App
  const actions = {
    onNew: () => guard(async () => {
      await api.newDeck() // Main speichert offene Änderungen vorher (flush)
      load(null, null)
    }),
    onOpen: () => guard(async () => {
      const s = await api.open()
      if (s) load(s.deck, s.path)
    }),
    onOpenPath: (file: string) => guard(async () => {
      const s = await api.openPath(file)
      load(s.deck, s.path)
    }),
    onSave: () => guard(async () => {
      const p = await api.save()
      setPath(p)
      setSaved(true)
      setStatus({ text: `Gespeichert: ${p}` })
    }),
    onExport: (format: 'pptx' | 'pdf' | 'png' | 'md') => guard(async () => {
      setStatus({ text: `Exportiere ${format.toUpperCase()} …` })
      setStatus({ text: `Exportiert: ${await api.exportDeck(format)}` })
    }),
  }

  const send = useCallback((raw: string, context?: string) => {
    const text = raw.trim()
    if (!text || busy) return false
    if (!hasKey) return setAskKey(true), false
    setMsgs((m) => [...m, { kind: 'user', text }])
    setBusy(true)
    turnStart.current = deck
    // Kontext (Canvas-Element oder angezeigte Folie für „diese Folie“) geht nur an die KI, der Chat zeigt den Text
    const slide = deck?.slides[index]
    context ??= slide && `Gerade angezeigt: Folie ${index + 1} (ID „${slide.id}“, Layout ${slide.layout})`
    api.send(context ? `${text}\n\n(${context})` : text, model)
      .catch((e) => setMsgs((m) => [...m, { kind: 'error', text: errText(e) }]))
      .finally(() => setBusy(false))
    return true
  }, [busy, hasKey, model, deck, index])
  const abort = useCallback(() => void api.abort(), [])
  const undoTurn = useCallback(() => { const d = turnStart.current; if (d) commit(() => d) }, [commit])
  // mit zweitem Bildschirm: Publikum dort im Vollbild, hier die Referentenansicht
  const present = (i: number) => {
    if (!deck) return
    api.presentOpen(deck, i).then((dual) => setPresenting({ i, dual }), () => setPresenting({ i, dual: false }))
  }
  // Formate als eigene Decks unter ~/Deckwerk speichern; das offene Deck bleibt unverändert
  const saveCopies = (ids: FormatId[]) => deck && guard(async () => {
    setStatus({ text: `Lege ${ids.length === 1 ? 'eine Kopie' : `${ids.length} Kopien`} an …` })
    for (const id of ids) await api.saveCopy({ ...resizeDeck(deck, id), title: `${deck.title} – ${FORMATS[id].name}` })
    setStatus({ text: `${ids.length === 1 ? 'Kopie' : `${ids.length} Kopien`} unter „Decks“ gespeichert` })
  })
  const openLook = () => { setPicked([]); setLook(true) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (presenting !== null) return
      const t = e.target as HTMLElement
      const typing = t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && k === 's') deck && actions.onSave()
      else if (e.key === '/' && !typing && !mod) document.querySelector<HTMLInputElement>('.cap input')?.focus() // Wunsch an die KI
      else if (e.key === 'Escape' && panel === 'insert') setPanel(null)
      else if (mod && k === 'z' && !typing && !busy) e.shiftKey ? redo() : undo()
      else if (mod && k === 'y' && !typing && !busy) redo()
      else if ((e.key === 'F5' || (e.metaKey && e.altKey && e.code === 'KeyP')) && deck?.slides.length) present(e.shiftKey ? index : 0) // ⌥⌘P: Mac-Tastaturen brauchen für F5 fn
      else if (!typing && !mod && deck?.slides.length && ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) setSel(Math.max(0, index - 1))
      else if (!typing && !mod && deck?.slides.length && ['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) setSel(Math.min(deck.slides.length - 1, index + 1))
      else return
      e.preventDefault()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (presenting !== null && deck?.slides.length)
    return (
      <PresentScreen
        deck={deck} start={Math.min(presenting.i, deck.slides.length - 1)} mode={presenting.dual ? 'presenter' : 'solo'}
        onExit={() => { if (presenting.dual) void api.presentClose(); setPresenting(null) }}
      />
    )

  const home = !deck && !msgs.length
  // Entstehen: solange die KI nach ihrer Storyline baut; danach übernimmt der Editor
  const building = busy && !!story?.length && (deck?.slides.length ?? 0) < story.length

  return (
    <ChatChoices.Provider value={choices}>
    <div className="app">
      {home ? (
        <Start
          onSubmit={send} model={model} onModel={pickModel}
          onOpen={actions.onOpen} onOpenPath={actions.onOpenPath} onKey={() => setSetup(true)}
          onBlank={() => {
            // leer beginnen wie in Canva: eine leere Folie, alles Weitere von Hand oder per KI
            const d: Deck = { title: 'Neues Design', theme: { id: THEMES[0].id }, transition: 'fade', mode: 'click', slides: [{ id: `s-${newId()}`, layout: 'blank', content: {} }] }
            setDoc({ deck: d, past: [], future: [], local: true })
          }}
        />
      ) : building ? (
        <>
          <header className="top">
            <div className="home-brand"><Logo size={22} />Deckwerk</div>
            <div className="top-title"><b>{deck?.title ?? 'Neues Deck'}</b></div>
            <span />
          </header>
          <BuildView deck={deck} story={story!} msgs={msgs} onAbort={abort} />
        </>
      ) : (
        <>
          <TopBar
            title={deck?.title ?? 'Neues Deck'}
            path={path}
            saved={saved}
            status={status}
            hasDeck={!!deck}
            nav={nav}
            onNav={() => setNav(!nav)}
            panel={panel}
            onPanel={setPanel}
            view={deck ? view : 'slide'}
            onView={setView}
            onAddSlide={() => addSlide('blank', deck?.slides.length ?? 0)}
            onHome={actions.onNew}
            onLook={openLook}
            onExport={actions.onExport}
            onFormats={() => { setPicked([]); setFormats(true) }}
            onPresent={() => present(0)}
          />
          {deck && view === 'grid' ? (
            <Overview
              deck={deck} busy={busy} onMove={onMove} onDup={dupSlide} onDel={delSlide} onAsk={send}
              onOpen={(i) => { setSel(i); setView('slide') }}
            />
          ) : <EditorScreen
            deck={deck}
            index={index}
            msgs={msgs}
            busy={busy}
            model={model}
            onModel={pickModel}
            onSend={send}
            onAbort={abort}
            onSelect={setSel}
            onMove={onMove}
            onEdit={onEdit}
            picked={picked}
            onPick={setPicked}
            onItems={onItems}
            addSlide={addSlide}
            dupSlide={dupSlide}
            delSlide={delSlide}
            patchSlide={patchSlide}
            pickImage={api.pickImage}
            nav={nav}
            panel={panel}
            onPanel={setPanel}
            target={target}
            onTarget={setTarget}
            canUndoTurn={!busy && !!turnStart.current && turnStart.current !== deck}
            onUndoTurn={undoTurn}
          />}
        </>
      )}
      {home && status?.error && <div className="toast material" role="alert">{status.text}</div>}
      {formats && deck && <FormatSheet deck={deck} index={index} onApply={(id) => commit((d) => resizeDeck(d, id))} onCopies={saveCopies} onClose={() => setFormats(false)} />}
      {look && deck && <LookSheet deck={deck} busy={busy} patchDeck={patchDeck} pickImage={api.pickImage} onAsk={(t) => send(t)} onClose={() => setLook(false)} />}
      {setup && <SetupSheet model={model} onModel={pickModel} onKeySaved={() => { void api.state().then((s) => setHasKey(s.hasKey)); void loadChoices() }} onClose={() => { setSetup(false); void api.setupDone(); void loadChoices() }} />}
      {askKey && (
        <KeyDialog
          onClose={() => setAskKey(false)}
          onSave={async (key) => {
            await api.setApiKey(key).catch((e) => { throw new Error(errText(e)) })
            setHasKey(true)
            void loadChoices() // mit Key steht Claude auch ohne Claude Code zur Wahl
          }}
        />
      )}
    </div>
    </ChatChoices.Provider>
  )
}
