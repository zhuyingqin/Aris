//! Entry point for `aris-devserver`.  See `src/devserver.rs` for what it hosts.

fn main() {
    let options = match aris_desktop_lib::devserver::Options::from_args() {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start async runtime: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = runtime.block_on(aris_desktop_lib::devserver::serve(options)) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
