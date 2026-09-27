// Handy als Fernbedienung (Canva „Remote Control“): kleiner HTTP-Server im LAN, nur mit Zufallstoken und nur,
// solange die Referentenansicht ihn braucht. Die Seite zeigt Folie, Notizen und Weiter/Zurück.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'

export interface RemoteState { i: number; n: number; title: string; notes: string }
let server: Server | null = null
let state: RemoteState = { i: 0, n: 0, title: '', notes: '' }
export const setRemoteState = (s: RemoteState) => { state = s }

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Deckwerk</title>
<style>body{margin:0;font:17px system-ui,sans-serif;background:#111;color:#eee;display:flex;flex-direction:column;height:100dvh}
header{padding:16px;color:#a1a1aa}main{flex:1;overflow:auto;padding:0 16px;font-size:21px;line-height:1.45}
nav{display:flex;gap:10px;padding:16px}button{height:104px;border:0;border-radius:20px;font:600 21px system-ui,sans-serif}
#p{flex:1;background:#2a2a2e;color:#eee}#x{flex:2;background:#7a86ff;color:#fff}</style>
<header id=h>Verbinde …</header><main id=m></main><nav><button id=p>Zurück</button><button id=x>Weiter</button></nav>
<script>const q=location.search
const s=()=>fetch('/state'+q).then(r=>r.json()).then(r=>{h.textContent='Folie '+(r.i+1)+' von '+r.n+' · '+r.title;m.textContent=r.notes||'Keine Notizen.'},()=>{h.textContent='Keine Verbindung'})
p.onclick=()=>fetch('/prev'+q,{method:'POST'}).then(s);x.onclick=()=>fetch('/next'+q,{method:'POST'}).then(s)
setInterval(s,1000);s()</script>`

export async function startRemote(onCmd: (c: 'next' | 'prev') => void): Promise<string> {
  stopRemote()
  const token = randomBytes(16).toString('hex')
  const ok = (t: string | null) => { const b = Buffer.from(t ?? ''); return b.length === token.length && timingSafeEqual(b, Buffer.from(token)) }
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://remote')
    if (!ok(u.searchParams.get('t'))) return void res.writeHead(403).end()
    if (req.method === 'POST' && (u.pathname === '/next' || u.pathname === '/prev')) {
      onCmd(u.pathname === '/next' ? 'next' : 'prev')
      return void res.writeHead(204).end()
    }
    if (u.pathname === '/state') return void res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(state))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE)
  })
  await new Promise<void>((resolve, reject) => server!.once('error', reject).listen(0, '0.0.0.0', resolve))
  // ponytail: erste echte Schnittstelle; virtuelle (Docker, VM, VPN) per Namensliste übersprungen, sonst Auswahl anbieten
  const ip = Object.entries(networkInterfaces()).filter(([name]) => !/^(docker|br-|veth|virbr|vboxnet|vmnet|tun|tap|wg|utun|tailscale|zt)/.test(name))
    .flatMap(([, a]) => a ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address
  if (!ip) {
    stopRemote()
    throw new Error('Kein Netzwerk gefunden. Handy und Rechner müssen im selben WLAN sein.')
  }
  return `http://${ip}:${(server.address() as AddressInfo).port}/?t=${token}`
}

export function stopRemote() {
  server?.close()
  server = null
}
