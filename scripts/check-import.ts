// Import per Link (yt-dlp, Chat, Heatmap), Netzteil opt-in mit DW_NET=1 (lädt ~20 MB; TMPDIR mit ≥ 3 GB frei, optional DW_TWITCH_VOD=<id>): npx esbuild scripts/check-import.ts --bundle --platform=node --outfile=${TMPDIR:-/tmp}/check-import.cjs && DECKWERK_HOME=${TMPDIR:-/tmp}/check-import-home node ${TMPDIR:-/tmp}/check-import.cjs
// CJS, weil jszip (CommonJS) im ESM-Bündel nicht laden könnte. Downloads und Modelle landen unter $TMPDIR.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegBin, probe, run } from '../src/main/ffmpeg'
import { twitchBin, twitchChat, twitchVodId } from '../src/main/twitch-chat'
import { chatTimes, chatWeight, checkUrl, heatPerSecond, importUrl, leftover, runTool, slimEnv } from '../src/main/ytdlp'

// Eine Chat-Zeile wie in <id>.live_chat.json; live: Offset auf oberster Ebene (Mitschnitt eines laufenden Streams)
const chatLine = (ms: string, item: object, live = false) =>
  JSON.stringify(live ? { replayChatItemAction: { actions: [{ addChatItemAction: { item } }] }, videoOffsetTimeMsec: ms, isLive: true } : { replayChatItemAction: { actions: [{ addChatItemAction: { item } }], videoOffsetTimeMsec: ms } })
const text = (...runs: object[]) => ({ liveChatTextMessageRenderer: { message: { runs } } })

async function main() {
  const base = process.env.TMPDIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'check-import-'))
  const models = join(base, 'check-import-models') // bleibt liegen, damit Binaries nicht jedes Mal neu laden
  try {
    // offline: Chat-Zeiten, Gewichte, Heatmap, VOD-ID
    const jsonl = [
      chatLine('12345', text({ text: 'das war ' }, { emoji: { shortcuts: [':KEKW:'] } })),
      'kaputt{',
      chatLine('13000', { liveChatTickerSponsorItemRenderer: {} }), // keine Nachricht
      chatLine('15000', text({ text: 'hallo' }), true),
    ].join('\n')
    assert.deepEqual(chatTimes(jsonl), [{ t: 12.345, w: 2 }, { t: 15, w: 1 }])
    assert.deepEqual(chatTimes(chatLine('20000', { liveChatPaidMessageRenderer: { purchaseAmountText: { simpleText: '5 €' } } })), [{ t: 20, w: 3 }], 'Super Chat')
    assert.equal(chatWeight('KEKW'), 2)
    assert.equal(chatWeight('hallo'), 1)
    assert.equal(chatWeight('???'), 2)
    for (const s of ['eclipse', 'apogee', 'Lulu', 'Wow']) assert.equal(chatWeight(s), 1, s)
    for (const s of ['PogChamp', 'clip it', 'lul']) assert.equal(chatWeight(s), 2, s)
    assert.equal(chatWeight(' w '), 2)
    assert.deepEqual(heatPerSecond([{ start_time: 0, end_time: 2, value: 0.5 }, { start_time: 2, end_time: 4, value: 1 }], 4), [0.5, 0.5, 1, 1])
    assert.equal(twitchVodId('https://www.twitch.tv/videos/2345678901?t=1h2m3s'), '2345678901')
    assert.equal(twitchVodId('twitch.tv/videos/42'), '42')
    assert.equal(twitchVodId('https://www.twitch.tv/somechannel'), null)
    assert.equal(twitchVodId('https://www.youtube.com/watch?v=jNQXAC9IVRw'), null)

    // Aufräumen trifft nur Zwischenreste der eigenen id
    for (const f of ['clip.info.json', 'clip.live_chat.json', 'clip.twitch-chat.json', 'clip.f137.mp4', 'clip.f140.m4a.part', 'clip.mp4.part', 'clip.mp4.part-Frag3', 'clip.mp4.ytdl', 'clip.temp.mp4', 'clip.live_chat.json.part'])
      assert.ok(leftover('clip', f), f)
    for (const f of ['clip.mp4', 'clip.chat.json', 'clip.v2.mp4', 'clip.v2.chat.json', 'clip.v2.mp4.part', 'clip.v2.info.json', 'clipx.info.json'])
      assert.ok(!leftover('clip', f), f)

    // Fremde Programme sehen keine API-Schlüssel; Stillstand beendet den Prozess
    process.env.ANTHROPIC_API_KEY = 'geheim'
    const seen: string[] = []
    await runTool(process.execPath, ['-e', 'console.log(process.env.ANTHROPIC_API_KEY ?? "leer", process.env.X)'], slimEnv({ X: 'eins' }), (l) => seen.push(l))
    assert.deepEqual(seen, ['leer eins'], 'Schlüssel nicht durchgereicht')
    assert.ok(slimEnv().PATH, 'PATH bleibt')
    const t0 = Date.now()
    assert.equal((await runTool(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], slimEnv(), undefined, 300)).stalled, true)
    assert.ok(Date.now() - t0 < 5000, 'Stillstand beendet den Prozess')

    // Vertrauensgrenze: abgelehnt vor mkdir, also vor jedem Spawn
    const target = join(dir, 'nie-angelegt')
    for (const bad of ['file:///etc/passwd', '--exec=id', 'javascript:alert(1)', 'https://example.com/\nx', `https://example.com/${'a'.repeat(2000)}`])
      await assert.rejects(importUrl(bad, target, { models, ffmpeg: 'ffmpeg' }), /Link/, bad.slice(0, 40))
    // SSRF: Ziele im eigenen Netz (auch in anderer Schreibweise) ebenso vor jedem Spawn
    for (const bad of ['http://127.0.0.1/x', 'http://192.168.1.1/x', 'http://[::1]/x', 'http://foo.local/x', 'http://localhost:8080/x', 'http://2130706433/x', 'http://[::ffff:10.0.0.1]/x', 'http://169.254.169.254/latest', 'http://172.20.0.1/x', 'http://0.0.0.0/x'])
      await assert.rejects(importUrl(bad, target, { models, ffmpeg: 'ffmpeg' }), /eigenen Netz/, bad)
    assert.ok(!existsSync(target), 'Zielordner darf nicht entstehen')
    for (const ok of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.twitch.tv/videos/1864746279', 'https://kick.com/video/x', 'https://localnews.example/v', 'https://172.32.0.1/v'])
      assert.equal(checkUrl(ok).href, ok)
    // Imports laufen nacheinander; ein gescheiterter hält die Warteschlange nicht an
    const blocker = join(dir, 'datei')
    writeFileSync(blocker, '')
    const [a, b] = [importUrl('https://example.com/a', join(blocker, 'a'), { models, ffmpeg: 'ffmpeg' }), importUrl('https://example.com/b', join(blocker, 'b'), { models, ffmpeg: 'ffmpeg' })]
    await assert.rejects(a, /datei\/a/)
    await assert.rejects(b, /datei\/b/)
    console.log('offline ok')

    if (!process.env.DW_NET) return console.log('Netz übersprungen (DW_NET=1 setzen)')
    const ffmpeg = await ffmpegBin()

    // kurzes, frei lizenziertes Video: „Me at the zoo“ (19 s, CC BY 3.0, Lizenzprüfung auf Wikimedia Commons)
    const pcts: number[] = []
    const imp = await importUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw', join(dir, 'import'), { models, ffmpeg, onProgress: (p) => pcts.push(p) })
    console.log('importiert:', imp.file, imp.title, imp.duration, 'Fortschritt:', pcts.slice(-3))
    assert.match(imp.file, /jNQXAC9IVRw\.mp4$/)
    assert.ok(imp.title.length > 0 && imp.duration > 10 && imp.duration < 30, 'Titel und Dauer')
    const info = await probe(imp.file)
    assert.ok(info.w > 0 && info.audio, 'probe: Bild und Ton')
    assert.ok(Math.abs(info.duration - imp.duration) < 2, 'Dauer passt zur Datei')
    assert.ok(pcts.length > 0, 'Fortschritt gemeldet')

    // Heatmap nur aus den Metadaten eines populären, langen Videos (Big Buck Bunny, CC BY), ohne Download
    const pinned = join(models, 'yt-dlp-2026.08.19')
    const ytdlp = existsSync(pinned) ? pinned : 'yt-dlp'
    const j = await run(ytdlp, ['--ignore-config', '--js-runtimes', `node:${process.execPath}`, '-J', '--skip-download', '--', 'https://www.youtube.com/watch?v=YE7VzlLtp-4'])
    assert.equal(j.code, 0, j.err.slice(-500))
    const meta = JSON.parse(j.out.toString())
    assert.ok(meta.heatmap?.length, 'heatmap vorhanden')
    const heat = heatPerSecond(meta.heatmap, meta.duration)
    assert.ok(heat.length > 0 && heat.some((v) => v > 0), 'heatPerSecond nicht leer')
    console.log('heatmap:', meta.heatmap.length, 'Abschnitte →', heat.length, 's')

    // YouTube-Chat-Replay eines ehemaligen Livestreams (JPL Clean Room Q&A, 21 min), nur der Chat-Aufruf aus importUrl, ohne Video
    const ytChat = await runTool(ytdlp, ['--ignore-config', '--no-playlist', '--js-runtimes', `node:${process.execPath}`, '--skip-download', '--write-subs', '--sub-langs', 'live_chat',
      '-P', dir, '-o', '%(id)s.%(ext)s', '--', 'https://www.youtube.com/watch?v=3P22d-UBcXU'], slimEnv({ ELECTRON_RUN_AS_NODE: '1' }))
    assert.equal(ytChat.code, 0, ytChat.err.slice(-500))
    const yc = chatTimes(readFileSync(join(dir, '3P22d-UBcXU.live_chat.json'), 'utf8'))
    assert.ok(yc.length > 0 && yc.every((c) => c.t >= 0 && c.t < 1400 && c.w >= 1), 'YouTube-Chat mit plausiblen Zeiten')
    console.log('YouTube-Chat:', yc.length, 'Nachrichten, bis', Math.max(...yc.map((c) => c.t)), 's')

    // TwitchDownloaderCLI: Laden von GitHub muss klappen; Netzfehler bei Twitch selbst nur melden
    const td = await twitchBin(models)
    const help = await run(td, ['--help'], { env: slimEnv({ DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' }) })
    assert.match(help.out.toString() + help.err, /chatdownload/, 'TwitchDownloaderCLI --help')
    console.log('TwitchDownloaderCLI:', td)
    const offline = (e: Error) => console.log('  Twitch nicht erreichbar (kein Fehler):', e.message)
    const plausible = (c: { t: number; w: number }[], max: number) => c.length >= 1 && c.every((x) => x.t >= 0 && x.t <= max && x.w >= 1)
    // Highlights bleiben (anders als VODs) dauerhaft; 1864746279: 85 s, ~200 Kommentare. Aktuelles VOD per DW_TWITCH_VOD.
    const vod = process.env.DW_TWITCH_VOD ?? '1864746279'
    await twitchChat(vod, join(dir, 'twitch.json'), { models }).then((c) => {
      assert.ok(plausible(c, 2 * 86400), 'Twitch-Chat: mindestens ein Kommentar, Zeiten plausibel')
      console.log('Twitch-Chat', vod, ':', c.length, 'Kommentare, bis', Math.max(...c.map((x) => x.t)), 's')
    }, offline)
    // ganzer Import eines kurzen Highlights (≤ 2 min) mit Chat
    await importUrl('https://www.twitch.tv/videos/1864746279', join(dir, 'twitch'), { models, ffmpeg }).then((tw) => {
      assert.ok(/v1864746279\.mp4$/.test(tw.file) && tw.duration > 60 && tw.duration < 120, `Twitch-Import: ${tw.file} ${tw.duration}`)
      if (!tw.chat) return console.log('  Twitch-Chat beim Import fehlt (Netz?)')
      assert.ok(plausible(JSON.parse(readFileSync(tw.chat, 'utf8')), tw.duration + 5), 'Twitch-Import: Chat-Zeiten im Video')
      console.log('Twitch-Import:', tw.title, tw.duration, 's, Chat', tw.chat)
    }, offline)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().then(() => console.log('check-import: ok'), (e) => { console.error(e); process.exit(1) })
