// Geteilter Link der App: #d=<base64url(JSON)>. Die Zugangsdaten stehen nur im Fragment und verlassen den Browser nie.
// a=pro: Link aus Deckwerk Pro, öffnet per deckwerk-pro:// (eigenes Schema je Edition)
export type Freigabe = { d: string; s: string; host: string; t: string; p?: string; r: 'edit' | 'view'; n: string; scheme: 'deckwerk' | 'deckwerk-pro' }

export function lesen(hash: string): Freigabe | null {
  const q = new URLSearchParams(hash.replace(/^#/, '')), d = q.get('d') ?? ''
  if (!/^[A-Za-z0-9_-]+$/.test(d)) return null // landet roh in deckwerk://, daher nur base64url-Zeichen
  try {
    const bin = atob(d.replace(/-/g, '+').replace(/_/g, '/'))
    const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
    const { v, s, t, p, r, n } = j ?? {}
    if (v !== 1 || typeof s !== 'string' || !/^https?:\/\//.test(s) || typeof t !== 'string' || !t || (r !== 'edit' && r !== 'view') || typeof n !== 'string') return null
    return { d, s, host: new URL(s).host, t, p: typeof p === 'string' ? p : undefined, r, n, scheme: q.get('a') === 'pro' ? 'deckwerk-pro' : 'deckwerk' }
  } catch {
    return null
  }
}
