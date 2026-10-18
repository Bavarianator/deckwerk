//! Mehrspur-Timeline als Final-Cut-7-XML (xmeml 5) für Premiere Pro und DaVinci Resolve (`main/export-xmeml-tl.ts`).
//! Spuren: V1…Vn wie die Videospuren, dann je Videospur mit Ton ein Stereo-Paar (verlinkt mit dem Bild), dann je Audiospur ein Paar.
//! Zeiten je Clip aus round(at·fps) und round(clipEnd·fps), nie als Summe gerundeter Längen: kein Drift.
//!
//! Befund K18 (§7.2): TS verwarf Pegel, Farbe, Zuschnitt, Bild-in-Bild und Untertitel. Neu (alles zusätzlich, der Rest wortgleich wie TS):
//! - Pegel: `Audio Levels` je Ton-clipitem aus volume × Spur-volume, Keys als Keyframes (Bild ab Clip-Anfang in der Sequenz)
//! - Farbe: `Color Corrector 3-way` mit Sättigung, die exakten Werte (lift/gamma/gain/temp) als `<comments>` am clipitem
//! - Zuschnitt und Bild-in-Bild: `Basic Motion` (scale in %, center als Versatz in Bildbreiten/-höhen)
//! - Untertitel: eigene oberste Videospur mit Text-Generatoren (aus bei captions 'aus'); die SRT daneben bleibt
//!
//! EQ hat in xmeml kein gemeinsames Gegenstück und fehlt weiter. Die neuen Filter sind nach FCP7-XML-Doku gebaut, in Premiere/Resolve ungeprüft.

use crate::model::*;
use dw_lint::js::{num, round, to_fixed};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
pub struct Info {
    pub duration: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    /// Quelle hat Ton (nur Export; xmeml nimmt bei Videos immer Stereoton an)
    #[serde(default)]
    pub audio: bool,
}

#[derive(Clone, Copy)]
struct Rate {
    tb: f64,
    ntsc: bool,
    real: f64,
}
fn rate_of(fps: Option<f64>) -> Rate {
    let fps = fps.filter(|f| f.is_finite() && *f > 0.0).unwrap_or(30.0);
    let tb = 1f64.max(round(fps));
    let ntsc = (fps - (tb * 1000.0) / 1001.0).abs() < (fps - tb).abs();
    Rate {
        tb,
        ntsc,
        real: if ntsc { (tb * 1000.0) / 1001.0 } else { tb },
    }
}
fn rate(r: Rate) -> String {
    format!(
        "<rate><timebase>{}</timebase><ntsc>{}</ntsc></rate>",
        num(r.tb),
        if r.ntsc { "TRUE" } else { "FALSE" }
    )
}
fn esc(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        match c {
            '\x00'..='\x08' | '\x0B' | '\x0C' | '\x0E'..='\x1F' => {}
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            c => o.push(c),
        }
    }
    o
}
/// `pathToFileURL(p).href` mit file://localhost/
pub fn file_url(p: &str) -> String {
    let abs = if p.starts_with('/') {
        p.to_string()
    } else {
        std::env::current_dir()
            .map(|d| d.join(p).to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.into())
    };
    let mut o = String::from("file://localhost");
    for b in abs.bytes() {
        if b <= 0x20 || b >= 0x7F || b"\"#%<>?`{}\\".contains(&b) {
            o.push_str(&format!("%{b:02X}"));
        } else {
            o.push(b as char);
        }
    }
    o
}
fn basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or(p)
}
fn param(id: &str, value: &str, range: Option<(&str, &str)>) -> String {
    let r = range.map_or(String::new(), |(a, b)| {
        format!("<valuemin>{a}</valuemin><valuemax>{b}</valuemax>")
    });
    format!(
        "<parameter authoringApp=\"PremierePro\"><parameterid>{id}</parameterid><name>{id}</name>{r}<value>{value}</value></parameter>"
    )
}
fn remap(sp: f64, video: bool) -> String {
    format!(
        "<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype>{}{}{}{}{}</effect></filter>",
        if video {
            "<mediatype>video</mediatype>"
        } else {
            ""
        },
        param("variablespeed", "0", Some(("0", "1"))),
        param(
            "speed",
            &num(to_fixed(sp * 100.0, 4).parse().unwrap()),
            Some(("-100000", "100000"))
        ),
        param("reverse", "FALSE", None),
        param("frameblending", "FALSE", None)
    )
}

// Ein clipitem; track 0 = Bild, 1/2 = linker/rechter Kanal. group = Indizes aller verlinkten clipitems
struct Item<'a> {
    id: String,
    c: &'a TlClip,
    gain: f64,
    info: Info,
    r: Rate,
    sp: f64,
    start: f64,
    end: f64,
    in_: f64,
    out: f64,
    track: u8,
    t_idx: usize,
    c_idx: usize,
    group: Vec<usize>,
}

struct Pair {
    enabled: bool,
    l: Vec<usize>,
    r: Vec<usize>,
}

struct Ctx<'a, 'i> {
    items: Vec<Item<'a>>,
    info: &'i HashMap<String, Info>,
    sr: Rate,
}

impl<'a> Ctx<'a, '_> {
    fn make(&mut self, c: &'a TlClip, gain: f64, track: u8, t_idx: usize, c_idx: usize) -> usize {
        let fr = |t: f64| round(t * self.sr.real);
        let info = self.info.get(&c.src).copied().unwrap_or(Info {
            duration: c.out,
            ..Default::default()
        });
        let r = rate_of(info.fps);
        let sp = speed_of(c);
        let (start, end) = (fr(c.at), fr(clip_end(c)));
        // in/out in Bildern der Quelle, mit Tempo in umgerechneter Zeit (Quellbild / Tempo)
        let in_f = round((c.in_ * r.real) / sp);
        let n = self.items.len();
        let out = in_f + round(((end - start) * r.real) / self.sr.real);
        self.items.push(Item {
            id: format!("clipitem-{}", n + 1),
            c,
            gain,
            info,
            r,
            sp,
            start,
            end,
            in_: in_f,
            out,
            track,
            t_idx,
            c_idx,
            group: vec![],
        });
        n
    }
    fn pair_of(
        &mut self,
        pairs: &mut Vec<Pair>,
        cs: Vec<&'a TlClip>,
        track: &TlTrack,
        enabled: bool,
        bild: Option<&[usize]>,
    ) {
        let p = pairs.len();
        let (mut l, mut r) = (vec![], vec![]);
        for (j, c) in cs.into_iter().enumerate() {
            let g = c.volume.unwrap_or(1.0) * track.volume.unwrap_or(1.0);
            let a = self.make(c, g, 1, 2 * p + 1, l.len() + 1);
            let b = self.make(c, g, 2, 2 * p + 2, l.len() + 1);
            let group = match bild.and_then(|v| v.get(j)) {
                Some(&v) => vec![v, a, b],
                None => vec![a, b],
            };
            for &k in &group {
                self.items[k].group = group.clone();
            }
            l.push(a);
            r.push(b);
        }
        if !l.is_empty() {
            pairs.push(Pair { enabled, l, r });
        }
    }
}

pub struct XmemlOpts<'a> {
    pub name: &'a str,
    pub fps: f64,
    pub w: f64,
    pub h: f64,
    pub info: &'a HashMap<String, Info>,
}

pub fn xmeml_timeline<'a>(tl: &'a TimelineContent, opts: &XmemlOpts) -> String {
    let sr = rate_of(Some(opts.fps));
    let seq = rate(sr);
    let fr = |t: f64| round(t * sr.real);
    let mut cx = Ctx {
        items: Vec::new(),
        info: opts.info,
        sr,
    };
    let sorted = |cs: &'a [TlClip]| -> Vec<&'a TlClip> {
        sorted_refs(cs)
            .into_iter()
            .filter(|c| fr(clip_end(c)) > fr(c.at))
            .collect()
    };

    let v_tracks: Vec<&TlTrack> = tl.tracks.iter().filter(|t| t.kind == Kind::Video).collect();
    let a_src: Vec<&TlTrack> = tl.tracks.iter().filter(|t| t.kind == Kind::Audio).collect();
    let video: Vec<(&TlTrack, Vec<usize>)> = v_tracks
        .iter()
        .enumerate()
        .map(|(i, t)| {
            (
                *t,
                sorted(&t.clips)
                    .into_iter()
                    .enumerate()
                    .map(|(j, c)| cx.make(c, 1.0, 0, i + 1, j + 1))
                    .collect(),
            )
        })
        .collect();
    // Stereo-Paare: Ton der Videoclips (ohne mute), danach die Audiospuren
    let mut pairs: Vec<Pair> = Vec::new();
    for (t, its) in &video {
        let loud: Vec<usize> = its
            .iter()
            .copied()
            .filter(|&k| cx.items[k].c.mute != Some(true))
            .collect();
        let cs: Vec<&TlClip> = loud.iter().map(|&k| cx.items[k].c).collect();
        // K17: Ton einer ausgeblendeten Videospur ist wie im Export aus
        cx.pair_of(
            &mut pairs,
            cs,
            t,
            t.mute != Some(true) && t.hide != Some(true),
            Some(&loud),
        );
    }
    for t in &a_src {
        let cs: Vec<&TlClip> = sorted(&t.clips)
            .into_iter()
            .filter(|c| c.mute != Some(true))
            .collect();
        cx.pair_of(&mut pairs, cs, t, t.mute != Some(true), None);
    }
    let items = cx.items;

    let link = |x: &Item| {
        format!(
            "<link><linkclipref>{}</linkclipref><mediatype>{}</mediatype><trackindex>{}</trackindex><clipindex>{}</clipindex>{}</link>",
            x.id,
            if x.track > 0 { "audio" } else { "video" },
            x.t_idx,
            x.c_idx,
            if x.track > 0 {
                "<groupindex>1</groupindex>"
            } else {
                ""
            }
        )
    };
    let mut file_ids: HashMap<String, usize> = HashMap::new();
    let mut defined: HashSet<usize> = HashSet::new();
    let mut file_el = |x: &Item| {
        let src = &x.c.src;
        let n = file_ids.len() + 1;
        let id = *file_ids.entry(src.clone()).or_insert(n);
        if !defined.insert(id) {
            return format!("<file id=\"file-{id}\"/>");
        }
        let (info, r) = (x.info, x.r);
        let v = if info.w > 0.0 {
            format!(
                "<video><samplecharacteristics>{}<width>{}</width><height>{}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>",
                rate(r),
                num(info.w),
                num(info.h)
            )
        } else {
            String::new()
        };
        format!(
            "<file id=\"file-{id}\"><name>{}</name><pathurl>{}</pathurl>{}<duration>{}</duration><timecode>{}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media>{v}<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>",
            esc(basename(src)),
            esc(&file_url(src)),
            rate(r),
            num(round(info.duration * r.real)),
            rate(r)
        )
    };
    let clip = |items: &[Item], k: usize, file: String| {
        let x = &items[k];
        let extra = if x.track > 0 {
            audio_levels(x)
        } else {
            motion(x, opts) + &color(x.c)
        };
        format!(
            "<clipitem id=\"{}\"{}><name>{}</name><enabled>TRUE</enabled><duration>{}</duration>{}<start>{}</start><end>{}</end><in>{}</in><out>{}</out>{file}{}{extra}{}{}</clipitem>",
            x.id,
            if x.track > 0 {
                " premiereChannelType=\"stereo\""
            } else {
                ""
            },
            esc(basename(&x.c.src)),
            num(round((x.info.duration * x.r.real) / x.sp)),
            rate(x.r),
            num(x.start),
            num(x.end),
            num(x.in_),
            num(x.out),
            if x.sp != 1.0 {
                remap(x.sp, x.track == 0)
            } else {
                String::new()
            },
            if x.track > 0 {
                format!(
                    "<sourcetrack><mediatype>audio</mediatype><trackindex>{}</trackindex></sourcetrack>",
                    x.track
                )
            } else {
                String::new()
            },
            x.group.iter().map(|&g| link(&items[g])).collect::<String>()
        )
    };
    // Blenden als transitionitem: Überblendung mittig über dem Schnitt, fade als start-black/end-black am Clip-Rand
    let trans = |a: f64, b: f64, align: &str, audio: bool| {
        if a >= b {
            return String::new();
        }
        let eff = if audio {
            "<name>Cross Fade (+3dB)</name><effectid>KGAudioTransition</effectid><effectcategory>Crossfade</effectcategory><effecttype>transition</effecttype><mediatype>audio</mediatype>"
        } else {
            "<name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype><wipecode>0</wipecode><wipeaccuracy>100</wipeaccuracy><startratio>0</startratio><endratio>1</endratio><reverse>FALSE</reverse>"
        };
        format!(
            "<transitionitem><start>{}</start><end>{}</end><alignment>{align}</alignment>{seq}<effect>{eff}</effect></transitionitem>",
            num(a),
            num(b)
        )
    };
    let mut seq_of = |list: &[usize], audio: bool| -> Vec<String> {
        let refs: Vec<&TlClip> = list.iter().map(|&k| items[k].c).collect();
        let xs = xfades_of(&refs);
        let mut out = Vec::new();
        for &k in list {
            let x = &items[k];
            let into = xs.iter().find(|y| std::ptr::eq(y.to, x.c));
            let outgoing = xs.iter().any(|y| std::ptr::eq(y.from, x.c));
            let [a, b] = x.c.fade.unwrap_or([0.0, 0.0]);
            // fade-Längen proportional auf die Clip-Länge kürzen: ein- und ausblenden berühren sich höchstens
            let s = a + b;
            let kk =
                1f64.min((clip_end(x.c) - x.c.at) / if s != 0.0 && !s.is_nan() { s } else { 1.0 });
            let (fi, fo) = (a * kk, b * kk);
            let mid = fr(x.c.at + fi);
            let (xs_, xe) = (x.start, x.end);
            let head = match into {
                Some(y) => trans(fr(y.a), fr(y.b), "center", audio),
                None if fi > 0.0 => trans(xs_, xe.min(mid), "start-black", audio),
                None => String::new(),
            };
            let tail = if !outgoing && fo > 0.0 {
                trans(
                    xs_.max(mid).max(fr(clip_end(x.c) - fo)),
                    xe,
                    "end-black",
                    audio,
                )
            } else {
                String::new()
            };
            let file = file_el(x);
            let body = clip(&items, k, file);
            out.extend([head, body, tail].into_iter().filter(|s| !s.is_empty()));
        }
        out
    };
    let on = |b: bool| if b { "TRUE" } else { "FALSE" };
    let group = |k: u8| {
        format!(
            "<group><index>{k}</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>{k}</index></channel></group>"
        )
    };
    let mut lines: Vec<String> = vec![
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".into(),
        "<!DOCTYPE xmeml>".into(),
        "<xmeml version=\"5\">".into(),
        "<sequence id=\"sequence-1\">".into(),
        format!("<name>{}</name>", esc(opts.name)),
        format!("<duration>{}</duration>", num(fr(tl_duration(&tl.tracks)))),
        seq.clone(),
        "<media>".into(),
        "<video>".into(),
        format!(
            "<format><samplecharacteristics>{seq}<width>{}</width><height>{}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>",
            num(opts.w),
            num(opts.h)
        ),
    ];
    for (t, its) in &video {
        lines.push("<track>".into());
        lines.extend(seq_of(its, false));
        lines.push(format!(
            "<enabled>{}</enabled><locked>FALSE</locked></track>",
            on(t.hide != Some(true))
        ));
    }
    if let Some(s) = subs_track(tl, &fr, &seq) {
        lines.push(s);
    }
    lines.extend(["</video>".into(), "<audio>".into(), "<numOutputChannels>2</numOutputChannels>".into(), "<format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>".into(), format!("<outputs>{}{}</outputs>", group(1), group(2))]);
    for p in &pairs {
        for k in [1u8, 2] {
            lines.push(format!("<track currentExplodedTrackIndex=\"{}\" totalExplodedTrackCount=\"2\" premiereTrackType=\"Stereo\">", k - 1));
            lines.extend(seq_of(if k == 1 { &p.l } else { &p.r }, true));
            lines.push(format!("<enabled>{}</enabled><locked>FALSE</locked><outputchannelindex>{k}</outputchannelindex></track>", on(p.enabled)));
        }
    }
    lines.extend(["</audio>".into(), "</media>".into(), format!("<timecode>{seq}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>")]);
    let mut ms: Vec<&Marker> = tl.markers.iter().flatten().collect();
    ms.sort_by(|a, b| by(a.t - b.t));
    for m in ms {
        lines.push(format!(
            "<marker><comment></comment><name>{}</name><in>{}</in><out>-1</out></marker>",
            esc(&m.name),
            num(fr(m.t))
        ));
    }
    lines.extend(["</sequence>".into(), "</xmeml>".into(), String::new()]);
    lines.join("\n")
}

// K18: Pegel (volume × Spur-volume) und Keys [Quellsekunde, dB] als Keyframes in Sequenzbildern ab Clip-Anfang
fn audio_levels(x: &Item) -> String {
    let keys = x.c.keys.as_deref().unwrap_or(&[]);
    if (x.gain - 1.0).abs() < 1e-9 && keys.is_empty() {
        return String::new();
    }
    let lin = |db: f64| x.gain * 10f64.powf(DB.max.min(DB.min.max(db)) / 20.0);
    let mut ks = keys.to_vec();
    ks.sort_by(|a, b| by(a[0] - b[0]));
    let kf: String = ks
        .iter()
        .map(|&[s, db]| {
            let when = round((tl_at(x.c, s) - x.c.at) * x.r.real).max(0.0);
            format!(
                "<keyframe><when>{}</when><value>{}</value></keyframe>",
                num(when),
                num(fixed(lin(db), 5))
            )
        })
        .collect();
    format!(
        "<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter authoringApp=\"PremierePro\"><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>{}</value>{kf}</parameter></effect></filter>",
        num(fixed(x.gain, 5))
    )
}

// K18: Zuschnitt (crop füllt, contain zeigt alles) und Bild-in-Bild als Basic Motion; Quelle ohne Größe oder Standbild ohne Angabe bleibt unberührt
fn motion(x: &Item, o: &XmemlOpts) -> String {
    let c = x.c;
    let (iw, ih) = (x.info.w, x.info.h);
    if iw <= 0.0
        || ih <= 0.0
        || (c.box_.is_none() && c.fit.is_none() && c.focus.is_none() && iw == o.w && ih == o.h)
    {
        return String::new();
    }
    let (bw, bh, bx, by) = match c.box_ {
        Some([bx, by, w]) => (w * o.w, w * o.h, bx * o.w, by * o.h),
        None => (o.w, o.h, 0.0, 0.0),
    };
    let s = if c.fit == Some(Fit::Contain) {
        (bw / iw).min(bh / ih)
    } else {
        (bw / iw).max(bh / ih)
    };
    // crop um focus: horizontaler Versatz des Bildes, geklemmt, damit kein Rand entsteht
    let over = 0f64.max(iw * s - bw);
    let dx = if c.fit == Some(Fit::Contain) {
        0.0
    } else {
        clamp(
            (0.5 - c.focus.unwrap_or(0.5)) * iw * s,
            -over / 2.0,
            over / 2.0,
        )
    };
    let cx = (bx + bw / 2.0 + dx - o.w / 2.0) / o.w;
    let cy = (by + bh / 2.0 - o.h / 2.0) / o.h;
    let center = format!(
        "<parameter authoringApp=\"PremierePro\"><parameterid>center</parameterid><name>Center</name><value><horiz>{}</horiz><vert>{}</vert></value></parameter>",
        num(fixed(cx, 5)),
        num(fixed(cy, 5))
    );
    format!(
        "<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>{}{center}</effect></filter>",
        param("scale", &num(fixed(s * 100.0, 3)), Some(("0", "1000")))
    )
}

// K18: Farbe. Sättigung als Color Corrector 3-way, alle Werte exakt als Kommentar (für Rückweg und Nachbau im Grading)
fn color(c: &TlClip) -> String {
    let Some(g) = c
        .grade
        .as_ref()
        .filter(|g| !crate::grade::is_neutral(Some(g)))
    else {
        return String::new();
    };
    let sat = clamp(g.sat.unwrap_or(1.0), SAT.min, SAT.max);
    let json = serde_json::to_string(g).unwrap_or_default();
    format!(
        "<filter><effect><name>Color Corrector 3-way</name><effectid>Color Corrector 3-way</effectid><effectcategory>Color Correction</effectcategory><effecttype>filter</effecttype><mediatype>video</mediatype>{}</effect></filter><comments><mastercomment1>deckwerk-grade {}</mastercomment1></comments>",
        param(
            "saturation",
            &num(fixed(sat * 100.0, 2)),
            Some(("0", "200"))
        ),
        esc(&json)
    )
}

// K18: Untertitel als oberste Videospur mit Text-Generatoren; eine Zeile, damit sie als Block erkennbar bleibt
fn subs_track(tl: &TimelineContent, fr: &dyn Fn(f64) -> f64, seq: &str) -> Option<String> {
    let subs = tl.subs.as_ref().filter(|s| !s.is_empty())?;
    let mut s = String::from("<track>");
    for (k, x) in subs.iter().enumerate() {
        let (a, b) = (fr(x.start), fr(x.end));
        if b <= a {
            continue;
        }
        let d = num(b - a);
        s.push_str(&format!(
            "<generatoritem id=\"generator-{}\"><name>Untertitel {}</name><enabled>TRUE</enabled><duration>{d}</duration>{seq}<start>{}</start><end>{}</end><in>0</in><out>{d}</out><effect><name>Text</name><effectid>Text</effectid><effectcategory>Text</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype>{}</effect></generatoritem>",
            k + 1,
            k + 1,
            num(a),
            num(b),
            format_args!("<parameter authoringApp=\"PremierePro\"><parameterid>str</parameterid><name>Text</name><value>{}</value></parameter>", esc(&x.text))
        ));
    }
    let on = tl.captions.as_deref() != Some("aus");
    s.push_str(&format!(
        "<enabled>{}</enabled><locked>FALSE</locked></track>",
        if on { "TRUE" } else { "FALSE" }
    ));
    Some(s)
}
