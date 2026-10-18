// cargo test -p dw-net -j 2
use dw_net::{Url, check_url};

#[test]
fn ssrf_tabelle() {
    let faelle = [
        ("https://example.com/a.png", true),
        ("http://93.184.216.34/", true),
        ("http://[2606:4700::1111]/", true),
        ("http://8.8.8.8/", true),
        ("http://100.63.255.255/", true),
        ("http://100.128.0.1/", true),
        ("http://172.32.0.1/", true),
        ("ftp://example.com/", false),
        ("file:///etc/passwd", false),
        ("http://user:pw@example.com/", false),
        ("http://localhost/", false),
        ("http://LOCALHOST./", false),
        ("http://foo.localhost/", false),
        ("http://drucker.local/", false),
        ("http://intranet/", false),
        ("http://127.0.0.1/", false),
        ("http://127.1/", false),
        ("http://2130706433/", false),
        ("http://0x7f000001/", false),
        ("http://0.0.0.0/", false),
        ("http://10.1.2.3/", false),
        ("http://172.16.0.1/", false),
        ("http://172.31.255.255/", false),
        ("http://192.168.178.1/", false),
        ("http://169.254.169.254/latest/meta-data/", false),
        ("http://100.64.0.1/", false),
        ("http://100.127.255.255/", false),
        ("http://198.18.0.1/", false),
        ("http://224.0.0.1/", false),
        ("http://255.255.255.255/", false),
        ("http://[::1]/", false),
        ("http://[::]/", false),
        ("http://[::ffff:127.0.0.1]/", false),
        ("http://[::ffff:10.0.0.1]/", false),
        ("http://[::ffff:169.254.169.254]/", false),
        ("http://[::ffff:8.8.8.8]/", true),
        ("http://[fc00::1]/", false),
        ("http://[fd12:3456::1]/", false),
        ("http://[fe80::1]/", false),
        ("http://[fec0::1]/", false),
        ("http://[ff02::1]/", false),
        ("http://[64:ff9b::7f00:1]/", false),
        ("http://[2002:7f00:1::]/", false),
        ("http://[2002:808:808::]/", true),
    ];
    for (u, ok) in faelle {
        let r = check_url(&Url::parse(u).unwrap());
        assert_eq!(r.is_ok(), ok, "{u}: {r:?}");
    }
}

// Ohne Netz: gesperrte Adresse kommt nie bis zum Verbindungsaufbau
#[tokio::test]
async fn get_sperrt_vor_verbindung() {
    let e = dw_net::get("http://127.0.0.1:9/", Default::default()).await.unwrap_err();
    assert!(matches!(e, dw_net::Error::Blocked(_)), "{e:?}");
}
