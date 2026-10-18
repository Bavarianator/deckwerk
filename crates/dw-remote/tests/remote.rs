use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn req(addr: &str, line: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(
        format!("{line} HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: 0\r\n\r\n")
            .as_bytes(),
    )
    .await
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    out
}

#[tokio::test]
async fn token_und_befehle() {
    let got = Arc::new(Mutex::new(vec![]));
    let g = got.clone();
    let r = dw_remote::start(Some("127.0.0.1".parse().unwrap()), move |c| {
        g.lock().unwrap().push(c)
    })
    .await
    .unwrap();
    let rest = r.url.strip_prefix("http://").unwrap();
    let (addr, tok) = rest.split_once("/?t=").unwrap();
    assert_eq!(tok.len(), 32);
    assert!(req(addr, "POST /next").await.starts_with("HTTP/1.1 403"));
    assert!(
        req(addr, &format!("POST /next?t={}", "0".repeat(32)))
            .await
            .starts_with("HTTP/1.1 403")
    );
    assert!(
        req(addr, &format!("POST /next?t={}", &tok[..31]))
            .await
            .starts_with("HTTP/1.1 403")
    );
    assert!(got.lock().unwrap().is_empty());
    assert!(
        req(addr, &format!("POST /next?t={tok}"))
            .await
            .starts_with("HTTP/1.1 204")
    );
    assert!(
        req(addr, &format!("POST /prev?t={tok}"))
            .await
            .starts_with("HTTP/1.1 204")
    );
    assert_eq!(
        *got.lock().unwrap(),
        [dw_remote::Cmd::Next, dw_remote::Cmd::Prev]
    );
    r.state.lock().unwrap().title = "Hallo".into();
    assert!(
        req(addr, &format!("GET /state?t={tok}"))
            .await
            .contains(r#""title":"Hallo""#)
    );
    assert!(
        req(addr, &format!("GET /?t={tok}"))
            .await
            .contains("Weiter")
    );
}
