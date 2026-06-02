//! Streamable-HTTP MCP server lifecycle.
//!
//! Binds to `127.0.0.1` on the first available port in 19880-19882, mounts the rmcp
//! service at `/mcp`, and gates it with a Bearer-token middleware against the per-instance
//! token (same load_or_create pattern as the attention server, but a separate token file).

use std::sync::Arc;

use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
};
use rmcp::transport::{
    StreamableHttpServerConfig,
    streamable_http_server::{session::local::LocalSessionManager, tower::StreamableHttpService},
};
use tauri::AppHandle;
use tokio::net::TcpListener;

use crate::mcp::discovery;
use crate::mcp::handler::SpliceHandler;

/// Allowed ports for the MCP server. Picks the first one that's free, mirroring the
/// attention server's discovery pattern so two Splice instances on the same machine
/// can each claim a distinct port.
const CANDIDATE_PORTS: &[u16] = &[19880, 19881, 19882];

#[derive(Clone)]
struct AuthState {
    token: Arc<String>,
}

async fn auth_middleware(
    State(auth): State<AuthState>,
    headers: HeaderMap,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let presented = headers.get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    match presented {
        Some(t) if t == auth.token.as_str() => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

pub async fn start(app: AppHandle, token: String) -> Option<u16> {
    for &port in CANDIDATE_PORTS {
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                tracing::debug!(port, error = %e, "MCP port unavailable, trying next");
                continue;
            }
        };
        tracing::info!(port, "MCP server listening");
        discovery::write(port, &token);

        let auth = AuthState { token: Arc::new(token.clone()) };
        let handler_app = app.clone();
        let mcp_service: StreamableHttpService<SpliceHandler, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(SpliceHandler::new(handler_app.clone())),
                LocalSessionManager::default().into(),
                StreamableHttpServerConfig::default(),
            );

        let protected = Router::new()
            .nest_service("/mcp", mcp_service)
            .layer(middleware::from_fn_with_state(auth.clone(), auth_middleware));
        let router: Router = Router::new().merge(protected);

        tauri::async_runtime::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                tracing::error!(error = %e, "MCP server exited");
            }
        });
        return Some(port);
    }
    tracing::warn!("MCP server failed to bind any port in {:?}", CANDIDATE_PORTS);
    None
}
