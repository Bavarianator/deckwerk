//! Pro-Timeline → ffmpeg (`main/timeline-ffmpeg.ts`): Argumente je Abschnitt zwischen zwei Schnittpunkten. Rein, startet kein ffmpeg.

use crate::grade::sat_filter;
use crate::model::*;
use dw_lint::js::{num, round};

#[derive(Debug, Clone)]
pub struct Section<'a> {
    pub start: f64,
    pub end: f64,
    pub video: Vec<Active<'a>>,
    pub audio: Vec<Active<'a>>,
}

/// `String(Math.round(v * 1e6) / 1e6)`
pub(crate) fn n6(v: f64) -> String {
    num(round(v * 1e6) / 1e6)
}
pub(crate) fn even(n: f64) -> f64 {
    2f64.max(round(n / 2.0) * 2.0)
}
fn atempo(sp: f64) -> Vec<String> {
    if sp > 2.0 {
        let mut v = vec!["atempo=2".to_string()];
        v.extend(atempo(sp / 2.0));
        v
    } else if sp < 0.5 {
        let mut v = vec!["atempo=0.5".to_string()];
        v.extend(atempo(sp / 0.5));
        v
    } else if sp == 1.0 {
        vec![]
    } else {
        vec![format!("atempo={}", n6(sp))]
    }
}
/// Standbilder (Logo, Foto auf V2+): laufen als Schleife, haben keinen Ton
pub fn is_image(src: &str) -> bool {
    let s = src.to_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"]
        .iter()
        .any(|e| s.ends_with(e))
}
/// Wert einer Filteroption in filter_complex: erst für die Option (\ ' :), dann für den Graphen (\ ' [ ] , ;) escapen
pub fn esc_opt(s: &str) -> String {
    let esc = |s: &str, set: &str| {
        s.chars().fold(String::new(), |mut o, c| {
            if set.contains(c) {
                o.push('\\');
            }
            o.push(c);
            o
        })
    };
    esc(&esc(s, "\\':"), "\\'[],;")
}

// Knicke der Blenden: Fenster der Überblendungen und Fade-Grenzen, damit Rampen je Abschnitt linear sind
fn blend_points(tracks: &[TlTrack]) -> Vec<f64> {
    let mut out = Vec::new();
    for t in tracks {
        for x in xfades(&t.clips) {
            out.push(x.a);
            out.push(x.b);
        }
        for c in &t.clips {
            let [fi, fo] = c.fade.unwrap_or([0.0, 0.0]);
            let end = clip_end(c);
            let mut ps = vec![c.at + fi, end - fo];
            if fi > 0.0 && fo > 0.0 {
                ps.push((c.at * fo + end * fi) / (fi + fo));
            }
            out.extend(ps.into_iter().filter(|&p| p > c.at && p < end));
        }
    }
    out
}

/// Bildrate für sections ohne Angabe: die der Ausgabe, ohne deliver 30
pub fn default_fps(tl: &TimelineContent) -> f64 {
    if tl.deliver.is_some() {
        deliver_of(tl).fps
    } else {
        30.0
    }
}

/// Abschnitte zwischen allen Schnittpunkten mit den aktiven Clips: video von unten nach oben (ohne ausgeblendete Spuren),
/// audio = Clips der Audiospuren und Ton der Videoclips ohne stumme Spuren/Clips. src = Quellsekunde bei start.
/// Im Fenster einer Überblendung tragen from und to bei.
pub fn sections(tl: &TimelineContent, fps: f64) -> Vec<Section<'_>> {
    let cuts = cut_points(&tl.tracks);
    let last = *cuts.last().unwrap();
    // Blendpunkte aufs Bildraster, nah an einem Schnitt verworfen: Abschnitte unter einem Bild gäben leere Segmente
    let bp: Vec<f64> = blend_points(&tl.tracks)
        .into_iter()
        .map(|p| snap_frame(p, fps))
        .filter(|&p| cuts.iter().all(|&c| (c - p).abs() >= 0.5 / fps))
        .collect();
    let ts = if bp.is_empty() {
        cuts.clone()
    } else {
        let all: Vec<f64> = cuts
            .iter()
            .chain(&bp)
            .map(|x| round(x * 1e4) / 1e4)
            .filter(|&x| x >= 0.0 && x <= last)
            .collect();
        uniq_sorted(all)
    };
    let mut out = Vec::new();
    for k in 1..ts.len() {
        let (start, end) = (ts[k - 1], ts[k]);
        let mid = (start + end) / 2.0;
        if end - start < 1e-6 {
            continue;
        }
        let mut sec = Section {
            start,
            end,
            video: vec![],
            audio: vec![],
        };
        for (index, track) in tl.tracks.iter().enumerate() {
            // Mitte statt start: cutPoints rundet auf 1e-4, an der Kante könnte der Clip knapp fehlen
            let clips: Vec<(&TlClip, f64)> = match xfade_at(&track.clips, mid) {
                // to beginnt vor in: Quelle auf ≥ 0 geklemmt, den Versatz gleicht video_args aus (K14)
                Some((x, _)) => vec![
                    (x.from, src_at(x.from, start)),
                    (x.to, 0f64.max(src_at(x.to, start))),
                ],
                // wie activeAt: bei Überlappung gewinnt der spätere
                None => track
                    .clips
                    .iter()
                    .rfind(|c| mid >= c.at && mid < clip_end(c))
                    .map(|c| (c, src_at(c, start)))
                    .into_iter()
                    .collect(),
            };
            let hidden = track.kind == Kind::Video && track.hide == Some(true);
            for (clip, src) in clips {
                let a = Active {
                    track,
                    clip,
                    index,
                    src,
                };
                if track.kind == Kind::Video && !hidden {
                    sec.video.push(a);
                }
                // Befund K17 (§7.2): TS mischte den Ton ausgeblendeter Videospuren mit, die Vorschau (activeAt) nicht.
                // Jetzt wie die Vorschau: hide nimmt die ganze Spur heraus, mute nur den Ton.
                if !hidden
                    && track.mute != Some(true)
                    && clip.mute != Some(true)
                    && !is_image(&clip.src)
                {
                    sec.audio.push(a);
                }
            }
        }
        out.push(sec);
    }
    out
}

/// Ausgabegröße: res = kurze Seite, Seitenverhältnis w/h von der Folie; gerade px
pub fn size(deliver: &Deliver, aspect: f64) -> (f64, f64) {
    if aspect >= 1.0 {
        (even(deliver.res * aspect), deliver.res)
    } else {
        (deliver.res, even(deliver.res / aspect))
    }
}

// Eingang eines Clips: ab Quellsekunde src so viel Quelle, wie der Abschnitt bei speed verbraucht; Bilder als Schleife
fn input(a: &Active, sec: &Section, fps: &str) -> Vec<String> {
    let len = sec.end - sec.start;
    if is_image(&a.clip.src) {
        vec![
            "-loop".into(),
            "1".into(),
            "-framerate".into(),
            fps.into(),
            "-t".into(),
            n6(len),
            "-i".into(),
            a.clip.src.clone(),
        ]
    } else {
        vec![
            "-ss".into(),
            n6(a.src),
            "-t".into(),
            n6(len * speed_of(a.clip)),
            "-i".into(),
            a.clip.src.clone(),
        ]
    }
}

// crop füllt (horizontal um focus), contain zeigt alles mit schwarzem Rand
fn fit_filter(c: &TlClip, w: f64, h: f64) -> String {
    let (w, h) = (num(w), num(h));
    if c.fit == Some(Fit::Contain) {
        return format!(
            "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
        );
    }
    format!(
        "scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}:clip({}*iw-ow/2\\,0\\,iw-ow):(ih-oh)/2",
        n6(c.focus.unwrap_or(0.5))
    )
}

/// Blend-Rampen eines Clips im Abschnitt als [Wert bei start, Wert bei end]: fade und Überblendanteil (to: k, im Ton from: 1−k)
pub fn ramps(a: &Active, start: f64, end: f64, audio: bool) -> [[f64; 2]; 2] {
    let x = xfade_at(&a.track.clips, (start + end) / 2.0).map(|(x, _)| x);
    let id = &a.clip.id;
    let k = |t: f64| x.map_or(1.0, |x| 0f64.max(1f64.min((t - x.a) / (x.b - x.a))));
    let share = |t: f64| match x {
        Some(x) if &x.to.id == id => k(t),
        Some(x) if audio && &x.from.id == id => 1.0 - k(t),
        _ => 1.0,
    };
    [
        [fade_gain(a.clip, start), fade_gain(a.clip, end)],
        [share(start), share(end)],
    ]
}

// Alpha-Rampe g0→g1 über len s mit fade (alpha). fade kennt nur start_time ≥ 0: PTS um den Vorlauf verschieben
fn alpha_ramp([g0, g1]: [f64; 2], len: f64) -> Vec<String> {
    if (g1 - g0).abs() < 1e-6 {
        return if g0 > 1.0 - 1e-6 {
            vec![]
        } else {
            vec![format!("colorchannelmixer=aa={}", n6(g0))]
        };
    }
    let d = len / (g1 - g0).abs();
    let off = (if g1 > g0 { g0 } else { 1.0 - g0 }) * d;
    vec![
        format!("setpts=PTS+{}/TB", n6(off)),
        format!(
            "fade=t={}:d={}:alpha=1",
            if g1 > g0 { "in" } else { "out" },
            n6(d)
        ),
        "setpts=PTS-STARTPTS".into(),
    ]
}

/// Versatz (s), um den ein Clip im Abschnitt später einsetzt: to einer Überblendung mit auf 0 geklemmter Quelle
fn onset(a: &Active, sec: &Section) -> f64 {
    0f64.max(tl_at(a.clip, a.src) - sec.start)
}

/// ffmpeg-Argumente für das Bild eines Abschnitts (Eingänge, filter_complex, -map [vout]), ohne Codec und Ausgabe.
/// lut_path liefert die .cube-Datei eines Clips mit Farbkorrektur.
pub fn video_args(
    sec: &Section,
    deliver: &Deliver,
    aspect: f64,
    lut_path: &dyn Fn(&TlClip) -> Option<String>,
) -> Vec<String> {
    let (big_w, big_h) = size(deliver, aspect);
    let r = fps_arg(deliver.fps);
    let len = sec.end - sec.start;
    let n = sec.video.len();
    // Farbe in RGB wie die Vorschau: erst format, dann lut1d, dann Sättigung; 10-bit-Codecs in gbrp10le
    let rgb = if deliver.codec == Codec::H264 {
        "rgb24"
    } else {
        "gbrp10le"
    };
    let yuv = match deliver.codec {
        Codec::H264 => None,
        Codec::H264_10 => Some("yuv420p10"),
        _ => Some("yuv422p10"),
    };
    let mut args: Vec<String> = sec.video.iter().flat_map(|a| input(a, sec, &r)).collect();
    args.extend([
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!(
            "color=black:s={}x{}:r={r}:d={}{}",
            num(big_w),
            num(big_h),
            n6(len),
            yuv.map_or(String::new(), |y| format!(",format={y}le"))
        ),
    ]);
    let mut f: Vec<String> = Vec::new();
    let mut last = format!("[{n}:v]");
    for (i, a) in sec.video.iter().enumerate() {
        let c = a.clip;
        let (w, h) = match c.box_ {
            Some(b) => (even(b[2] * big_w), even(b[2] * big_h)),
            None => (big_w, big_h),
        };
        let lut = lut_path(c);
        let sat = sat_filter(c.grade.as_ref().and_then(|g| g.sat));
        let alpha: Vec<String> = ramps(a, sec.start, sec.end, false)
            .into_iter()
            .flat_map(|g| alpha_ramp(g, len))
            .collect();
        // Befund K14 (§7.2): to einer Überblendung mit auf 0 geklemmter Quelle lief im Bild zu früh los, der Ton wartete per adelay.
        // Jetzt wartet auch das Bild: vorn durchsichtige Bilder (tpad), danach greift die Alpha-Rampe auf der Abschnittszeit.
        let delay = onset(a, sec);
        let pad = if delay >= 0.5 / deliver.fps {
            vec![format!("tpad=start_duration={}:color=black@0", n6(delay))]
        } else {
            vec![]
        };
        let alpha_fmt = if rgb == "rgb24" { "rgba" } else { "gbrap10le" };
        let speed = if is_image(&c.src) { 1.0 } else { speed_of(c) };
        let mut chain = vec![
            format!("setpts=(PTS-STARTPTS)/{}", n6(speed)),
            format!("fps={r}"),
            fit_filter(c, w, h),
            "setsar=1".into(),
        ];
        if lut.is_some() || sat.is_some() {
            chain.push(format!("format={rgb}"));
        }
        if let Some(l) = &lut {
            chain.push(format!("lut1d=file={}", esc_opt(l)));
        }
        if let Some(s) = sat {
            chain.push(s);
        }
        // overlay nimmt das Alpha; V1 über Schwarz = Blende zu/aus Schwarz
        if !alpha.is_empty() || !pad.is_empty() {
            chain.push(format!("format={alpha_fmt}"));
            chain.extend(pad);
            chain.extend(alpha);
        }
        f.push(format!("[{i}:v]{}[c{i}]", chain.join(",")));
        let out = if i == n - 1 {
            "[vout]".to_string()
        } else {
            format!("[o{i}]")
        };
        let pos = match c.box_ {
            Some(b) => format!("{}:{}", num(round(b[0] * big_w)), num(round(b[1] * big_h))),
            None => "0:0".into(),
        };
        f.push(format!(
            "{last}[c{i}]overlay={pos}:eof_action=pass{}{out}",
            yuv.map_or(String::new(), |y| format!(":format={y}"))
        ));
        last = out;
    }
    if n == 0 {
        f.push(format!("{last}null[vout]"));
    }
    args.extend([
        "-filter_complex".into(),
        f.join(";"),
        "-map".into(),
        "[vout]".into(),
    ]);
    args
}

/// Pegel-Keys [Quellsekunde, dB] als Faktor für volume=…:eval=frame, t = Sekunde im Abschnitt; Kommas für filter_complex escapt
pub fn key_expr(keys: &[[f64; 2]], clip: &TlClip, offset: f64) -> String {
    let mut ks = keys.to_vec();
    ks.sort_by(|a, b| by(a[0] - b[0]));
    let pt: Vec<[f64; 2]> = ks
        .iter()
        .map(|&[s, db]| [tl_at(clip, s) - offset, DB.max.min(DB.min.max(db))])
        .collect();
    let Some(l) = pt.last() else {
        return "1".into();
    };
    let mut e = n6(l[1]);
    for k in (0..pt.len() - 1).rev() {
        let ([ta, va], [tb, vb]) = (pt[k], pt[k + 1]);
        if tb > ta {
            e = format!(
                "if(lt(t,{}),{}+({})*max(0,t-({})),{e})",
                n6(tb),
                n6(va),
                n6((vb - va) / (tb - ta)),
                n6(ta)
            );
        }
    }
    format!("pow(10,({e})/20)").replace(',', "\\,")
}

/// ffmpeg-Argumente für den Ton eines Abschnitts (Eingänge, filter_complex, -map [aout]); 0 Clips = Stille.
/// Nimmt an, dass jede Quelle Ton hat (der Aufrufer setzt mute bei Videos ohne Tonspur).
pub fn audio_args(sec: &Section, sample_rate: u32) -> Vec<String> {
    let aud: Vec<&Active> = sec
        .audio
        .iter()
        .filter(|a| !is_image(&a.clip.src))
        .collect();
    let len = sec.end - sec.start;
    let (ls, n) = (n6(len), aud.len());
    if n == 0 {
        return vec![
            "-f".into(),
            "lavfi".into(),
            "-t".into(),
            ls.clone(),
            "-i".into(),
            format!("anullsrc=r={sample_rate}:cl=stereo"),
            "-filter_complex".into(),
            format!("[0:a]atrim=0:{ls}[aout]"),
            "-map".into(),
            "[aout]".into(),
        ];
    }
    let mut args: Vec<String> = aud.iter().flat_map(|a| input(a, sec, "")).collect();
    let mut f: Vec<String> = aud
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let c = a.clip;
            let sp = speed_of(c);
            let eq = c.eq.clone().unwrap_or_default();
            // ab der Quellsekunde src: to einer Überblendung mit auf 0 geklemmter Quelle setzt verspätet ein
            let delay = round(onset(a, sec) * 1000.0);
            let rs: Vec<[f64; 2]> = ramps(a, sec.start, sec.end, true)
                .into_iter()
                .filter(|&[g0, g1]| g0 < 1.0 - 1e-6 || g1 < 1.0 - 1e-6)
                .collect();
            let gain = if rs.is_empty() {
                "1".to_string()
            } else {
                rs.iter()
                    .map(|&[g0, g1]| format!("({}+({})*t)", n6(g0), n6((g1 - g0) / len)))
                    .collect::<Vec<_>>()
                    .join("*")
            };
            let mut chain = vec![
                format!("atrim=0:{}", n6(len * sp)),
                "asetpts=PTS-STARTPTS".into(),
                format!("aformat=sample_rates={sample_rate}:channel_layouts=stereo"),
            ];
            chain.extend(atempo(sp));
            chain.push(format!(
                "volume={}",
                n6(c.volume.unwrap_or(1.0) * a.track.volume.unwrap_or(1.0))
            ));
            if let Some(k) = c.keys.as_ref().filter(|k| !k.is_empty()) {
                chain.push(format!("volume={}:eval=frame", key_expr(k, c, sec.start)));
            }
            if gain != "1" {
                chain.push(format!("volume={gain}:eval=frame"));
            }
            let nz = |v: Option<f64>| v.filter(|&v| v != 0.0 && !v.is_nan());
            if let Some(v) = nz(eq.low) {
                chain.push(format!("lowshelf=f={}:g={}", num(EQ_HZ[0]), n6(v)));
            }
            if let Some(v) = nz(eq.mid) {
                chain.push(format!("equalizer=f={}:t=q:w=1:g={}", num(EQ_HZ[1]), n6(v)));
            }
            if let Some(v) = nz(eq.high) {
                chain.push(format!("highshelf=f={}:g={}", num(EQ_HZ[2]), n6(v)));
            }
            if delay != 0.0 {
                chain.push(format!("adelay={}:all=1", num(delay)));
            }
            format!("[{i}:a]{}[a{i}]", chain.join(","))
        })
        .collect();
    let labels: String = (0..n).map(|i| format!("[a{i}]")).collect();
    f.push(format!(
        "{labels}amix=inputs={n}:normalize=0:duration=longest,apad,atrim=0:{ls}[aout]"
    ));
    args.extend([
        "-filter_complex".into(),
        f.join(";"),
        "-map".into(),
        "[aout]".into(),
    ]);
    args
}

pub struct Encode {
    pub args: Vec<String>,
    pub ext: &'static str,
    pub encoder: &'static str,
}

/// Video-Codec der Ausgabe (Ton muxt der Aufrufer getrennt, siehe audio_codec)
pub fn encode_args(deliver: &Deliver) -> Encode {
    let r = ["-r".to_string(), fps_arg(deliver.fps)];
    let v = |xs: &[&str]| {
        xs.iter()
            .map(|s| s.to_string())
            .chain(r.iter().cloned())
            .collect::<Vec<_>>()
    };
    match deliver.codec {
        Codec::H264_10 => Encode {
            ext: "mp4",
            encoder: "libx264",
            args: v(&[
                "-c:v",
                "libx264",
                "-profile:v",
                "high10",
                "-pix_fmt",
                "yuv420p10le",
                "-crf",
                "18",
            ]),
        },
        Codec::Prores => Encode {
            ext: "mov",
            encoder: "prores_ks",
            args: v(&[
                "-c:v",
                "prores_ks",
                "-profile:v",
                "3",
                "-pix_fmt",
                "yuv422p10le",
            ]),
        },
        Codec::Dnxhr => Encode {
            ext: "mov",
            encoder: "dnxhd",
            args: v(&[
                "-c:v",
                "dnxhd",
                "-profile:v",
                "dnxhr_hqx",
                "-pix_fmt",
                "yuv422p10le",
            ]),
        },
        Codec::H264 => Encode {
            ext: "mp4",
            encoder: "libx264",
            args: v(&[
                "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            ]),
        },
    }
}

/// Ton-Codec passend zum Container: AAC in mp4, PCM 24 bit in mov
pub fn audio_codec(deliver: &Deliver) -> Vec<String> {
    let a: &[&str] = if encode_args(deliver).ext == "mov" {
        &["-c:a", "pcm_s24le"]
    } else {
        &["-c:a", "aac", "-b:a", "256k"]
    };
    a.iter().map(|s| s.to_string()).collect()
}

/// Grobe Exportdauer in s. ponytail: Annahme 16:9 und ~1,2e8 px/s (libx264 medium, 2 Kerne), je Ebene 30 % Zuschlag; am echten Durchsatz kalibrieren
pub fn estimate(tl: &TimelineContent, deliver: &Deliver) -> f64 {
    let (w, h) = size(deliver, 16.0 / 9.0);
    // Befund K15 (§7.2): TS rechnete die Abschnitte mit der fps aus tl.deliver bzw. 30 statt mit der übergebenen Ausgabe
    let layers = sections(tl, deliver.fps).iter().fold(0.0, |s, x| {
        s + (x.end - x.start) * 0f64.max(x.video.len() as f64 - 1.0)
    });
    (w * h * deliver.fps * (tl_duration(&tl.tracks) + 0.3 * layers)) / 1.2e8
}
