//! Statische Themes (themes.ts CORE_THEMES/BASE_THEMES, themes-extra.ts). Aus dem TS-Stand übertragen.

use crate::*;

fn fr(css: &str, pptx: &str, embed: Option<&str>, serif: bool, single: bool) -> FontRef {
    FontRef {
        css: css.into(),
        pptx: pptx.into(),
        embed: embed.map(Into::into),
        serif,
        single,
        files: None,
        fallback: None,
    }
}

fn colors(c: [&str; 11], chart: [&str; 5]) -> Colors {
    let h = |s: &str| Rgb::parse(s).expect("Theme-Farbe");
    Colors {
        bg: h(c[0]),
        surface: h(c[1]),
        surface2: h(c[2]),
        text: h(c[3]),
        muted: h(c[4]),
        accent: h(c[5]),
        accent2: h(c[6]),
        on_accent: h(c[7]),
        border: h(c[8]),
        good: h(c[9]),
        bad: h(c[10]),
        chart: chart.map(h).to_vec(),
        fill: None,
    }
}

pub(crate) fn blank() -> Theme {
    Theme {
        id: String::new(),
        name: String::new(),
        dark: false,
        c: colors(["#000"; 11], ["#000"; 5]),
        head: HeadFont {
            font: fr("", "", None, false, false),
            weight: 700,
            tracking: 0.0,
        },
        body: fr("", "", None, false, false),
        radius: 0.0,
        decor: Decor::None,
        texture: None,
        tone: None,
        legacy: false,
        head_scale: None,
        rule: None,
        section_tone: None,
        vivid: false,
        mutig: false,
        mono: None,
        sub_body: false,
        elements: None,
        logo: None,
        logos: None,
        field: None,
        chart: None,
        leading: None,
        labels: None,
        margin: None,
        measure: None,
        signature: None,
        hero_tone: None,
        images: None,
    }
}

pub(crate) fn core() -> Vec<Theme> {
    vec![
        Theme {
            id: "beratung".into(),
            name: "Beratung".into(),
            dark: false,
            c: colors(
                [
                    "#FFFFFF", "#F4F5F6", "#E9EBED", "#16202B", "#5A6470", "#0B5563", "#8A939C",
                    "#FFFFFF", "#DDE1E5", "#1E7A45", "#B83227",
                ],
                ["#0B5563", "#A3ABB3", "#C9CED3", "#5B7F8C", "#3E4C59"],
            ),
            head: HeadFont {
                font: fr(
                    "IBM Plex Sans",
                    "IBM Plex Sans",
                    Some("IBMPlexSans"),
                    false,
                    false,
                ),
                weight: 700,
                tracking: -0.015,
            },
            body: fr(
                "IBM Plex Sans",
                "IBM Plex Sans",
                Some("IBMPlexSans"),
                false,
                false,
            ),
            radius: 2.0,
            decor: Decor::None,
            rule: Some(Rule::Under),
            elements: Some(Elements::Line),
            ..blank()
        },
        Theme {
            id: "keynote".into(),
            name: "Keynote".into(),
            dark: true,
            c: colors(
                [
                    "#111113", "#1B1B1E", "#252529", "#F5F5F7", "#8E8E93", "#3D9BFF", "#6E6E73",
                    "#0B0B0C", "#2C2C30", "#5BD08A", "#FF6B5E",
                ],
                ["#3D9BFF", "#6E6E73", "#A1A1A6", "#48484D", "#D1D1D6"],
            ),
            head: HeadFont {
                font: fr("Inter", "Inter", Some("Inter"), false, false),
                weight: 700,
                tracking: -0.03,
            },
            body: fr("Inter", "Inter", Some("Inter"), false, false),
            radius: 4.0,
            decor: Decor::None,
            head_scale: Some(1.22),
            section_tone: Some(Tone::Normal),
            elements: Some(Elements::Plain),
            ..blank()
        },
        Theme {
            id: "schweiz".into(),
            name: "Schweiz".into(),
            dark: false,
            c: colors(
                [
                    "#FAFAF8", "#F0F0EE", "#E4E4E1", "#111111", "#5C5C5C", "#D7261E", "#8C8C8C",
                    "#FFFFFF", "#DADAD6", "#1E7A3C", "#D7261E",
                ],
                ["#D7261E", "#8C8C8C", "#BDBDBA", "#111111", "#5C5C5C"],
            ),
            head: HeadFont {
                font: fr("Archivo", "Archivo", Some("Archivo"), false, false),
                weight: 700,
                tracking: -0.03,
            },
            body: fr("Archivo", "Archivo", Some("Archivo"), false, false),
            radius: 0.0,
            decor: Decor::None,
            head_scale: Some(1.22),
            rule: Some(Rule::Over),
            elements: Some(Elements::Line),
            ..blank()
        },
        Theme {
            id: "redaktion".into(),
            name: "Redaktion".into(),
            dark: false,
            c: colors(
                [
                    "#FBFAF7", "#F3F1EC", "#E8E5DE", "#1A1D24", "#5E6168", "#1F3A8A", "#9A9CA3",
                    "#FFFFFF", "#E0DDD5", "#2F6B3F", "#A8321F",
                ],
                ["#1F3A8A", "#A3A6AD", "#C8CAD0", "#5A6B99", "#3A3D45"],
            ),
            head: HeadFont {
                font: fr(
                    "Source Serif 4",
                    "Source Serif 4",
                    Some("SourceSerif4"),
                    true,
                    false,
                ),
                weight: 400,
                tracking: -0.012,
            },
            body: fr(
                "Source Sans 3",
                "Source Sans 3",
                Some("SourceSans3"),
                false,
                false,
            ),
            radius: 2.0,
            decor: Decor::None,
            head_scale: Some(1.22),
            rule: Some(Rule::Over),
            section_tone: Some(Tone::Invert),
            elements: Some(Elements::Line),
            ..blank()
        },
        Theme {
            id: "zen".into(),
            name: "Zen".into(),
            dark: true,
            c: colors(
                [
                    "#1C1D1F", "#242528", "#2D2F32", "#EDEBE6", "#A09D96", "#E3A857", "#7D7B76",
                    "#1C1D1F", "#35373A", "#8CC99A", "#E88A7A",
                ],
                ["#E3A857", "#7D7B76", "#B5B2AB", "#55575B", "#D8D5CE"],
            ),
            head: HeadFont {
                font: fr(
                    "IBM Plex Serif",
                    "IBM Plex Serif",
                    Some("IBMPlexSerif"),
                    true,
                    false,
                ),
                weight: 400,
                tracking: -0.012,
            },
            body: fr(
                "IBM Plex Sans",
                "IBM Plex Sans",
                Some("IBMPlexSans"),
                false,
                false,
            ),
            radius: 0.0,
            decor: Decor::None,
            head_scale: Some(1.22),
            section_tone: Some(Tone::Normal),
            elements: Some(Elements::Plain),
            ..blank()
        },
    ]
}

pub(crate) fn legacy() -> Vec<Theme> {
    vec![
        Theme {
            id: "corporate".into(),
            name: "Corporate Clean".into(),
            dark: false,
            c: colors(
                [
                    "#FFFFFF", "#F3F6FB", "#E6ECF6", "#0E1A2B", "#56667D", "#1F5EFF", "#00A396",
                    "#FFFFFF", "#DCE3EE", "#12864A", "#C9302C",
                ],
                ["#1F5EFF", "#00A396", "#8A9AB5", "#F2A33A", "#8E6CF0"],
            ),
            head: HeadFont {
                font: fr("Arimo", "Arial", None, false, false),
                weight: 700,
                tracking: -0.02,
            },
            body: fr("Carlito", "Calibri", None, false, false),
            radius: 14.0,
            decor: Decor::Blobs,
            ..blank()
        },
        Theme {
            id: "midnight".into(),
            name: "Midnight Pitch".into(),
            dark: true,
            c: colors(
                [
                    "#0A0F1E", "#131A2E", "#1B2440", "#F3F6FF", "#9AA6C4", "#7C6CFF", "#2ED3E6",
                    "#FFFFFF", "#27314F", "#34D399", "#F87171",
                ],
                ["#7C6CFF", "#2ED3E6", "#F5B84B", "#F472B6", "#94A3B8"],
            ),
            head: HeadFont {
                font: fr("Arimo", "Arial", None, false, false),
                weight: 700,
                tracking: -0.025,
            },
            body: fr("Carlito", "Calibri", None, false, false),
            radius: 18.0,
            decor: Decor::Glow,
            ..blank()
        },
        Theme {
            id: "editorial".into(),
            name: "Editorial Warm".into(),
            dark: false,
            c: colors(
                [
                    "#FAF7F2", "#F1EBE1", "#E7DECF", "#1E1915", "#675D54", "#B0431A", "#2F6F63",
                    "#FFFFFF", "#E2D8C8", "#2F7D4F", "#B3261E",
                ],
                ["#B0431A", "#2F6F63", "#C9A227", "#7A6A5C", "#5B7FA6"],
            ),
            head: HeadFont {
                font: fr("Gelasio", "Georgia", None, true, false),
                weight: 700,
                tracking: -0.01,
            },
            body: fr("Carlito", "Calibri", None, false, false),
            radius: 6.0,
            decor: Decor::Rings,
            ..blank()
        },
        Theme {
            id: "graphite".into(),
            name: "Graphite Executive".into(),
            dark: true,
            c: colors(
                [
                    "#131417", "#1B1D21", "#24272C", "#F3F1EC", "#A7A39B", "#F0B24A", "#D9773A",
                    "#1A1408", "#2E3138", "#5CC98B", "#F07A6B",
                ],
                ["#F0B24A", "#6CB2EE", "#2EA37F", "#C46FB0", "#E6E1D6"],
            ),
            head: HeadFont {
                font: fr("Arimo", "Arial", None, false, false),
                weight: 700,
                tracking: -0.02,
            },
            body: fr("Carlito", "Calibri", None, false, false),
            radius: 10.0,
            decor: Decor::Blobs,
            ..blank()
        },
        Theme {
            id: "ocean".into(),
            name: "Ocean Clarity".into(),
            dark: false,
            c: colors(
                [
                    "#FFFFFF", "#EFF5F9", "#E1ECF3", "#0B2239", "#4A6074", "#0F4C81", "#14A3A0",
                    "#FFFFFF", "#D6E3EC", "#0F7743", "#C0392B",
                ],
                ["#0F4C81", "#14A3A0", "#C2504A", "#A3405F", "#5C9E3F"],
            ),
            head: HeadFont {
                font: fr("Arimo", "Arial", None, false, false),
                weight: 700,
                tracking: -0.02,
            },
            body: fr("Carlito", "Calibri", None, false, false),
            radius: 12.0,
            decor: Decor::Blobs,
            ..blank()
        },
        Theme {
            id: "swiss".into(),
            name: "Swiss Mono".into(),
            dark: false,
            c: colors(
                [
                    "#FFFFFF", "#F3F3F3", "#E8E8E8", "#0A0A0A", "#555555", "#B5122B", "#1A1A1A",
                    "#FFFFFF", "#DADADA", "#1E7A3C", "#B5122B",
                ],
                ["#B5122B", "#8C8C8C", "#2B5DA8", "#5B8DD6", "#C97A12"],
            ),
            head: HeadFont {
                font: fr("Arimo", "Arial", None, false, false),
                weight: 700,
                tracking: -0.03,
            },
            body: fr("Arimo", "Arial", None, false, false),
            radius: 2.0,
            decor: Decor::Rings,
            ..blank()
        },
        Theme {
            id: "forest".into(),
            name: "Forest Serif".into(),
            dark: true,
            c: colors(
                [
                    "#0F1D18", "#152720", "#1C3129", "#F2EEE3", "#A9B6AA", "#CFA85E", "#B98545",
                    "#13201A", "#27392F", "#7CCB8F", "#EA8C7B",
                ],
                ["#CFA85E", "#7DBE9E", "#6EA3D8", "#D9826A", "#E6DFCE"],
            ),
            head: HeadFont {
                font: fr("Gelasio", "Georgia", None, false, false),
                weight: 700,
                tracking: -0.01,
            },
            body: fr("Carlito", "Calibri", None, false, false),
            radius: 8.0,
            decor: Decor::Rings,
            ..blank()
        },
        Theme {
            id: "sunrise".into(),
            name: "Sunrise Startup".into(),
            dark: false,
            c: colors(
                [
                    "#FFF8F1", "#FFEFE3", "#FBE3D2", "#2A1633", "#6B5264", "#5E32C4", "#E0503A",
                    "#FFFFFF", "#F3D9C6", "#1A7550", "#C23A2B",
                ],
                ["#5E32C4", "#E0503A", "#1B9E85", "#2F7FD1", "#B07800"],
            ),
            head: HeadFont {
                font: fr("Arimo", "Arial", None, false, false),
                weight: 700,
                tracking: -0.025,
            },
            body: fr("Carlito", "Calibri", None, false, false),
            radius: 20.0,
            decor: Decor::Blobs,
            ..blank()
        },
        Theme {
            id: "atelier".into(),
            name: "Atelier Editorial".into(),
            dark: false,
            c: colors(
                [
                    "#F6F1E8", "#EDE6DA", "#E3DACB", "#1B1A17", "#5E574D", "#9A3B26", "#5C6B3C",
                    "#FFFFFF", "#DDD3C3", "#3F6B2E", "#A8321F",
                ],
                ["#9A3B26", "#5C6B3C", "#C08A3E", "#3E5C76", "#8C7B6B"],
            ),
            head: HeadFont {
                font: fr("Fraunces", "Fraunces", Some("Fraunces"), true, false),
                weight: 700,
                tracking: -0.015,
            },
            body: fr("Manrope", "Manrope", Some("Manrope"), false, false),
            radius: 4.0,
            decor: Decor::Rings,
            texture: Some(Texture::Grain),
            ..blank()
        },
        Theme {
            id: "signal".into(),
            name: "Signal Tech".into(),
            dark: true,
            c: colors(
                [
                    "#0B0D12", "#151922", "#1D2330", "#F5F7FA", "#9AA3B2", "#C6FF3D", "#7C5CFF",
                    "#0B0D12", "#262D3B", "#5BE38A", "#FF6B6B",
                ],
                ["#C6FF3D", "#7C5CFF", "#3DD6F5", "#FF8A4C", "#9AA3B2"],
            ),
            head: HeadFont {
                font: fr(
                    "Space Grotesk",
                    "Space Grotesk",
                    Some("SpaceGrotesk"),
                    false,
                    false,
                ),
                weight: 700,
                tracking: -0.03,
            },
            body: fr("Inter", "Inter", Some("Inter"), false, false),
            radius: 16.0,
            decor: Decor::Glow,
            ..blank()
        },
        Theme {
            id: "noir".into(),
            name: "Noir Luxe".into(),
            dark: true,
            c: colors(
                [
                    "#111111", "#1A1A1A", "#232323", "#F2EFE9", "#A39E94", "#C9A96E", "#8A8A8A",
                    "#111111", "#2C2C2C", "#9CC59A", "#E0877A",
                ],
                ["#C9A96E", "#E8E2D6", "#8A8A8A", "#A7865A", "#5E5E5E"],
            ),
            head: HeadFont {
                font: fr(
                    "DM Serif Display",
                    "DM Serif Display",
                    Some("DMSerifDisplay"),
                    true,
                    false,
                ),
                weight: 400,
                tracking: -0.01,
            },
            body: fr("DM Sans", "DM Sans", Some("DMSans"), false, false),
            radius: 0.0,
            decor: Decor::Stripe,
            ..blank()
        },
    ]
}
