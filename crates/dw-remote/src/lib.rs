//! Handy als Fernbedienung (Port von remote.ts): kleiner HTTP-Server im LAN, nur mit Zufallstoken und nur,
//! solange die Referentenansicht ihn braucht. Die Seite zeigt Folie, Notizen und Weiter/Zurück.
// ponytail: Klartext-HTTP wie remote.ts (Notizen unverschlüsselt im WLAN), E2E-Verschlüsselung laut §7.1 S7 später
use std::sync::{Arc, Mutex};

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Method, Request, Response, StatusCode};
use serde::Serialize;

#[derive(Clone, Default, Serialize)]
pub struct RemoteState {
    pub i: usize,
    pub n: usize,
    pub title: String,
    pub notes: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cmd {
    Next,
    Prev,
}

const PAGE: &str = include_str!("page.html");

/// Läuft, bis es fallen gelassen wird (= stopRemote).
pub struct Remote {
    pub url: String,
    pub state: Arc<Mutex<RemoteState>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Remote {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Token-Vergleich zeitkonstant wie timingSafeEqual
fn ok(t: Option<&str>, token: &str) -> bool {
    use subtle::ConstantTimeEq;
    t.is_some_and(|t| t.as_bytes().ct_eq(token.as_bytes()).into())
}

fn reply(code: StatusCode, ty: Option<&str>, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    let mut b = Response::builder()
        .status(code)
        .header("cache-control", "no-store");
    if let Some(ty) = ty {
        b = b.header("content-type", ty);
    }
    b.body(Full::new(body.into())).unwrap()
}

/// `ip`: Adresse für die URL; `None` = eigene LAN-Adresse suchen.
pub async fn start(
    ip: Option<std::net::IpAddr>,
    on_cmd: impl Fn(Cmd) + Send + Sync + 'static,
) -> std::io::Result<Remote> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| std::io::Error::other(e.to_string()))?;
    let token: Arc<str> = b
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect::<String>()
        .into();
    let ip = match ip {
        Some(ip) => ip,
        None => lan_ip().ok_or_else(|| {
            std::io::Error::other(
                "Kein Netzwerk gefunden. Handy und Rechner müssen im selben WLAN sein.",
            )
        })?,
    };
    // 0.0.0.0 wie remote.ts: das Handy kommt aus dem WLAN
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", 0)).await?;
    let url = format!("http://{ip}:{}/?t={token}", listener.local_addr()?.port());
    let state = Arc::new(Mutex::new(RemoteState::default()));
    let on_cmd = Arc::new(on_cmd);
    let st = state.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            };
            let (token, st, on_cmd) = (token.clone(), st.clone(), on_cmd.clone());
            tokio::spawn(async move {
                let handler =
                    hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                        let t = req
                            .uri()
                            .query()
                            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("t=")));
                        let res = if !ok(t, &token) {
                            reply(StatusCode::FORBIDDEN, None, "")
                        } else {
                            match (req.method(), req.uri().path()) {
                                (&Method::POST, p @ ("/next" | "/prev")) => {
                                    on_cmd(if p == "/next" { Cmd::Next } else { Cmd::Prev });
                                    reply(StatusCode::NO_CONTENT, None, "")
                                }
                                (_, "/state") => {
                                    let j = serde_json::to_string(&*st.lock().unwrap()).unwrap();
                                    reply(StatusCode::OK, Some("application/json"), j)
                                }
                                _ => reply(StatusCode::OK, Some("text/html; charset=utf-8"), PAGE),
                            }
                        };
                        async move { Ok::<_, std::convert::Infallible>(res) }
                    });
                let _ = hyper::server::conn::http1::Builder::new()
                    .timer(hyper_util::rt::TokioTimer::new())
                    .header_read_timeout(std::time::Duration::from_secs(10))
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), handler)
                    .await;
            });
        }
    });
    Ok(Remote { url, state, task })
}

// ponytail: Adresse der Standardroute (UDP-connect sendet nichts); kann VPN sein, sonst Schnittstellenliste wie remote.ts
fn lan_ip() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}
