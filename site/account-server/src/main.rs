#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let config = somniq_account_server::config::Config::from_env()?;
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    let app = somniq_account_server::App::new(config)?;
    tracing::info!(address=%listener.local_addr()?, "SomniQ account service listening");
    axum::serve(listener, somniq_account_server::router(app))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
