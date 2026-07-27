fn main() {
    println!("cargo:rerun-if-env-changed=ARIS_OUTLOOK_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=ARIS_RELEASE_UNIX_TIMESTAMP");

    if let Ok(value) = std::env::var("ARIS_RELEASE_UNIX_TIMESTAMP") {
        let value = value.trim();
        value
            .parse::<i64>()
            .expect("ARIS_RELEASE_UNIX_TIMESTAMP must be Unix seconds");
        println!("cargo:rustc-env=SOMNIQ_RELEASE_UNIX_TIMESTAMP={value}");
    }

    tauri_build::build();
}
