// Geteilter Link der App: #d=<base64url(JSON)>. Die Zugangsdaten stehen nur im Fragment und verlassen den Browser nie.
export type Freigabe = { d: string; s: string; host: string; t: string; p?: string; r: 'edit' | 'view'; n: string }

export function lesen(hash: string): Freigabe | null {
  const d = new URLSearchParams(hash.replace(/^#/, '')).get('d') ?? ''
  if (!/^[A-Za-z0-9_-]+$/.test(d)) return null // landet roh in deckwerk://, daher nur base64url-Zeichen
  try {
    const bin = atob(d.replace(/-/g, '+').replace(/_/g, '/'))
    const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
    const { v, s, t, p, r, n } = j ?? {}
    if (v !== 1 || typeof s !== 'string' || !/^https?:\/\//.test(s) || typeof t !== 'string' || !t || (r !== 'edit' && r !== 'view') || typeof n !== 'string') return null
    return { d, s, host: new URL(s).host, t, p: typeof p === 'string' ? p : undefined, r, n }
  } catch {
    return null
  }
}
