/// Give `cargo test` binaries the common-controls v6 assembly dependency.
///
/// `rfd` (pulled in by `tauri-plugin-dialog`) statically imports
/// `comctl32!TaskDialogIndirect`, which exists only in the side-by-side
/// version 6 of comctl32 — the version an application gets by *declaring* it in
/// a manifest. `tauri_build::build()` embeds such a manifest into the app
/// binary, but not into the test harness binaries Cargo links from the same
/// lib. Without it the loader binds against the v5 comctl32 in System32, fails
/// to resolve the import, and kills the process with
/// `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139) *before* `main` — so every unit
/// test in this crate aborts with no output and no failing test name.
///
/// The flag goes through the catch-all `rustc-link-arg`, not
/// `rustc-link-arg-tests`: Cargo scopes the latter to `tests/` integration
/// targets, while `cargo test --lib` links the *lib* target in test mode, which
/// only the catch-all reaches. `/MANIFEST:EMBED` is deliberately NOT passed —
/// `tauri_build` already embeds an `RT_MANIFEST` resource in the app binary and
/// a second embedded manifest is a link error. Declared as a dependency alone,
/// the linker emits a sidecar `.manifest`, which the loader reads for the test
/// binaries that need it and which the app binary simply ignores in favour of
/// its own embedded copy.
#[cfg(all(target_os = "windows", target_env = "msvc"))]
fn manifest_common_controls_for_tests() {
    const COMMON_CONTROLS_V6: &str = "/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'";
    println!("cargo:rustc-link-arg={COMMON_CONTROLS_V6}");
}

#[cfg(not(all(target_os = "windows", target_env = "msvc")))]
fn manifest_common_controls_for_tests() {}

fn main() {
    println!("cargo:rerun-if-env-changed=ARIS_OUTLOOK_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=ARIS_RELEASE_UNIX_TIMESTAMP");
    manifest_common_controls_for_tests();

    if let Ok(value) = std::env::var("ARIS_RELEASE_UNIX_TIMESTAMP") {
        let value = value.trim();
        value
            .parse::<i64>()
            .expect("ARIS_RELEASE_UNIX_TIMESTAMP must be Unix seconds");
        println!("cargo:rustc-env=SOMNIQ_RELEASE_UNIX_TIMESTAMP={value}");
    }

    tauri_build::build();
}
