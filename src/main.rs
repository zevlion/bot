mod cli;
mod ws;

use axum::{Router, routing::get};
use std::{env, sync::Arc};
use tokio::sync::broadcast;
use wacore::{
    pair_code::{PairCodeOptions, PlatformId},
    types::events::Event,
};
use whatsapp_rust::store::Backend;
use whatsapp_rust::{TokioRuntime, bot::Bot, store::SqliteStore};
use whatsapp_rust_tokio_transport::TokioWebSocketTransportFactory;
use whatsapp_rust_ureq_http_client::UreqHttpClient;

use cli::CliArgs;
use ws::{WsState, ws_handler};

/// Entry point.
///
/// Parses CLI arguments, sets up the auth directory and SQLite database path,
/// optionally handles logout by deleting session files, registers a graceful
/// shutdown handler, starts the Axum WebSocket server, and finally launches
/// the WhatsApp session.
#[tokio::main(name= "zevBot")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = CliArgs::parse();
    let port = cli
        .port
        .clone()
        .unwrap_or_else(|| env::var("PORT").unwrap_or_else(|_| "3000".to_string()));

    let auth_dir = cli.auth_dir.clone().unwrap_or_else(|| "auth".to_string());

    tokio::fs::create_dir_all(&auth_dir).await?;

    let db_path = format!("{auth_dir}/{}.db", cli.session);

    if cli.logout {
        println!("Logging out session: {}", cli.session);
        for suffix in ["", "-shm", "-wal"] {
            let path = format!("{db_path}{suffix}");
            match tokio::fs::remove_file(&path).await {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => eprintln!("Failed to remove {path}: {e}"),
            }
        }
        println!("Session cleared.");
        return Ok(());
    }

    let db_path_for_signal = db_path.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        println!("\nShutting down...");
        cleanup_db(&db_path_for_signal).await;
        std::process::exit(0);
    });

    let ws_state = WsState::new();

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(ws_state.clone());

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    println!("Listening on port {port} | session: {}", cli.session);

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    start_session(db_path, cli, ws_state.events_tx).await?;

    Ok(())
}

/// Initializes and runs a WhatsApp bot session.
///
/// Builds a [`Bot`] using the provided CLI configuration, attaches an SQLite
/// backend at `db_path`, and wires up an event handler that:
/// - Logs and broadcasts QR codes (if `--qrcode` is set), pairing results,
///   logouts, and disconnections over the given `events_tx` channel.
/// - Serializes every event to JSON and forwards it on the same channel.
///
/// If a phone number was supplied via `--pair`, a pairing-code flow is
/// initiated instead of QR-code pairing.
///
/// # Arguments
/// * `db_path`   – Path to the SQLite database file for this session.
/// * `cli`       – Parsed CLI arguments controlling session behaviour.
/// * `events_tx` – Broadcast sender used to push event strings to WebSocket clients.
///
/// # Errors
/// Returns an error if the store, bot, or underlying transport cannot be
/// initialised, or if the session itself encounters a fatal error.
async fn start_session(
    db_path: String,
    cli: CliArgs,
    events_tx: broadcast::Sender<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let backend: Arc<dyn Backend> = Arc::new(SqliteStore::new(&db_path).await?);

    let mut builder = Bot::builder()
        .with_backend(backend)
        .with_transport_factory(TokioWebSocketTransportFactory::new())
        .with_http_client(UreqHttpClient::new())
        .with_runtime(TokioRuntime);

    if let Some(phone) = cli.pair {
        println!("Requesting pair code for: {phone}");
        builder = builder.with_pair_code(PairCodeOptions {
            phone_number: phone,
            show_push_notification: true,
            custom_code: None,
            platform_id: PlatformId::Chrome,
            platform_display: "Chrome (Linux)".to_string(),
        });
    }

    let show_qr = cli.qrcode;
    let session = cli.session.clone();

    let mut bot = builder
        .on_event(move |event, _client| {
            let tx = events_tx.clone();
            let sname = session.clone();
            async move {
                let update = match &event {
                    Event::PairingQrCode { code, .. } => {
                        if show_qr {
                            println!("[{sname}] QR:\n{code}");
                        }
                        Some(code.clone())
                    }
                    Event::PairSuccess(_) => {
                        println!("[{sname}] Paired successfully!");
                        Some("Paired successfully!".to_string())
                    }
                    Event::PairError(_) => {
                        println!("[{sname}] Pairing failed.");
                        Some("Pairing failed.".to_string())
                    }
                    Event::LoggedOut(_) => {
                        println!("[{sname}] Logged out.");
                        Some("Connection Logged Out.".to_string())
                    }
                    Event::Disconnected(_) => Some("Connection closed.".to_string()),
                    _ => None,
                };

                if let Some(msg) = update {
                    let _ = tx.send(msg);
                }
                if let Ok(json) = serde_json::to_string(&event) {
                    let _ = tx.send(json);
                }
            }
        })
        .build()
        .await?;

    bot.run().await?.await?;
    Ok(())
}

/// Removes SQLite WAL and SHM sidecar files for the given database path.
///
/// Deletes `<db_path>-shm` and `<db_path>-wal` if they exist, allowing a
/// clean shutdown without leaving stale journal files on disk. Missing files
/// are silently ignored; other I/O errors are printed to stderr.
///
/// # Arguments
/// * `db_path` – Base path of the SQLite database (without the `-shm`/`-wal` suffix).
async fn cleanup_db(db_path: &str) {
    for suffix in ["-shm", "-wal"] {
        let path = format!("{db_path}{suffix}");
        match tokio::fs::remove_file(&path).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("Failed to remove {path}: {e}"),
        }
    }
}

/// Waits for a process termination signal.
///
/// Resolves on whichever arrives first:
/// - **Ctrl-C** (`SIGINT`) on all platforms.
/// - **SIGTERM** on Unix platforms (compiled out on non-Unix targets, where
///   this branch becomes a permanently pending future).
///
/// Intended for use with [`tokio::select!`] or [`tokio::spawn`] to trigger
/// graceful shutdown logic.
async fn shutdown_signal() {
    use tokio::signal;

    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to listen for Ctrl+C");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
