//! `dw-daemon`: Engine-Prozess für den Datenordner ($DECKWERK_HOME bzw. ~/Deckwerk, DW_EDITION=pro → ~/DeckwerkPro).

fn main() -> anyhow::Result<()> {
    let store = dw_store::Store::open(dw_store::Edition::from_env())?;
    let server = dw_daemon::Server::bind(store)?;
    eprintln!(
        "dw-daemon: {}",
        dw_daemon::socket_path(server.daemon().store()).display()
    );
    server.run()?;
    Ok(())
}
