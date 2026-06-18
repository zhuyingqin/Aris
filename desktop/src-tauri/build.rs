fn main() {
    println!("cargo:rerun-if-env-changed=ARIS_OUTLOOK_CLIENT_ID");
    tauri_build::build();
}
