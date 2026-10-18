// Erzeugt assets/lucide.txt aus lucide-react (je Zeile: name TAB SVG-Pfaddaten, alle Elemente als Pfade; Alias: name TAB =ziel).
// Aufruf im Repo-Wurzelverzeichnis: node crates/dw-scene/tools/gen-icons.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const dir = 'node_modules/lucide-react/dist/esm/icons'
const pkg = JSON.parse(readFileSync('node_modules/lucide-react/package.json', 'utf8'))
const n = (v) => +(+v).toFixed(3)
const toPath = ([tag, a]) => {
  switch (tag) {
    case 'path': return a.d
    case 'line': return `M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`
    case 'polyline': case 'polygon': {
      const p = a.points.trim().split(/[\s,]+/)
      let d = `M${p[0]} ${p[1]}`
      for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`
      return tag === 'polygon' ? d + 'Z' : d
    }
    case 'circle': case 'ellipse': {
      const rx = n(a.rx ?? a.r), ry = n(a.ry ?? a.r), cx = n(a.cx), cy = n(a.cy)
      return `M${n(cx - rx)} ${cy}A${rx} ${ry} 0 1 0 ${n(cx + rx)} ${cy}A${rx} ${ry} 0 1 0 ${n(cx - rx)} ${cy}Z`
    }
    case 'rect': {
      const x = n(a.x ?? 0), y = n(a.y ?? 0), w = n(a.width), h = n(a.height)
      const r = Math.min(n(a.rx ?? a.ry ?? 0), w / 2, h / 2)
      if (!r) return `M${x} ${y}h${w}v${h}h${-w}Z`
      return `M${x + r} ${y}h${n(w - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${n(h - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${r}h${n(2 * r - w)}a${r} ${r} 0 0 1 ${-r} ${-r}v${n(2 * r - h)}a${r} ${r} 0 0 1 ${r} ${-r}Z`
    }
    default: throw new Error(`unbekanntes Element ${tag}`)
  }
}
const lines = []
for (const f of readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
  const src = readFileSync(`${dir}/${f}`, 'utf8')
  const alias = src.match(/export \{ default \} from '\.\/(.+)\.mjs'/)
  if (alias) {
    lines.push(`${f.slice(0, -4)}\t=${alias[1]}`) // alter Name → aktueller
    continue
  }
  const m = src.match(/const __iconData = (\{[\s\S]*?\n\});/)
  if (!m) throw new Error(`${f}: kein Icon`)
  const data = Function(`return (${m[1]})`)()
  lines.push(`${data.name}\t${data.node.map(toPath).join(' ')}`)
}
writeFileSync('crates/dw-scene/assets/lucide.txt', `# lucide-react ${pkg.version} (ISC), erzeugt von tools/gen-icons.mjs\n${lines.join('\n')}\n`)
console.log(`${lines.length} Icons`)
