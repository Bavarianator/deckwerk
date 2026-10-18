//! Schriften einbetten: TTF → EOT v2.0 unkomprimiert (embed-fonts.ts), als ppt/fonts/fontN.fntdata.
//! PowerPoint lädt eine eingebettete Schrift nur, wenn die Familie im Textlauf exakt dem typeface-Namen entspricht.

/// Schrift für `p:embeddedFontLst`; `family` = typeface-Name in den Textläufen.
#[derive(Debug, Clone, Default)]
pub struct EmbedFont {
    pub family: String,
    pub regular: Vec<u8>,
    pub bold: Option<Vec<u8>>,
    pub italic: Option<Vec<u8>>,
    pub bold_italic: Option<Vec<u8>>,
    /// pitchFamily 18 (Serif) statt 34
    pub serif: bool,
}

fn u16_at(b: &[u8], o: usize) -> Result<u16, String> {
    b.get(o..o + 2)
        .map(|s| u16::from_be_bytes([s[0], s[1]]))
        .ok_or_else(|| "TTF abgeschnitten".into())
}

fn u32_at(b: &[u8], o: usize) -> Result<u32, String> {
    b.get(o..o + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| "TTF abgeschnitten".into())
}

fn table<'a>(ttf: &'a [u8], tag: &[u8; 4]) -> Result<Option<&'a [u8]>, String> {
    let n = u16_at(ttf, 4)? as usize;
    for i in 0..n {
        let o = 12 + i * 16;
        let at = u32_at(ttf, o + 8)? as usize;
        let end = at + u32_at(ttf, o + 12)? as usize;
        // halb geladene Datei: nicht einbetten
        let body = ttf.get(at..end).ok_or("TTF abgeschnitten")?;
        if ttf.get(o..o + 4) == Some(tag) {
            return Ok(Some(body));
        }
    }
    Ok(None)
}

// name-Tabelle: Windows/Unicode (3/1, 3/10) bevorzugt, sonst Mac Roman (1/0)
fn name_of(name: &[u8], id: u16) -> Result<String, String> {
    let (count, base) = (u16_at(name, 2)? as usize, u16_at(name, 4)? as usize);
    let mut mac = String::new();
    for i in 0..count {
        let r = 6 + i * 12;
        let (plat, enc, nid) = (u16_at(name, r)?, u16_at(name, r + 2)?, u16_at(name, r + 6)?);
        if nid != id {
            continue;
        }
        let len = u16_at(name, r + 8)? as usize;
        let off = base + u16_at(name, r + 10)? as usize;
        let s = name.get(off..off + len).ok_or("name-Tabelle abgeschnitten")?;
        if plat == 3 && (enc == 1 || enc == 10) {
            let u: Vec<u16> = s.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            return Ok(String::from_utf16_lossy(&u));
        }
        if plat == 1 {
            // latin1: jedes Byte ist ein Codepunkt
            mac = s.iter().map(|&b| b as char).collect();
        }
    }
    Ok(mac)
}

/// Familienname (name-ID 1) einer TTF.
pub fn family_of(ttf: &[u8]) -> Result<String, String> {
    name_of(table(ttf, b"name")?.ok_or("TTF ohne name-Tabelle")?, 1)
}

/// OS/2 fsType; Bit 1 (0x0002) = „restricted“, Einbetten nicht erlaubt.
pub fn fs_type(ttf: &[u8]) -> Result<u16, String> {
    match table(ttf, b"OS/2")? {
        Some(os2) => u16_at(os2, 8),
        None => Ok(0),
    }
}

/// EOT v2.0 (0x00020001) ohne Kompression/XOR wie ttf2eot; alle Felder little-endian.
/// fsType ohne Bit 1 (wie embed-fonts.ts): Mischfälle wie 0x0006 zeigt PowerPoint sonst nicht an.
/// Reines „restricted“ sortiert der Aufrufer vorher aus und bettet gar nicht ein.
pub fn ttf_to_eot(ttf: &[u8]) -> Result<Vec<u8>, String> {
    let os2 = table(ttf, b"OS/2")?;
    let head = table(ttf, b"head")?;
    let name = table(ttf, b"name")?;
    let (Some(os2), Some(head), Some(name)) = (os2, head, name) else {
        return Err("TTF ohne OS/2-, head- oder name-Tabelle".into());
    };
    let strs: Vec<Vec<u8>> = [1, 2, 5, 4]
        .into_iter()
        .map(|id| {
            name_of(name, id).map(|s| s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect())
        })
        .collect::<Result<_, _>>()?;
    // je: size(2) + Bytes + Padding(2); RootString: size(2)
    let str_size: usize = strs.iter().map(|s| 4 + s.len()).sum::<usize>() + 2;
    let total = 82 + str_size;
    let mut h: Vec<u8> = Vec::with_capacity(total + ttf.len());
    let u32le = |h: &mut Vec<u8>, v: u32| h.extend_from_slice(&v.to_le_bytes());
    let u16le = |h: &mut Vec<u8>, v: u16| h.extend_from_slice(&v.to_le_bytes());
    u32le(&mut h, (total + ttf.len()) as u32); // EOTSize
    u32le(&mut h, ttf.len() as u32); // FontDataSize
    u32le(&mut h, 0x0002_0001); // Version
    u32le(&mut h, 0); // Flags
    h.extend_from_slice(os2.get(32..42).ok_or("OS/2 zu kurz")?); // PANOSE
    h.push(1); // Charset DEFAULT_CHARSET
    h.push((u16_at(os2, 62)? & 1) as u8); // Italic (fsSelection Bit 0)
    u32le(&mut h, u16_at(os2, 4)? as u32); // Weight
    u16le(&mut h, u16_at(os2, 8)? & !0x0002); // fsType
    u16le(&mut h, 0x504c); // MagicNumber
    for i in 0..4 {
        u32le(&mut h, u32_at(os2, 42 + i * 4)?); // UnicodeRange1-4
    }
    let cp = |o| if os2.len() >= 86 { u32_at(os2, o) } else { Ok(0) };
    u32le(&mut h, cp(78)?); // CodePageRange1
    u32le(&mut h, cp(82)?); // CodePageRange2
    u32le(&mut h, u32_at(head, 8)?); // CheckSumAdjustment
    for _ in 0..4 {
        u32le(&mut h, 0); // Reserved1-4
    }
    u16le(&mut h, 0); // Padding1
    for s in &strs {
        u16le(&mut h, s.len() as u16);
        h.extend_from_slice(s);
        u16le(&mut h, 0);
    }
    u16le(&mut h, 0); // RootStringSize
    if h.len() != total {
        return Err(format!("EOT-Header: {} statt {total} Bytes", h.len()));
    }
    h.extend_from_slice(ttf);
    Ok(h)
}
