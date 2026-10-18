//! `dw-mcp`: MCP-Server für den Datenordner ($DECKWERK_HOME bzw. ~/Deckwerk, Pro: ~/DeckwerkPro), ersetzt `deckwerk --mcp`.
//! Ohne Argument stdio (Claude Code, Codex, Vibe). `--http`: Streamable HTTP auf 127.0.0.1 mit dem Token aus
//! DECKWERK_MCP_TOKEN (nie auf der Kommandozeile, sonst stünde es in `ps`); die erste Zeile auf stdout ist die URL.

use dw_store::{Edition, Store};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let edition = if dw_tools::PRO {
        Edition::Pro
    } else {
        Edition::from_env()
    };
    let store = Store::open(edition)?;
    let engine = dw_mcp::engine(&store)?;
    let server = dw_mcp::Server::new(dw_tools::ToolCtx::new(Box::new(engine), store));
    if std::env::args().any(|a| a == "--http") {
        let token = std::env::var("DECKWERK_MCP_TOKEN")
            .map_err(|_| anyhow::anyhow!("DECKWERK_MCP_TOKEN fehlt"))?;
        let (addr, task) = dw_mcp::serve_http(server, token).await?;
        println!("http://{addr}/mcp");
        task.await?;
        return Ok(());
    }
    dw_mcp::serve_stdio(server).await
}
