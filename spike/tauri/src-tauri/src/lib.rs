//! Throwaway spike: a tray app that opens the CEAC status page in a small
//! window, fills the case fields out of sight, shows only the site's own
//! CAPTCHA and submit button for the human, and puts the result in the menu
//! bar title. The app never reads, solves or submits the CAPTCHA.

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

const CEAC_URL: &str = "https://ceac.state.gov/CEACStatTracker/Status.aspx";
const CEAC_WINDOW: &str = "ceac";
const TRAY_ID: &str = "main";
const INIT_SCRIPT: &str = include_str!("ceac_init.js");
const CASE_PLACEHOLDER: &str = "__CEAC_CASE_JSON__";

/// The values the IV status form needs. Synthetic unless the local config
/// provides all three real values.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseInput {
    label: String,
    case_number: String,
    passport: String,
    surname: String,
    synthetic: bool,
}

#[derive(Deserialize, Default)]
struct ConfigFile {
    #[serde(default)]
    case: ConfigCase,
}

#[derive(Deserialize, Default)]
struct ConfigCase {
    label: Option<String>,
    case_number: Option<String>,
    passport_number: Option<String>,
    surname: Option<String>,
}

/// Reads `~/.config/ceac-status/config.toml`. Values are never printed.
fn load_case() -> CaseInput {
    let synthetic = CaseInput {
        label: "Synthetic case".into(),
        case_number: "XXX0000000000".into(),
        passport: "X0000000".into(),
        surname: "XXXXX".into(),
        synthetic: true,
    };
    let Ok(home) = std::env::var("HOME") else {
        return synthetic;
    };
    let path = std::path::Path::new(&home).join(".config/ceac-status/config.toml");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return synthetic;
    };
    let Ok(config) = toml::from_str::<ConfigFile>(&text) else {
        eprintln!("SPIKE_ERROR config.toml did not parse; using synthetic values");
        return synthetic;
    };
    match (
        config.case.case_number,
        config.case.passport_number,
        config.case.surname,
    ) {
        (Some(case_number), Some(passport), Some(surname)) => CaseInput {
            label: config.case.label.unwrap_or_else(|| "Case 1".into()),
            case_number,
            passport,
            surname: surname.chars().take(5).collect(),
            synthetic: false,
        },
        _ => synthetic,
    }
}

/// Fields read from the CEAC result panel.
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CaseResult {
    status: String,
    case_created: String,
    last_updated: String,
    message: String,
}

/// Progress reports from the injected script. They carry field presence and
/// lengths only, never field contents.
#[tauri::command]
fn spike_report(app: AppHandle, webview: tauri::Webview, stage: String, detail: serde_json::Value) {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    println!("SPIKE_REPORT stage={stage} url={url} detail={detail}");
    let _ = app.emit(
        "spike-report",
        serde_json::json!({ "stage": stage, "detail": detail }),
    );
}

/// The parsed result panel. Shown in the menu bar; stdout gets lengths only.
#[tauri::command]
fn case_result(app: AppHandle, result: CaseResult) {
    println!(
        "SPIKE_REPORT stage=case_result detail={{\"statusLength\":{},\"createdLength\":{},\"lastUpdatedLength\":{},\"messageLength\":{}}}",
        result.status.len(),
        result.case_created.len(),
        result.last_updated.len(),
        result.message.len()
    );
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let title = format!("{} · {}", result.status, result.last_updated);
        let _ = tray.set_tooltip(Some(title.clone()));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(Some(title));
    }
    let _ = app.emit("case-result", result);
    if let Some(window) = app.get_webview_window(CEAC_WINDOW) {
        let _ = window.close();
    }
}

#[tauri::command]
fn open_ceac_window(app: AppHandle) -> Result<(), String> {
    open_ceac(&app).map_err(|e| e.to_string())
}

fn open_ceac(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(CEAC_WINDOW) {
        window.set_focus()?;
        return Ok(());
    }
    let case = load_case();
    println!(
        "SPIKE_REPORT stage=case_loaded detail={{\"synthetic\":{}}}",
        case.synthetic
    );
    let case_json = serde_json::to_string(&case).expect("CaseInput serializes");
    let script = INIT_SCRIPT.replace(CASE_PLACEHOLDER, &case_json);
    let url: Url = CEAC_URL.parse().expect("CEAC_URL is a valid URL");
    WebviewWindowBuilder::new(app, CEAC_WINDOW, WebviewUrl::External(url))
        .title(format!("CEAC check · {}", case.label))
        .inner_size(440.0, 340.0)
        .resizable(true)
        .always_on_top(true)
        .initialization_script(&script)
        .build()?;
    println!("SPIKE_REPORT stage=window_opened detail={{}}");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Development-only bridge that lets an MCP client screenshot and inspect
    // the app's windows. Bound to loopback; never part of a release build.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            spike_report,
            case_result,
            open_ceac_window
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let check = MenuItem::with_id(app, "check_now", "Check now", true, None::<&str>)?;
            let log = MenuItem::with_id(app, "show_log", "Show spike log", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&check, &log, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("bundle defines a default window icon");
            let tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .tooltip("CEAC status: not checked yet")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "check_now" => {
                        if let Err(e) = open_ceac(app) {
                            eprintln!("SPIKE_ERROR open_ceac: {e}");
                        }
                    }
                    "show_log" => {
                        if let Some(main) = app.get_webview_window("main") {
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            #[cfg(target_os = "macos")]
            tray.set_title(Some("CEAC: not checked"))?;
            println!("SPIKE_REPORT stage=tray_ready detail={{}}");

            if std::env::var("SPIKE_AUTOOPEN").as_deref() == Ok("1") {
                open_ceac(app.handle())?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        // Closing windows must not quit a tray app; only the Quit item (an
        // explicit exit code) ends it.
        if let RunEvent::ExitRequested { api, code, .. } = event
            && code.is_none()
        {
            api.prevent_exit();
        }
    });
}
