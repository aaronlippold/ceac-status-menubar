fn main() {
    // An app manifest is required for a remote page (the CEAC site) to call app
    // commands; each listed command gets `allow-<command>` / `deny-<command>`
    // permissions that capabilities must grant explicitly.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "spike_report",
            "case_result",
            "open_ceac_window",
        ]),
    ))
    .expect("failed to run tauri-build");
}
