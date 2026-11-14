# ADR-0001: Cross-platform tray app (Tauri) that checks CEAC case status with a human-typed CAPTCHA

**Date:** 2026-11-13 (revised the same day after cross-model review; see Review Log)
**Status:** accepted (2026-11-13, after three review rounds)
**Deciders:** Aaron Lippold

## Context

The State Department's CEAC status page (https://ceac.state.gov/CEACStatTracker/Status.aspx) is the only official way to check a visa case's status. It has no public API. An immigrant visa (IV) check takes a case number, passport number, the first five letters of the surname, and a CAPTCHA. Checking by hand means retyping all of that each time, keeping no history, and noticing changes yourself.

We want a tray (menu bar) item that shows the last known status and last-updated date, marks changes, keeps a dated history, and makes each check a ten-second task. The tool will monitor many cases (design for hundreds; expected use is 10 to 50) and may be given to immigration lawyers, so it handles client data and must install with a double-click.

Forces:

- **The CAPTCHA is typed by a human.** It is never solved, OCR'd, sent to a solving service, or bypassed. The same applies to the Cloudflare check in front of the site: the tool waits for it to clear and never adds stealth or evasion.
- **Client confidentiality.** A passport number is PII (NIST SP 800-122, section 2.1, lists "passport number"; section 4.2.1 says to minimize use, collection and retention of PII). Lawyers must make reasonable efforts to prevent inadvertent or unauthorized disclosure of, or access to, client information (ABA Model Rule 1.6(c); ABA Formal Opinion 477R applies this to technology on a risk basis). The ABA site blocked automated fetching, so the rule and opinion text were confirmed through secondary sources.
- **Platforms.** Lawyers may use macOS or Windows.
- **Site etiquette.** Checks happen only when a human asks. One page load per check, no retry loops, and a minimum interval per case.

### Facts confirmed on the live site (2026-11-13)

- **Cloudflare.** The page is behind Cloudflare.
  - `curl` and server-side fetches are blocked outright.
  - Playwright's bundled Chromium got a "Just a moment..." challenge that cleared by itself after about 8 seconds.
  - The Tauri webview (WKWebView, macOS) loaded the form with no challenge and reports `navigator.webdriver === false`, with no changes from us.
- **IV form fields.**
  - `Visa_Application_Type`: options `IV` and `NIV`, IV is the default. Changing it runs an ASP.NET `__doPostBack` inside `ctl00_ContentPlaceHolder1_UpdatePanel1`.
  - `Visa_Case_Number`, `Passport_Number`, `Surname` (first 5 letters).
  - `Captcha`: a BotDetect image `c_status_ctl00_contentplaceholder1_defaultcaptcha_CaptchaImage`, with reload and sound links.
  - All four inputs have required-field validators.
  - There is no location dropdown for IV. NIV adds one; it was not inspected.
- **Submit** is the postback link `ctl00_ContentPlaceHolder1_btnSubmit`.
- **Errors** appear in `ctl00_ContentPlaceHolder1_lblError`.
  - Wrong code: "The code entered does not match the code displayed on the page."
  - Unknown case data: "Your search did not return any data."
- **Result panel** (the field IDs share the prefix `ctl00_ContentPlaceHolder1_ucApplicationStatusView_`):
  - `lblStatus`
  - `lblSubmitDate` (case created)
  - `lblStatusDate` (last updated)
  - `lblMessage`

  Dates are formatted `DD-Mon-YYYY` (for example `12-Nov-2026`).

### Spike evidence

A throwaway spike (branch `spike/tauri`, folder `spike/tauri/`) ran a real check end to end on macOS:

1. A tray icon opens a small window with the CEAC page.
2. An injected script fills the case fields out of sight, then shows only the site's own CAPTCHA image, reload and sound links, code field, Submit button and error text.
3. The human types the code and presses Submit.
4. The script reads the result panel and sends it to the app.
5. The window closes and the tray title shows `<status> · <last updated>`.

Wrong-code and no-data errors displayed correctly, and a fresh CAPTCHA loaded after each.

The spike also found:

- **Remote pages need explicit permission.** Tauri rejects IPC calls from a remote origin unless the app declares an ACL manifest (`tauri_build::AppManifest::commands`) and a capability with `remote.urls` grants `allow-<command>`. The rejection comes back to the caller as a rejected invoke, with a detailed reason in debug builds (tauri 2.12.5, `src/webview/mod.rs`). The spike's script only logged rejections to the page console, which is why they looked silent.

The spike is a prototype, not a reference implementation. The review found defects in it that the implementation must not copy:

- The script runs on every page the window navigates to.
- The progress command logs free-form strings from the page.
- Layout uses `offsetParent` on elements it has made `position: fixed`, where `offsetParent` is always `null`.
- The fields are refilled every tick, even in full-page mode.
- It reads `HOME`, which Windows does not set.

## Decision

Build a Tauri v2 desktop app with a tray icon. Tauri 2.12.x, stable features only, uses a Rust core, the system webview, and Vue 3 + TypeScript windows.

For each check, the app:

1. opens the CEAC page in its own small, private-browsing window;
2. pre-fills that one case from an encrypted local database;
3. shows the human only the site's CAPTCHA and Submit button;
4. reads the result and captures a screenshot of the result;
5. stores both, then updates the tray.

Reasons:

- **One codebase for macOS and Windows.** A tray icon, notifications, and signed `.dmg`/`.msi` installers come from the Tauri bundler and its official plugins.
- **No browser to ship or drive.** The system webview is a normal browser engine: no Playwright, no bundled Chromium, no automation flag. The spike showed it gets through Cloudflare without a challenge.
- **The CAPTCHA stays with the human.** The app never reads the CAPTCHA image or field value and never submits; the human presses the site's own Submit button.
- **A narrow, explicit trust boundary** (see Security Model): the CEAC page is untrusted as an IPC caller, and the database is reachable only from Rust.

### Security Model

The check window loads a third-party page. Every script in that origin, including the site's own analytics, Cloudflare and BotDetect, can see what our injected script sees and can call whatever that origin is allowed to call. Tauri authorizes by origin, window and command, not by which script is calling. So:

1. **Navigation is pinned to CEAC, and case values reach only the CEAC page.**
   - The check window allows navigation only to `https://ceac.state.gov/CEACStatTracker/` and Cloudflare's challenge origin `https://challenges.cloudflare.com/` (`on_navigation`), and refuses new windows (`on_new_window`).
   - On macOS the navigation callback also runs for embedded frames (wry 0.57.2 `wkwebview/navigation.rs` has no main-frame check), so every frame origin the page needs must be on the list. Phase 1 records the frame origins the live page actually loads.
   - **The injected initialization script holds no case values.** It contains only the page-state logic and the attempt id. Windows runs initialization scripts in every frame (wry 0.57.2 `webview2/mod.rs`, "Initialize main and subframe scripts").
   - Case values are sent to the main frame only.
     - Rust calls `eval` on **every** `on_page_load` "finished" event while the attempt is open, but only when `webview.url()` is exactly `https://ceac.state.gov/CEACStatTracker/Status.aspx`. `on_page_load` and `eval` act on the main frame only (wry 0.57.2).
     - The evaluated code checks `location` again, then hands the values to the main-frame script's closure.
     - The script fills and locks every new form instance, including the ones ASP.NET's `UpdatePanel` swaps in during partial postbacks (for example after a wrong code). Those swaps don't fire a page load.
   - In the test build, one build-time setting replaces the CEAC origin everywhere at once: the navigation list, the script guard, the start URL and the remote capability. Release builds contain only the CEAC origin, and a release-artifact check confirms the test origin is absent.
2. **One case per window, one attempt per check, with defined states.**
   - Rust creates an attempt with a random id, builds the window for that case only, and embeds the id in the injected script.
   - Progress and result calls must carry the current attempt id. Missing ids, unknown ids, and ids from attempts ended by Skip, Stop or closing the window are rejected.
   - **Non-terminal outcomes keep the attempt open:** `wrong_code` (a new CAPTCHA appears), `cloudflare_challenge` and `unknown_page`.
   - **Terminal outcomes close the attempt atomically:** `result` and `no_data`. Exactly one terminal outcome is accepted per attempt; a second is rejected.
   - **The result must belong to the attempt's case.** The result panel shows the case number (`..._ucApplicationStatusView_lblCaseNo`); Rust rejects a result whose case number doesn't match the attempt's case.
   - **Identifier fields are locked.** The script makes the case number, passport and surname fields read-only after filling them, including in "Show full page" mode. Changing a case's identifiers happens only in the app's case editor, followed by a new check.
3. **Remote commands are minimal and typed.**
   - The remote capability grants exactly two commands: progress and result.
   - Progress takes a fixed enum stage plus booleans, lengths and, for the `capture_layout` stage, the result panel's width and height as bounded integers. Rust clamps those to a maximum window size. Progress never takes free strings.
   - The result takes an outcome enum plus, for `result`, five strings (status, created, last updated, message, case number) with length limits and character checks.
   - No other command, plugin permission, database, filesystem or shell access is ever reachable from any webview that can load remote content.
   - Commands that create windows or capture screenshots are async, or run on spawned tasks. Building a webview window from a synchronous command or menu handler deadlocks on Windows (wry issue #583).
4. **Residual risk, accepted and documented.**
   - A script running in the CEAC origin can see that case's identifiers. The site receives them on submit anyway.
   - Such a script could also send a fabricated result for the current attempt. DOM-derived results cannot authenticate themselves. Mitigations:
     - one result per attempt;
     - the screenshot stored with every result as evidence;
     - a "wrong result? recheck" action in the case history.
5. **Nothing persists in the webview.**
   - The check window uses `incognito(true)`: a non-persistent data store on macOS; on Windows, incognito requires WebView2 Runtime 101.0.1210.39 or later, so the app checks the version and refuses to check on older runtimes.
   - Each check is a new window with its own private session, and the window is closed before the next check starts, so a lawyer's clients are not linked through one server session. Phase 1 verifies this on both platforms: on Windows, private-mode webviews in one environment share a session until all of them close.
   - `clear_all_browsing_data()` is called before close as **best effort only**. Tauri 2.12.5 documents the deletion as asynchronous, and wry passes it an empty completion handler, so the app cannot confirm it finished. Isolation rests on the private sessions, not on clearing.
   - WebView2 still creates a user data folder on disk even in private mode. Its location is documented in the README's "delete everything" section.
6. **`withGlobalTauri` is off.** Events go to named local windows with `emit_to`, never broadcast.
7. **Logs** carry stage enums, outcome codes, lengths and attempt ids only. They never carry identifiers, statuses, messages, page titles or page text.

## Alternatives Considered

### Alternative A: Python + Playwright checker, SwiftBar menu bar plugin (original plan)
A SwiftBar script renders the menu from a history file. "Check now" runs a Python Playwright script in a headed Chromium.
- **Pros:** Small and quick to build. Python test tooling is simple.
- **Cons:**
  - macOS only.
  - No double-click install: it needs Homebrew, SwiftBar, uv and a Chromium download.
  - Long-running actions under SwiftBar are untested, and SwiftBar issue #594 (crash when launched by URL scheme) is open.
  - The bundled Chromium got a Cloudflare challenge.
  - Notifications from scripts are unreliable on recent macOS.
- **Why rejected:** It doesn't meet the cross-platform and double-click install requirements.

### Alternative B: Electron
- **Pros:** Mature tray, notification and installer support. Playwright can drive it, so end-to-end tests are easy. Everything is TypeScript.
- **Cons:** Ships Chromium (about 150 MB per install) and must be kept patched. It may draw the same Cloudflare challenge as Playwright's Chromium (not tested).
- **Why rejected:** Heavier, with no capability we need beyond Tauri; the spike already proved Tauri.

### Alternative C: GPUI (Zed's UI framework)
- **Pros:** Native GPU rendering on macOS, Windows and Linux. Apache-2.0.
- **Cons:**
  - Version 0.2.x with thin documentation.
  - No tray support: zed-industries/zed PR #44047 "gpui: Add Tray support" was closed without merging.
  - No webview, so it cannot host the CEAC page.
- **Why rejected:** It lacks the tray and webview this design depends on.

### Alternative D: Browser extension (Chrome/Edge/Safari, Manifest V3)
A content script pre-fills CEAC in the user's own browser. The toolbar badge shows status, `captureVisibleTab` takes the screenshot, and data sits in extension storage.
- **Pros:** Runs in a real browser. No Rust toolchain. Chrome and Edge need no installer signing.
- **Cons:**
  - No menu bar or tray item; status shows only in the browser toolbar, and only while the browser is open.
  - No OS credential store, so encryption at rest needs a passphrase every session, or client passport numbers sit unencrypted in browser storage.
  - Distribution goes through a store listing with review, or loading the extension by hand. Safari needs Xcode and an Apple Developer account anyway.
  - It is a second product that shares little code with this one.
- **Why rejected:** It fails the tray requirement and weakens data protection.

### Alternative E: Full-page check window
Show the whole CEAC page with fields pre-filled, instead of the CAPTCHA-only view.
- **Pros:** No layout overrides on a third-party page; simpler capture.
- **Cons:** The user asked for a small window that shows only the CAPTCHA and hides data already in the database.
- **Why rejected:** The CAPTCHA-only view is a stated requirement. Full page stays available as a fallback ("Show full page") when the site's layout changes.

### Alternative F: Existing open-source CEAC trackers
Andision/CEACStatusBot (GPL-3.0), lixin-wei/ceac_tracker (no license), yuzeming/CEACStatTracker (no license).
- **Why rejected:** All three solve the CAPTCHA automatically, using an ONNX OCR model, the 2captcha service, or a probe script. CEACStatusBot is kept as a design reference only, because its result-panel IDs matched what we confirmed. No code is copied.

### Alternative G: USCIS Case Status API
The official USCIS Torch API (OAuth 2.0, scope `read:case-status`; production access requires approval).
- **Why rejected:** It covers USCIS receipt numbers, not CEAC/NVC visa cases. Possible future work for cases still at USCIS.

### Alternative H: Do nothing
Keep checking by hand on the website. This works for one case but gives no history or change alerts and doesn't scale to a caseload.

### Queue controls for "Check all": where Skip and Stop live
The options were:
- (a) a toolbar from our app and the CEAC page as two webviews in one window, using Tauri's multi-webview;
- (b) a separate small control window docked to the check window;
- (c) native controls only: the window title "CEAC check · <nickname> (k of n)" plus Skip and Stop in the tray menu;
- (d) controls injected into the CEAC page.

**Chosen: (c), adding (b) only if (c) proves clumsy in use.**
- (a) is rejected. `Window::add_child` exists only behind Tauri's `unstable` feature (2.12.5, `src/window/mod.rs`), and its open macOS bugs affect typing in inputs:
  - tauri #8705, "double char input in multiwebview on macos", open since 2024-01;
  - tauri #10194, arrow keys insert stray characters, confirmed again in 2026-07, with one report that it also occurs without the flag.

  Typing the CAPTCHA is this window's whole purpose. No stabilization of multi-webview was found, including for v3.
- (d) is rejected because page scripts could operate the controls, the controls die when the page hangs, and they would need more remote permissions.

## Prior Art

Checked 2026-11-13. Health comes from `gh api` (latest release, last merged PR, last commit, archived) or the crates.io/npm registries. Licenses come from each repo or registry.

| Candidate | License | Latest release | Last activity | Archived | Verdict |
|---|---|---|---|---|---|
| tauri | Apache-2.0 / MIT | 2.12.5 (crates.io, 2026-11-06); v3 in alpha | commit 2026-11-13 | no | **ADOPT** (stable features only) |
| tauri plugins-workspace: notification 2.8.1, updater 2.14.1 | Apache-2.0 / MIT | 2026-10/11 | commit 2026-11-12 | no | **ADOPT** notification; updater is future work |
| tauri-plugin-sql | Apache-2.0 / MIT | 2.6.0 (2026-10-14) | same workspace | no | **REJECT**: exposes SQL to webviews; the database stays in Rust |
| rusqlite (`bundled-sqlcipher`) | MIT | 0.42.0 (2026-11-11) | active | no | **ADOPT**, pending the SQLCipher/OpenSSL license check in Phase 3 |
| keyring (OS credential store) | MIT OR Apache-2.0 | 4.2.0 (2026-08-29) | active | no | **ADOPT** |
| zeroize | MIT OR Apache-2.0 | not checked | not checked | not checked | **ADOPT** after a health check in Phase 3 |
| hypothesi/mcp-server-tauri + tauri-plugin-mcp-bridge | MIT | 0.13.2 (npm and crates.io, 2026-10-22) | commit 2026-10-22 | no | **ADOPT** as a development-only tool (debug builds, loopback only, never in release). **ADAPT** its native capture code (`screenshot/macos.rs`, `screenshot/windows.rs`) for result screenshots, with attribution |
| vitest | MIT | 5.1.0 (npm, 2026-11-02) | active | no | **ADOPT** (unit tests) |
| @playwright/test | Apache-2.0 | 1.65.1 (npm, 2026-11-13) | active | no | **ADOPT** (test-only: page script in WebKit and Chromium; never shipped) |
| P3GLEG/tauri-plugin-mcp | none | v0.3.1 (2026-07-17) | commit 2026-10-14 | no | REJECT (no license) |
| Electron | MIT | v45.3.2 (2026-11-13) | active | no | REJECT (Alternative B) |
| GPUI | Apache-2.0 | 0.2.2 (2026-10-30) | active | no | REJECT (Alternative C) |
| SwiftBar | MIT | v2.1.1 (2026-08-11) | merged PR 2026-11-08 | no | REJECT (Alternative A) |
| playwright-python | Apache-2.0 | v1.65.1 (2026-11-11) | active | no | REJECT: not needed with the webview design |
| Andision/CEACStatusBot | GPL-3.0 | none | commit 2026-01-26 | no | REFERENCE (field IDs only) |
| lixin-wei/ceac_tracker | none | none | commit 2022-12 (**STALE**) | no | REJECT |
| yuzeming/CEACStatTracker | none | none | commit 2024-04 (**STALE**) | no | REJECT |

## Consequences

**What becomes easier:**
- Installing: one signed installer per platform, with nothing else to install.
- Many cases: the database, queue and case list are app features, not scripts.
- Keeping client data private: data stays local and encrypted at rest, browsing is private per check, and the CEAC origin can call only two typed commands.

**What becomes harder:**
- The stack is Rust, TypeScript and Vue, so contributors need a Rust toolchain (pinned with mise and `rust-toolchain.toml`).
- Signing costs money and needs accounts:
  - macOS: Apple Developer Program membership. Only the Account Holder can create a Developer ID Application certificate, and notarization is required.
  - Windows: a code-signing route such as Azure Trusted Signing or an EV certificate. An ordinary certificate does not clear SmartScreen's "Windows protected your PC" until it builds reputation.
- Two webview engines (WKWebView, WebView2) must both be verified against the live site.
- The tray behaves differently by platform: Windows tray icons cannot show text (Tauri 2.12.5: `set_title`, "Windows: Unsupported").

**Risks:**
- **The CEAC page changes** its IDs, layout or CAPTCHA.
  - Mitigation: element IDs live in one module; an unknown page reports `unknown_page`; the check window falls back to "Show full page".
- **Cloudflare starts challenging the webview.**
  - Mitigation: the challenge shows in the check window for the human to complete. We never bypass it.
- **Site terms of use were not retrievable** (the disclaimer page returned 403 to automated fetches).
  - Mitigation: human-triggered checks only, a minimum interval per case, one page load per check, a cooldown between cases in Check all, and Check all pauses when a page can't be used (see Etiquette).
- **Typing bugs in WKWebView inputs** (tauri #10194 reports may affect single-webview windows).
  - Mitigation: an acceptance test for exact CAPTCHA input on both platforms (Phase 4).
- **Key loss makes the database unreadable.**
  - Mitigation: an exportable recovery key at first run and an encrypted backup/restore (Phase 3). Error messages never offer to create a new empty database silently.
- **Windows behavior is unverified** (WebView2, Cloudflare, tray, private browsing).
  - Mitigation: a Windows feasibility check in Phase 1, before most of the work.

## Implementation Plan

### Scope

**IN scope (v1):**
- **Case types:** immigrant visa (IV) cases only. Other types are rejected at entry and on import, before CEAC is opened.
- **Tray:**
  - macOS title: one case shows `<status> · <last updated>`; several cases show `<N> cases · <M> changed`.
  - A setting hides status text from the title (for screen sharing).
  - Windows: tooltip plus a summary line at the top of the menu.
  - Both platforms switch to an alert icon while unseen changes exist.
  - Menu: recent and changed cases, Check now, Check all, and Skip/Stop while a queue runs.
- **Check window:** CAPTCHA-only, one per case. The window title names the case nickname (and "k of n" in a queue).
- **Storage:** an encrypted local store for cases, check history and result screenshots, with a recovery key and encrypted backup/restore.
- **Case list window:** add, edit and delete; Check now per row and Check selected; CSV import; history and screenshot view; mark changes seen.
- **Notifications** on change, using nicknames only.
- **Minimum interval** per case, and a cooldown between cases in Check all.
- **Signed installers** for macOS and Windows.
- **README** with the no-CAPTCHA-bypass rule, the privacy model, and how to delete everything.

**OUT of scope:**
- Any automatic, scheduled or unattended check.
- CAPTCHA solving of any kind.
- NIV cases.
- Cloud sync, accounts, telemetry and multi-user sharing.
- Linux builds.
- USCIS API integration.
- Auto-update.

**Future work:**
- NIV cases (location dropdown; needs its own verified form contract).
- Auto-update (tauri-plugin-updater).
- USCIS receipt tracking.
- PDF export of a case history.
- Linux.

### Quality Standards (inherited by every card)

- **Framework first.**
  - Use Tauri v2 stable built-ins and official plugins: tray, notification, bundler, ACL/capabilities, `incognito`, `on_navigation`, `clear_all_browsing_data`.
  - No `unstable` feature.
  - Every new dependency needs a Prior Art row in this ADR.
- **Toolchain.**
  - `mise.toml` pins Node 24.22.3. `rust-toolchain.toml` pins Rust 1.100.0 with rustfmt and clippy; mise reads it.
  - Crate and npm versions are locked in `Cargo.lock` and `package-lock.json`.
- **Security model:** every card that touches the check window, IPC, storage or logs must satisfy the Security Model section, with a test for each rule it touches.
- **Privacy.**
  - Store only the fields the form needs. Screenshots go in the encrypted database, never as loose files.
  - The UI shows nicknames, not identifiers, except in the case edit form and the case's own screenshot view.
  - Deleting a case removes its history and screenshots.
  - Keys and identifiers are held in `zeroize` buffers in Rust.
- **No personal data in the repo.**
  - Tests and fixtures use synthetic values (`XXX0000000000`, `X0000000`, `XXXXX`).
  - Fixture pages are built from the confirmed page structure, never saved from a real check.
  - A test scans all log output for fixture identifiers.
- **Etiquette.**
  - A check runs only on a human action, with one page load per check and no automatic retries.
  - Minimum interval per case: default 6 hours, overridable with a confirmation.
  - Check all waits a cooldown between cases (default 5 seconds).
  - Check all pauses on a Cloudflare challenge, on `unknown_page` (which covers blocked and error pages), or when no page state is reported within 30 seconds of the window opening.
  - Webview hooks expose no HTTP status codes for remote pages, so 403/429 is never detected directly; it surfaces as `unknown_page` or a timeout.
- **Test strategy.**
  - **Rust:**
    - `cargo test` unit tests for parsing, change detection, unseen-change state, the interval rule, attempt ids and the repository, the repository against a temporary SQLCipher database.
    - Gates: `cargo clippy -- -D warnings`, `cargo fmt --check`, `cargo deny check` (licenses, advisories).
  - **Injected page script, logic:** TypeScript built to one file. Unit tests with Vitest + happy-dom against synthetic fixture pages: Cloudflare, form, wrong code, no data, result, unknown page.
  - **Injected page script, real engines:**
    - Playwright Test runs in **WebKit** (close to macOS WKWebView) and **Chromium** (close to Windows WebView2) against the mock CEAC pages. happy-dom has no layout engine, so these tests cover what it can't.
    - What they cover:
      - the CAPTCHA-only layout;
      - capture view sizing;
      - read-only identifier fields, before and after a wrong-code partial postback;
      - exact characters when typing, editing and pasting in the CAPTCHA field;
      - no submit or click from the script;
      - origin and path guards;
      - embedded frames never receiving case values.
    - The script is loaded the same way the app does: init script first, then the fill call. Playwright is test-only and never ships in the app.
  - **Vue windows:** Vitest + @vue/test-utils.
  - **End to end:**
    - Runs against a local mock CEAC server, in a test build where the build-time test origin replaces the CEAC origin (Security Model 1).
    - The test capability lives outside `src-tauri/capabilities/`, because Tauri includes every file in that folder automatically. Production `tauri.conf.json` lists its capabilities explicitly.
    - The test config overlay enables the test capability inline (a capability object in `app.security.capabilities`) or through `generate_context!(capabilities = [...])`. String references there resolve only against `src-tauri/capabilities/` (tauri-utils 2.10.2).
    - Production capabilities are tested separately to prove they deny the mock origin.
    - A release-artifact check confirms that the test origin, the test capability and the MCP bridge are all absent.
    - The tray can't be clicked by WebDriver, so tests start checks through a test-build-only trigger.
    - WebDriver on macOS is disputed between sources. Phase 1 proves which driver works on each platform and picks a macOS fallback if needed: driving the test build through the MCP bridge, or Rust integration tests.
  - **Live check:** a manual checklist run by a human before each release, on each platform.
- **Accessibility (windows we own):**
  - Keyboard reachable, visible focus, a label on every control, WCAG AA contrast.
  - The CAPTCHA view keeps the site's audio CAPTCHA link.
- **Performance (measurable):**
  - The tray menu model builds from one indexed query in under 50 ms for 500 cases (a Rust test).
  - The case list mounts and filters 500 rows in under 100 ms, or virtualizes rows (a Vitest test).

### Shared Abstractions (Phase 1 and 2 foundations)

| Shared need | Used by | Card it as |
|---|---|---|
| `CaseInput`, `CaseResult`, `CheckOutcome`, `CheckStage`, `AttemptId` types (Rust serde, mirrored in TS) with JSON contract fixtures | Phases 2, 4, 5, 6, 7 | Phase 1 |
| CEAC element IDs and page-state detection | Phases 2, 4, 5 | Phase 2 |
| Synthetic fixture pages and the mock CEAC server | Phases 2, 4, 5, end to end | Phase 2 |
| Encrypted store and repository | Phases 4 to 7 | Phase 3 |

### Phases

#### Phase 1: App skeleton, CI and feasibility checks (unblocked; start here)
Promote the spike to a real project at the repo root.
- **Files:**
  - Create: `src-tauri/` (Cargo.toml, build.rs with the app manifest, `capabilities/`), `src/` (Vue 3 + TS), `injected/` (TS page script), `package.json`, `vite.config.ts`, `deny.toml`, `.github/workflows/ci.yml`, `src-tauri/src/types.rs`, `src/types.ts`, `tests/fixtures/contract/*.json`.
  - Keep: `mise.toml`, `rust-toolchain.toml`, `.mcp.json`.
  - Remove after porting: `spike/`.
- **Acceptance criteria:**
  - [ ] `npm run tauri dev` starts a tray-only app: no Dock icon on macOS, no visible main window.
  - [ ] `withGlobalTauri` is false.
  - [ ] Identifier and product name are set (not `dev.local...spike`).
  - [ ] CI on macOS and Windows runs clippy, fmt, cargo test, cargo deny, tsc, Vitest and a debug build; all pass. The Windows runner has the build tools the SQLCipher/OpenSSL feature needs.
  - [ ] Contract tests prove the Rust and TS types serialize to the same JSON fixtures.
  - [ ] The MCP bridge is wired into dev builds only (an optional Cargo feature, enabled by the dev script) and bound to `127.0.0.1`. A release build's dependency tree contains no `tauri-plugin-mcp-bridge`.
  - [ ] Feasibility, recorded on the card:
    - On **Windows**, a WebView2 check window loads CEAC (Cloudflare outcome noted), honors `incognito`, and shows the tray. Window creation from an async task works without deadlock.
    - On **both platforms**:
      - the frame origins the live CEAC page loads are listed;
      - two checks in a row don't share cookies;
      - the MCP bridge can screenshot the check window;
      - end-to-end tests have a working driver: WebDriver where it works, otherwise the recorded fallback.
- **Verification:** `cargo test && cargo clippy -- -D warnings && cargo deny check && npm test && npm run build`

#### Phase 2: CEAC page script (blocked by 1)
TypeScript port of the spike's script, rewritten to the Security Model:
- an origin and path guard;
- the attempt id;
- no case values in the initialization script; a separate fill function that Rust calls with `eval`;
- page-state detection: Cloudflare, form, `wrong_code`, `no_data`, result, `unknown_page`;
- one-time pre-fill per form instance, then the identifier fields made read-only, including in "Show full page" mode;
- reading the result's case number (`lblCaseNo`) for Rust to match against the attempt;
- in the result capture view, waiting two animation frames after the view is shown before sending the result;
- the CAPTCHA-only layout, computed without `offsetParent`;
- the "Show full page" link at the lower right;
- the result capture view, which shows the full result panel and hides the CAPTCHA controls;
- result parsing, including `DD-Mon-YYYY` dates.
- **Files:** `injected/src/*.ts`, `injected/test/*.test.ts`, `tests/fixtures/ceac/*.html` (synthetic), `tests/mock-ceac/` (local server).
- **Acceptance criteria:**
  - [ ] Each fixture page maps to the correct state, outcome and result.
  - [ ] On a non-CEAC origin or path, the script does nothing, and the fill function refuses to run (fixture served from another origin). The initialization script source contains no case values (test on the generated script).
  - [ ] The script never reads the CAPTCHA image or field value and never triggers submit; a test asserts no `click()`, `submit()` or `__doPostBack` on submit.
  - [ ] Progress messages contain only enum stages, booleans, lengths and the attempt id.
- **Verification:** `npm test -- injected` (Vitest) and `npx playwright test --project=webkit --project=chromium` (real engines)

#### Phase 3: Encrypted store (blocked by 1)
rusqlite with SQLCipher. The key is 256 random bits passed as a raw key (`PRAGMA key = "x'<hex>'"`), kept in the OS credential store through keyring, and held in `zeroize` buffers.

Schema:
- `cases`: nickname, type (IV only), case number, passport, surname, minimum interval, last-seen check id.
- `checks`: case id, attempt id, checked_at (UTC), outcome, status, created, last updated, message, changed flag. Rows are immutable history.
- `screenshots`: check id, PNG blob, or the result-panel HTML as a fallback.

Migrations use `ON DELETE CASCADE`. At first run the app shows and exports a recovery key; encrypted backup and restore are included.
- **Files:** `src-tauri/src/store/*.rs`, `src-tauri/tests/store.rs`, `deny.toml`.
- **Acceptance criteria:**
  - [ ] The database file can't be opened without the key (test).
  - [ ] Restoring a backup on a fresh profile with the recovery key recovers every case and check (test).
  - [ ] A missing credential-store entry produces a clear error and a recovery-key prompt, never a new empty database.
  - [ ] Deleting a case removes its checks and screenshots.
  - [ ] A case's first `result` check is the baseline and has `changed = false`. Later `result` checks set `changed = true` when the status or the last-updated date differs from the previous `result` check. `no_data` checks never set `changed`.
  - [ ] Unseen changes are derived as `COALESCE(cases.last_seen_check_id, 0) < (id of the latest check with changed = true)`. Tests cover:
    - a change followed by an identical check before it is viewed (still unseen);
    - marking it seen;
    - a restart;
    - a new change arriving while the user is viewing the old one.
  - [ ] SQLCipher and OpenSSL licenses are read from source, recorded in this ADR's Prior Art table, and allowed by `cargo deny`.
  - [ ] A one-time import of a legacy `~/.config/ceac-status/config.toml` (path resolved with Tauri's path API, not `HOME`) asks before importing and before deleting the file. The file is restricted to its owner until deleted.
- **Verification:** `cargo test store`

#### Phase 4: Check flow (blocked by 2, 3)
Rust, from an async task:
1. enforces the minimum interval;
2. creates an attempt;
3. opens the private, navigation-pinned check window for one case, with an initialization script that holds only the attempt id;
4. sends the case values to the main frame with `eval` after the page is confirmed as the CEAC status page;
5. tracks the attempt through its states: `wrong_code`, `cloudflare_challenge` and `unknown_page` keep it open; `result` and `no_data` end it, and only one is accepted;
6. rejects a `result` whose case number doesn't match the attempt's case;
7. records the terminal outcome, detects changes, notifies on change, and emits a `check-saved` event;
8. calls `clear_all_browsing_data()` as best effort, then closes the window.

The tray reacts to `check-saved` in Phase 6.
- **Files:** `src-tauri/src/check.rs`, `src-tauri/src/commands.rs`, `src-tauri/capabilities/ceac-remote.json`, `src-tauri/tests/check.rs`.
- **Acceptance criteria:**
  - [ ] Navigation to a URL outside `/CEACStatTracker/` on `ceac.state.gov` is blocked, and new windows are refused (test).
  - [ ] A result with a missing, unknown or ended attempt id is rejected (test).
  - [ ] Wrong code → wrong code → result on one attempt saves exactly one check; a second terminal result for that attempt is rejected (test).
  - [ ] A result whose case number differs from the attempt's case is rejected and saves nothing (test).
  - [ ] The identifier fields are read-only after filling, including in full-page mode, and stay filled and read-only after a wrong-code partial postback (end-to-end test).
  - [ ] Navigating the check window to an origin that isn't allowed is cancelled. Embedded frames never receive case values, including a frame from an allowed non-CEAC origin such as the challenge origin (test page with embedded frames).
  - [ ] The production capability denies the mock origin; only the test build grants it (test).
  - [ ] A second check starts with no cookies or storage from the first; the mock page reports the cookies it receives. After the app restarts, no CEAC cookies are found in the webview data folders.
  - [ ] `wrong_code` keeps the window open with a fresh CAPTCHA and saves nothing; `no_data` saves a check with that outcome and shows it.
  - [ ] Typing, arrow keys, backspace and paste in the CAPTCHA field produce exactly the typed text, on macOS and Windows (manual check plus an end-to-end assertion on the field value in the test build).
  - [ ] Notifications use nicknames only.
- **Verification:** `cargo test check`, plus the end-to-end suite against the mock server.

#### Phase 5: Result screenshot (blocked by 4)
Adapt the native capture code from tauri-plugin-mcp-bridge (MIT, with attribution): WKWebView `takeSnapshot` on macOS, WebView2 `CapturePreview` on Windows.

Flow (the page is ready only after any resize):
1. On a result, the script switches to the result capture view, measures the result panel, and sends a `capture_layout` progress report with its width and height.
2. Rust resizes the window if the panel is larger than the visible webview area. Neither `CapturePreview` nor `takeSnapshot` can capture outside the visible area, so no capture rectangle is relied on.
3. The script waits until `innerWidth`/`innerHeight` are at least the panel size (a `resize` event or a check), then waits two animation frames, and only then sends the result.
4. Rust captures the visible webview in an async task, awaiting the platform callback through a `oneshot` channel. Blocking receives on the main thread are not allowed; the bridge's `recv_timeout` pattern deadlocks there.
5. Rust awaits the capture before it clears browsing data and closes the window.
- **Files:** `src-tauri/src/capture/{mod,macos,windows}.rs`, `THIRD_PARTY_NOTICES.md`.
- **Acceptance criteria:**
  - [ ] The stored PNG shows the status, both dates and the message, legibly. A test-build end-to-end run checks this against a mock result page whose panel is larger than the initial check window, so the resize path is exercised.
  - [ ] The PNG shows no CAPTCHA controls.
  - [ ] Capture needs no Screen Recording permission.
  - [ ] The window never closes before capture completes.
  - [ ] If capture fails, the result-panel HTML is stored encrypted and the check still succeeds. Stored HTML is displayed only as text or sanitized markup, never executed.
- **Verification:** `cargo test capture`, then a manual live check on each platform.

#### Phase 6: Tray, menu and Check all (blocked by 4)
Platform tray behavior as listed in Scope. The menu holds:
- up to 10 recent or changed cases, each with a submenu (Check now, History, Mark seen);
- Check all;
- Skip and Stop while a queue runs.

Check all is a queue ordered stalest first. It skips cases inside their interval, waits the cooldown between cases, and pauses under the Etiquette rules: a Cloudflare challenge, `unknown_page`, or no page state within 30 seconds. The check window title shows "(k of n)".
- **Files:** `src-tauri/src/tray.rs`, `src-tauri/src/queue.rs`, `src-tauri/tests/{tray,queue}.rs`.
- **Acceptance criteria:**
  - [ ] The menu model is correct for 0, 1 and 500 cases, on each platform's rules: macOS title, Windows tooltip and summary line, and the alert icon on both. Unit tests, plus a manual look on each platform.
  - [ ] The status-text-hiding setting works.
  - [ ] Skip and Stop work mid-queue and cancel the current attempt id; an interrupted queue keeps the checks already done.
  - [ ] The cooldown, the pause on a challenge or `unknown_page`, and the 30-second timeout are covered by tests with a fake clock.
- **Decision point:** if Skip/Stop in the tray menu proves clumsy in a real queue run, add a small docked control window that uses stable APIs only. That is a separate card.
- **Verification:** `cargo test tray queue`

#### Phase 7: Case list window (blocked by 3, 4, 5)
A Vue 3 window with a sortable, filterable table: nickname, status, last updated, last checked, changed. It provides:
- Check now per row, and Check selected;
- add, edit and delete with confirmation;
- CSV import with a validation report;
- per-case history with screenshots;
- mark seen;
- recovery-key export and backup/restore.
- **Files:** `src/windows/cases/*.vue`, `src/stores/*.ts`, `src/**/*.test.ts`, `src-tauri/src/commands.rs`.
- **Acceptance criteria:**
  - [ ] CSV import rejects the whole file on any bad row, with row-level errors.
  - [ ] CSV import rejects non-IV types.
  - [ ] Identifiers are masked in the table.
  - [ ] The case list window is created with `content_protected(true)`, so screen sharing and screen capture by other apps show it blank. This doesn't affect the app's own webview snapshots.
  - [ ] Keyboard-only use works, and the accessibility standards pass.
  - [ ] The performance threshold for 500 rows passes.
- **Verification:** `npm test`, plus a manual keyboard pass.

#### Phase 8: Signed installers (blocked by 1 and 4; needs accounts)
The `.dmg` is signed with Developer ID and notarized; the `.msi` is signed with the chosen Windows route. A CI release workflow holds secrets only in CI.
- **Acceptance criteria:**
  - [ ] A downloaded `.dmg` opens on a clean Mac with no Gatekeeper warning.
  - [ ] The `.msi` shows a verified publisher in the UAC prompt.
  - [ ] SmartScreen behavior is recorded for the chosen signing route.
  - [ ] The release artifacts contain no MCP bridge, no test capability and no test origin.
- **Blocked on decisions:** whose Apple Developer account signs, and which Windows signing route.

#### Phase 9: README, privacy notes and release verification (blocked by 5, 6, 7, 8)
- **README covers:**
  - what the app does;
  - install;
  - the no-CAPTCHA-bypass rule;
  - the privacy model;
  - where data lives;
  - recovery keys;
  - how to delete everything, including the webview cache locations.
- **Release verification:** the manual live checklist is run on macOS and Windows, covering every phase's features. Results are recorded on the card.

### Verification Strategy

- **End to end in CI**, in the test build against the mock CEAC server:
  - form, wrong code, then result;
  - no data;
  - a Cloudflare-style page;
  - an unknown page;
  - a non-CEAC navigation (blocked);
  - an origin that isn't allowed (denied);
  - a stale attempt id (rejected);
  - a result for a different case number (rejected);
  - a frame from an origin that isn't allowed (no case values reach it).
- A human runs the manual live check on each platform before every release.
- **Edge cases:**
  - the site is down, or serves a blocked or error page;
  - the page layout changes;
  - the window is closed mid-check;
  - two checks for the same case;
  - the credential-store entry is missing;
  - backup is restored on a new machine.
- **Security:**
  - `cargo deny`;
  - an ACL test for every command;
  - the log scan for fixture identifiers;
  - the release-artifact check for development-only components.

### Open Questions

1. Whose Apple Developer Program account signs the app, and which Windows signing route? (Phase 8)
2. Default minimum interval per case (proposed: 6 hours) and queue cooldown (proposed: 5 seconds).
3. Product name and bundle identifier.
4. Repo license before making it public.

## Review Log

**2026-11-13, round 1:** independent reviews by Codex (gpt-6-astra, high effort) and Gemini (gemini-4-argon-high, high effort), via PAL clink. Both verdicts: revise. Every finding was checked against Tauri 2.12.5 source or the spike before it was accepted. Dispositions:

| Finding | Source | Disposition |
|---|---|---|
| Init script runs on every navigation; case values could reach other origins | both | FIXED: Security Model 1, Phase 2 and 4 ACs |
| Any script in the CEAC origin can call the remote commands | both | FIXED: Security Model 2–4 (attempt ids, typed commands, documented residual risk) |
| Webview data persists unencrypted; one shared server session | both | FIXED: Security Model 5, Phase 4 AC |
| Screenshot would capture the CAPTCHA view, be clipped, and race the window close | both | FIXED: Phase 2 result capture view, Phase 5 flow and ACs |
| Windows tray can't show a title | both | FIXED: platform tray behavior in Scope and Phase 6 |
| No unseen-change state | both | FIXED: `last_seen_check_id`, Phase 3 ACs |
| NIV implied but unspecified | both | FIXED: v1 is IV only; NIV is future work |
| Mock-server tests contradict the production ACL; WebDriver on macOS | both | FIXED: test-build capability, release-artifact check, Phase 1 driver proof. Gemini's "unsupported on macOS" claim conflicts with the Tauri docs, so it stays disputed until Phase 1 proves it |
| Release phase could finish before features; Windows tested last | Codex | FIXED: Phase 9 blocked by 5–8; Windows feasibility in Phase 1 |
| Full-page mode is simpler | Codex | REJECTED, with the reason recorded (Alternative E) |
| Skip/Stop can't live in the remote page; cooldown; pause on errors | Gemini | FIXED: queue-controls decision (c), plus Phase 6. Gemini's multi-webview suggestion was rejected on evidence (tauri #8705, #10194) |
| No key recovery; raw key; zeroize | Gemini | FIXED: Phase 3 |
| `no_data` outcome not recorded | Gemini | FIXED: Phase 4 |
| Phase order (tray before Phase 6; history needs screenshots); Windows build tools; untestable performance AC | Gemini | FIXED: `check-saved` event, Phase 7 blocked by 3–5, Phase 1 CI AC, measurable thresholds |
| Status text in the tray during screen sharing | Gemini | FIXED: hide-status setting, alert icon |
| `HOME` on Windows; refill overwrites full-page edits; `offsetParent` on fixed elements; free-string logging | Gemini | FIXED as implementation requirements (Spike evidence, Phase 2, Phase 3, Security Model 7). Severity downgraded to MINOR: these are throwaway spike defects |
| Browser extension and storing HTML instead of screenshots | Gemini | Extension REJECTED (Alternative D). Native screenshots kept, with HTML fallback, because adaptable MIT capture code exists |
| SmartScreen and UAC wording | Gemini | FIXED: Consequences and Phase 8 ACs |

**2026-11-13, round 2:** fresh-session re-reviews by the same two models, using the round-1 ledger. Codex: 16 rows addressed, 2 partly, 5 new findings, verdict revise. Gemini: 14 addressed, 4 partly, 7 new findings, verdict accept with changes. Platform claims were checked against tauri 2.12.5, wry 0.57.2 and tauri-runtime-wry 2.12.3 source before acceptance.

| Finding | Source | Disposition |
|---|---|---|
| `clear_all_browsing_data` is asynchronous with no completion signal; the "nothing remains" AC races it | both | FIXED: isolation rests on per-check private sessions; clearing is best effort (Security Model 5); Phase 4 AC tests a second check and the state after restart |
| Mock origin can't pass the origin guard or the navigation rule | Codex | FIXED: one build-time test origin applied everywhere; release check (Security Model 1, Test strategy) |
| Full-page edits could attach another case's result | Codex | FIXED: identifier fields locked read-only; result case number must match (Security Model 2, Phase 2 and 4 ACs) |
| One-result-per-attempt conflicts with retry after a wrong code | Codex | FIXED: non-terminal and terminal outcomes defined (Security Model 2, Phase 4) |
| ACL rejection wording | Codex | FIXED: Spike evidence |
| macOS navigation filter covers embedded frames and would block Cloudflare's challenge frame; Windows runs init scripts in every frame, which would expose embedded case values | Gemini | FIXED: challenge origin allowed and Phase 1 lists frame origins; no case values in the init script; values sent with `eval` to the main frame only after URL check (Security Model 1, Phase 2, Phase 4) |
| WebView2 capture has no capture rectangle; frame-timing order; blocking receive deadlocks on the main thread | Gemini | FIXED: Phase 5 flow |
| No way to detect 403/429/network errors | Gemini | FIXED: pause on challenge, `unknown_page`, or a 30-second state timeout (Etiquette, Phase 6) |
| WebDriver on macOS AC can't pass as written; window creation in synchronous handlers deadlocks on Windows | Gemini | FIXED: Phase 1 driver fallback; async-only window and capture work (Security Model 3) |
| Capability files are all included automatically | Gemini | FIXED: test capability outside `src-tauri/capabilities/`, explicit production list; Phase 8 blocked by 4 |
| Case list visible during screen sharing | Gemini | FIXED: `content_protected(true)` (Phase 7) |
| First-check baseline and NULL handling for unseen changes | Gemini | FIXED: Phase 3 AC |

**2026-11-13, round 3:** scope-locked re-reviews of the round-2 changes, in fresh sessions. Codex: 11 of 12 rows addressed, 1 partly, 1 new finding, verdict revise. Gemini: 11 of 12 addressed, 1 partly, 3 new findings, verdict accept with changes (PASS).

| Finding | Source | Disposition |
|---|---|---|
| Capture readiness is checked before the optional window resize | Codex | FIXED: Phase 5 flow reordered (layout report, then resize, then confirm viewport and wait two frames, then result and capture); AC uses an oversized result panel |
| Resize needs a panel size that the command payloads didn't carry | Gemini | FIXED: `capture_layout` progress stage with bounded width and height (Security Model 3) |
| `UpdatePanel` partial postbacks replace the form without a page load, so the fill and read-only lock must be reapplied | Gemini | FIXED: `eval` on every finished page load; the script keeps the values and fills and locks every new form instance (Security Model 1); Phase 4 ACs cover wrong code and an allowed subframe |
| Test capability outside the capabilities folder must be inlined | Gemini | FIXED: Test strategy |

Also added after round 3, at the owner's request: Playwright Test (WebKit + Chromium) as a test-only layer for the page script, plus Vitest and Playwright rows in Prior Art.
