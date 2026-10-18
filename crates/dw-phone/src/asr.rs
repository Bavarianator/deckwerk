//! Spracherkennung auf dem Handy (`phone.ts`): Die Sprachstücke eines Chunks schneidet Silero-VAD weiter auf dem PC,
//! erkannt werden sie alle in EINEM Lauf von sherpa-onnx-offline (Modell einmal laden).

use crate::{LONG, PHONE_DIR, Phone, fetch, parse_sizes, quote, tail};
use dw_video::ffmpeg::{self, Cancel, Error, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

const ASR: [&str; 4] = [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
];

/// Ergebnis je Sprachstück; nan/inf aus sherpa als None
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneResult {
    pub text: String,
    #[serde(default)]
    pub tokens: Vec<String>,
    #[serde(default)]
    pub timestamps: Vec<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub durations: Option<Vec<Option<f64>>>,
}

/// 16-bit-WAV, mono (das Programm liest nur WAV)
pub fn wav(s: &[f32], sr: u32) -> Vec<u8> {
    let n = s.len() as u32 * 2;
    let mut d = Vec::with_capacity(44 + n as usize);
    d.extend_from_slice(b"RIFF");
    d.extend_from_slice(&(36 + n).to_le_bytes());
    d.extend_from_slice(b"WAVEfmt ");
    d.extend_from_slice(&16u32.to_le_bytes());
    d.extend_from_slice(&1u16.to_le_bytes());
    d.extend_from_slice(&1u16.to_le_bytes());
    d.extend_from_slice(&sr.to_le_bytes());
    d.extend_from_slice(&(sr * 2).to_le_bytes());
    d.extend_from_slice(&2u16.to_le_bytes());
    d.extend_from_slice(&16u16.to_le_bytes());
    d.extend_from_slice(b"data");
    d.extend_from_slice(&n.to_le_bytes());
    for &x in s {
        d.extend_from_slice(&((x * 32767.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes());
    }
    d
}

/// Ergebnisse aus der Standardausgabe: eine JSON-Zeile je Datei in Aufrufreihenfolge; nan/inf in den Zahlenlisten → null
pub fn parse_results(stdout: &str) -> Result<Vec<PhoneResult>> {
    let re = regex::Regex::new(r"(?i)([\[,]\s*)-?(?:nan|inf)(\s*[,\]])").unwrap();
    stdout
        .lines()
        .filter(|l| l.starts_with('{'))
        .map(|l| {
            // zwei Durchläufe: bei „,nan,nan,“ verbraucht ein Treffer das Komma des nächsten
            let a = re.replace_all(l, "${1}null${2}");
            let b = re.replace_all(&a, "${1}null${2}");
            serde_json::from_str(&b)
                .map_err(|e| Error::Media(format!("Ergebnis vom Handy unlesbar: {e}")))
        })
        .collect()
}

/// Aufruf von sherpa-onnx-offline in PHONE_DIR; Modell im Unterordner `model`
pub fn asr_cmd(model: &str, files: &[String]) -> String {
    let q = |f: &str| quote(&format!("{model}/{f}"));
    format!(
        "cd {PHONE_DIR} && LD_LIBRARY_PATH=. ./sherpa-onnx-offline --tokens={} --encoder={} --decoder={} --joiner={} --model-type=nemo_transducer --num-threads=4 {}",
        q("tokens.txt"),
        q("encoder.int8.onnx"),
        q("decoder.int8.onnx"),
        q("joiner.int8.onnx"),
        files.iter().map(|f| quote(f)).collect::<Vec<_>>().join(" ")
    )
}

impl Phone {
    /// Programm, Bibliotheken und das Erkennungsmodell (Ordner `<models>/<model>`) aufs Handy, was dort fehlt oder eine andere
    /// Größe hat (abgebrochene Übertragung). Beim ersten Mal ~700 MB (Parakeet Ultra): per USB etwa 30 s.
    pub fn ensure_asr(&self, models: &Path, model: &str, cancel: &Cancel) -> Result<()> {
        self.check_abi()?;
        let dir = fetch::bundle(models)?;
        let want: Vec<(std::path::PathBuf, String)> = fetch::BUNDLE
            .iter()
            .map(|f| (dir.join(f), f.to_string()))
            .chain(
                ASR.iter()
                    .map(|f| (models.join(model).join(f), format!("{model}/{f}"))),
            )
            .collect();
        // rm: altes Parakeet v3 lag bis v0.2.4 direkt in PHONE_DIR
        let have = parse_sizes(&self.shell(&format!(
            "mkdir -p {PHONE_DIR}/{m} && cd {PHONE_DIR} && rm -f {} && stat -c '%n %s' * {m}/* 2>/dev/null; true",
            ASR.join(" "),
            m = quote(model)
        ))?);
        for (f, name) in &want {
            if have.get(name) != Some(&std::fs::metadata(f)?.len()) {
                self.upload(f, &format!("{PHONE_DIR}/{name}"), &mut |_| {}, cancel)?;
            }
        }
        self.shell(&format!("chmod 755 {PHONE_DIR}/sherpa-onnx-offline"))
            .map(drop)
    }

    /// Sprachstücke (16 kHz mono f32) auf dem Handy erkennen, ein Programmlauf für alle. Vorher [`Phone::ensure_asr`].
    /// stdout trägt die JSON-Zeilen, stderr die Dateinamen und Meldungen: getrennt gelesen, nie gemischt.
    pub fn decode(
        &self,
        models: &Path,
        model: &str,
        parts: &[Vec<f32>],
        cancel: &Cancel,
    ) -> Result<Vec<PhoneResult>> {
        if parts.is_empty() {
            return Ok(vec![]);
        }
        self.check_abi()?;
        let id = crate::uniq();
        let local = models.join(format!(".phone-asr-{id}"));
        let remote = format!("{}/job-{id}", self.work);
        let _ = std::fs::remove_dir_all(&local);
        std::fs::create_dir_all(&local)?;
        let mut done = false;
        let r = (|| {
            let names: Vec<String> = (0..parts.len()).map(|i| format!("{i:04}.wav")).collect();
            for (n, p) in names.iter().zip(parts) {
                std::fs::write(local.join(n), wav(p, 16000))?;
            }
            self.shell(&format!("rm -rf {r} && mkdir -p {r}", r = quote(&remote)))?;
            let mut push = vec!["push".to_string()];
            push.extend(
                names
                    .iter()
                    .map(|n| local.join(n).to_string_lossy().into_owned()),
            );
            push.push(remote.clone());
            self.adb(
                &push.iter().map(String::as_str).collect::<Vec<_>>(),
                LONG,
                cancel,
            )?;
            let files: Vec<String> = names.iter().map(|n| format!("{remote}/{n}")).collect();
            let args: Vec<String> = ["-s", &self.serial, "shell", &asr_cmd(model, &files)]
                .map(String::from)
                .to_vec();
            let o = ffmpeg::exec(Path::new("adb"), &args, None, None, cancel)?;
            done = true;
            if o.code != Some(0) {
                return Err(Error::Media(format!(
                    "Erkennung auf dem Handy fehlgeschlagen (Code {}): {}",
                    o.code.map_or("null".into(), |c| c.to_string()),
                    tail(&o.err, 5)
                )));
            }
            let out = parse_results(&String::from_utf8_lossy(&o.out))?;
            if out.len() != parts.len() {
                return Err(Error::Media(format!(
                    "Handy lieferte {} von {} Ergebnissen",
                    out.len(),
                    parts.len()
                )));
            }
            Ok(out)
        })();
        let _ = std::fs::remove_dir_all(&local);
        // abgebrochen: sherpa läuft auf dem Handy weiter, alles mit dem Job-Ordner im Aufruf beenden ([/]: nicht diese Shell)
        let kill = if done {
            String::new()
        } else {
            format!("pkill -f {}; ", quote(&format!("{remote}[/]")))
        };
        let _ = self.shell(&format!("{kill}rm -rf {}", quote(&remote)));
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sherpa_json_mit_nan() {
        let out = "Started\n{\"lang\": \"\", \"text\": \" Hallo Welt\", \"timestamps\": [0.00, nan, NaN,-inf, 1.20], \"durations\": [nan], \"tokens\":[\"▁Hallo\", \"▁Welt\", \"a\", \"b\", \"c\"], \"ys_log_probs\": [-nan, inf], \"words\": []}\n{\"text\": \"\", \"timestamps\": [], \"tokens\": []}\nDone\n";
        let r = parse_results(out).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].text, " Hallo Welt");
        assert_eq!(
            r[0].timestamps,
            vec![Some(0.0), None, None, None, Some(1.2)]
        );
        assert_eq!(r[0].durations, Some(vec![None]));
        assert_eq!(r[0].tokens[1], "▁Welt");
        assert!(parse_results("{kaputt\n").is_err());
    }

    #[test]
    fn wav_kopf() {
        let w = wav(&[0.0, 1.0, -1.0, 2.0], 16000);
        assert_eq!(w.len(), 44 + 8);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 16000);
        assert_eq!(&w[36..40], b"data");
        let s: Vec<i16> = w[44..]
            .chunks(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(s, vec![0, 32767, -32767, 32767]);
    }

    #[test]
    fn aufruf() {
        let c = asr_cmd(
            "parakeet-ultra",
            &["/w/job-1/0000.wav".into(), "/w/job-1/0001.wav".into()],
        );
        assert!(c.starts_with("cd /data/local/tmp/deckwerk && LD_LIBRARY_PATH=. ./sherpa-onnx-offline --tokens='parakeet-ultra/tokens.txt' "));
        assert!(c.ends_with("--num-threads=4 '/w/job-1/0000.wav' '/w/job-1/0001.wav'"));
        assert!(!c.contains("2>"), "stdout und stderr nie mischen: {c}");
    }
}
