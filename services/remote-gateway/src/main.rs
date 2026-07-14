use std::{net::SocketAddr, sync::Arc};

use somniq_remote_gateway::{router, GatewayConfig, GatewayState};
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "somniq_remote_gateway=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Arc::new(GatewayConfig::from_env()?);
    let state = GatewayState::load(config)?;
    let bind_addr: SocketAddr = std::env::var("SOMNIQ_GATEWAY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8787".to_owned())
        .parse()?;

    let listener = TcpListener::bind(bind_addr).await?;
    info!(address = %bind_addr, "SomniQ remote gateway listening");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
