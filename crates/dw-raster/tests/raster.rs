use std::sync::Arc;

use dw_model::*;
use dw_raster::{RasterOpts, render_png, render_rgba};
use kurbo::{Affine, BezPath, Point, Rect, Shape};
use skrifa::MetadataProvider;

const FONT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../assets/fonts/IBMPlexSans-Regular.ttf"
);

fn c(hex: &str) -> Color {
    Color::from_hex(hex).unwrap()
}

fn rect(meta: NodeMeta, r: Rect, fill: Color) -> Node {
    Node::Rect {
        meta,
        rect: r,
        radius: 0.0,
        fill: Some(Paint::Solid(fill)),
        stroke: None,
        shadow: None,
    }
}

/// Einfache Positionierung über die Vorschubbreiten, ohne Shaping.
fn text(s: &str, x: f32, y: f32, size: f32) -> Node {
    let data = Arc::new(std::fs::read(FONT).unwrap());
    let f = skrifa::FontRef::new(&data).unwrap();
    let (cmap, adv) = (
        f.charmap(),
        f.glyph_metrics(
            skrifa::instance::Size::new(size),
            skrifa::instance::LocationRef::default(),
        ),
    );
    let mut cx = x;
    let glyphs = s
        .chars()
        .map(|ch| {
            let id = cmap.map(ch).unwrap();
            let g = Glyph {
                id: id.to_u32(),
                x: cx,
                y,
            };
            cx += adv.advance_width(id).unwrap();
            g
        })
        .collect();
    Node::Glyphs {
        meta: NodeMeta::default(),
        run: GlyphRun {
            font: FontData {
                data,
                index: 0,
                family: "IBM Plex Sans".into(),
                weight: 400,
                italic: false,
            },
            size,
            color: Color::BLACK,
            glyphs,
            text: s.into(),
        },
    }
}

fn px(img: &image::RgbaImage, x: u32, y: u32) -> [u8; 4] {
    img.get_pixel(x, y).0
}

#[test]
fn groesse_hintergrund_rechteck() {
    let scene = Scene {
        width: 1280.0,
        height: 720.0,
        background: c("#f4efe6"),
        nodes: vec![rect(
            NodeMeta::default(),
            Rect::new(100.0, 100.0, 300.0, 200.0),
            c("#b0431a"),
        )],
    };
    let png = render_png(&scene, 2.0, &RasterOpts::default()).unwrap();
    let img = image::load_from_memory(&png).unwrap().to_rgba8();
    assert_eq!(img.dimensions(), (2560, 1440));
    assert_eq!(px(&img, 10, 10), [0xf4, 0xef, 0xe6, 255]);
    assert_eq!(px(&img, 400, 300), [0xb0, 0x43, 0x1a, 255]);
    assert_eq!(px(&img, 610, 300), [0xf4, 0xef, 0xe6, 255]);
}

#[test]
fn ohne_exportierte_knoten() {
    let meta = NodeMeta {
        slot: Some("title".into()),
        export: true,
    };
    let scene = Scene {
        width: 200.0,
        height: 100.0,
        background: Color::WHITE,
        nodes: vec![rect(meta, Rect::new(0.0, 0.0, 100.0, 100.0), Color::BLACK)],
    };
    let mit = render_rgba(&scene, 1.0, &RasterOpts::default()).unwrap();
    let ohne = render_rgba(
        &scene,
        1.0,
        &RasterOpts {
            skip_exported: true,
        },
    )
    .unwrap();
    assert_eq!(px(&mit, 50, 50), [0, 0, 0, 255]);
    assert_eq!(px(&ohne, 50, 50), [255, 255, 255, 255]);
}

#[test]
fn alle_knotenarten() {
    let mut png = Vec::new();
    image::RgbaImage::from_fn(4, 2, |x, _| {
        if x < 2 {
            image::Rgba([255, 0, 0, 255])
        } else {
            image::Rgba([0, 0, 255, 255])
        }
    })
    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
    .unwrap();
    let stops = vec![
        Stop {
            offset: 0.0,
            color: c("#ff0000"),
        },
        Stop {
            offset: 1.0,
            color: c("#0000ff"),
        },
    ];
    let mut tri = BezPath::new();
    tri.move_to((600.0, 50.0));
    tri.line_to((700.0, 150.0));
    tri.line_to((500.0, 150.0));
    tri.close_path();
    let scene = Scene {
        width: 1280.0,
        height: 720.0,
        background: Color::WHITE,
        nodes: vec![
            Node::Rect {
                meta: NodeMeta::default(),
                rect: Rect::new(50.0, 50.0, 250.0, 150.0),
                radius: 16.0,
                fill: Some(Paint::Linear {
                    start: Point::new(50.0, 0.0),
                    end: Point::new(250.0, 0.0),
                    stops: stops.clone(),
                }),
                stroke: Some(Stroke {
                    width: 2.0,
                    color: Color::BLACK,
                    dash: Some(vec![6.0, 4.0]),
                }),
                shadow: Some(Shadow {
                    color: c("#00000080"),
                    blur: 12.0,
                    offset_y: 6.0,
                }),
            },
            Node::Path {
                meta: NodeMeta::default(),
                path: tri,
                fill: Some(Paint::Radial {
                    center: Point::new(600.0, 110.0),
                    radius: 80.0,
                    stops,
                }),
                stroke: None,
            },
            // 4×2-Bild, cover in 200×200, Fokus links: links rot
            Node::Image {
                meta: NodeMeta::default(),
                rect: Rect::new(800.0, 50.0, 1000.0, 250.0),
                src: ImageSrc::Bytes(Arc::new(png)),
                fit: ImgFit::Cover,
                focus: (0.0, 0.5),
                radius: 20.0,
            },
            Node::Group {
                meta: NodeMeta::default(),
                transform: Affine::translate((0.0, 300.0)),
                opacity: 0.5,
                clip: Some(Rect::new(0.0, 0.0, 400.0, 200.0).to_path(0.1)),
                blend: Blend::Multiply,
                children: vec![rect(
                    NodeMeta::default(),
                    Rect::new(-100.0, 0.0, 600.0, 100.0),
                    Color::BLACK,
                )],
            },
            text("Hallo Deckwerk", 100.0, 650.0, 48.0),
        ],
    };
    let img = render_rgba(&scene, 1.0, &RasterOpts::default()).unwrap();
    let p = px(&img, 60, 100);
    assert!(p[0] > 200 && p[2] < 60, "Verlauf links rot: {p:?}");
    let p = px(&img, 240, 100);
    assert!(p[2] > 200 && p[0] < 60, "Verlauf rechts blau: {p:?}");
    assert!(px(&img, 150, 160)[0] < 250, "Schatten unter dem Rechteck");
    let p = px(&img, 820, 150);
    assert!(p[0] > 200 && p[2] < 50, "Bild cover, Fokus links: {p:?}");
    assert_eq!(
        px(&img, 801, 51),
        [255, 255, 255, 255],
        "Radius schneidet die Ecke ab"
    );
    let p = px(&img, 200, 350);
    assert!(
        (120..=135).contains(&p[0]),
        "Gruppe mit 50 % Deckkraft: {p:?}"
    );
    assert_eq!(px(&img, 500, 350), [255, 255, 255, 255], "Clip der Gruppe");
    let dunkel = (100..500)
        .flat_map(|x| (600..660).map(move |y| (x, y)))
        .filter(|&(x, y)| px(&img, x, y)[0] < 100)
        .count();
    assert!(dunkel > 500, "Text gezeichnet: {dunkel} dunkle Pixel");
}

#[test]
fn contain_mit_fokus() {
    // 4×2-Bild in 200×200, contain → 200×100; Fokus oben rechts setzt es an die Oberkante.
    let r = Rect::new(0.0, 0.0, 200.0, 200.0);
    assert_eq!(
        dw_raster::fit_rect(r, 4.0, 2.0, ImgFit::Contain, (1.0, 0.0)),
        Rect::new(0.0, 0.0, 200.0, 100.0)
    );
    assert_eq!(
        dw_raster::fit_rect(r, 2.0, 4.0, ImgFit::Contain, (1.0, 0.25)),
        Rect::new(100.0, 0.0, 200.0, 200.0)
    );
    assert_eq!(
        dw_raster::fit_rect(r, 2.0, 4.0, ImgFit::Contain, (0.25, 0.0)),
        Rect::new(25.0, 0.0, 125.0, 200.0)
    );
    let mut png = Vec::new();
    image::RgbaImage::from_pixel(4, 2, image::Rgba([255, 0, 0, 255]))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let scene = Scene {
        width: 200.0,
        height: 200.0,
        background: Color::WHITE,
        nodes: vec![Node::Image {
            meta: NodeMeta::default(),
            rect: r,
            src: ImageSrc::Bytes(Arc::new(png)),
            fit: ImgFit::Contain,
            focus: (1.0, 0.0),
            radius: 0.0,
        }],
    };
    let img = render_rgba(&scene, 1.0, &RasterOpts::default()).unwrap();
    assert_eq!(px(&img, 100, 50), [255, 0, 0, 255]);
    assert_eq!(px(&img, 100, 150), [255, 255, 255, 255]);
}
