// Storyline eines Decks: Folientitel und Kapitel (Abschnitte zwischen den Kapiteltrennern; davor liegt der Einstieg).
import type { Deck } from '../../shared/deck'

export const titleOf = (deck: Deck, i: number) => {
  const c = deck.slides[i].content ?? {}
  return String(c.title ?? c.text ?? `Folie ${i + 1}`).replace(/\*\*/g, '')
}

export const chaptersOf = (deck: Deck) => deck.slides.reduce<{ title: string; from: number; to: number }[]>((out, s, i) => {
  if (s.layout === 'section' || !out.length) out.push({ title: s.layout === 'section' ? titleOf(deck, i) : 'Einstieg', from: i, to: i })
  else out.at(-1)!.to = i
  return out
}, [])
