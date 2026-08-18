---
name: tauri-macos-menubar-plugin
description: Build a Tauri v2 plugin that uses native Objective-C++ to customize
  the macOS menu bar (e.g. multi-line labels, custom NSStatusItem rendering).
  Use when the user asks for macOS menu bar plugins, NSStatusItem, custom menu
  bar widgets, or native macOS rendering in Tauri.
agent_created: true
disable-model-invocation: true
---

# Tauri macOS Menubar Plugin

Build a Tauri v2 plugin that uses native Objective-C++ to customize the macOS menu bar, such as rendering multi-line labels or custom `NSStatusItem` content.

## When to use

- The user wants a Tauri v2 plugin that adds/modifies the macOS menu bar.
- The request involves `NSStatusItem`, `NSStatusBar`, custom menu bar drawing, or multi-line menu bar text.
- The plugin needs to bridge Rust commands with AppKit Objective-C APIs.

## Workflow

### 1. Project setup

1. If a Tauri v2 app does not exist yet, scaffold one with `create-tauri-app`.
2. Create a local plugin inside `src-tauri/plugins/<plugin-name>/` using:
   ```bash
   npm run tauri -- plugin new <plugin-name> --directory src-tauri/plugins --no-example
   ```
3. Move the generated plugin into a named subdirectory if the CLI flattened it.

### 2. Link the plugin

In `src-tauri/Cargo.toml`, add a path dependency:

```toml
[dependencies]
tauri-plugin-<plugin-name> = { path = "./plugins/<plugin-name>" }
```

In `src-tauri/src/lib.rs` initialize it:

```rust
.plugin(tauri_plugin_<plugin_name>::init())
```

Add the default capability in `src-tauri/capabilities/default.json`:

```json
"<plugin-name>:default"
```

### 3. Add native Objective-C++ code

1. Create `src/native/` inside the plugin crate.
2. Write a C header (`*.h`) exposing C ABI functions.
3. Write an Objective-C++ implementation (`*.mm`) that uses AppKit (`NSStatusBar`, `NSStatusItem`, custom `NSView`, etc.).
4. Update the plugin `build.rs` to compile the `.mm` file with `cc` and link required frameworks:

```rust
if target_os == "macos" {
    cc::Build::new()
        .file("src/native/my_native.mm")
        .flag("-fobjc-arc")
        .compile("my_native");

    println!("cargo:rustc-link-lib=framework=Cocoa");
    println!("cargo:rustc-link-lib=c++");
}
```

5. Add `cc = "1"` to the plugin's `[build-dependencies]`.
6. **Critical**: in `build.rs` also emit `cargo:rerun-if-changed=src/native/my_native.mm` (and the `.h`). Without it, Cargo caches the old compiled native lib and will NOT recompile when you edit the `.mm`/`.h`, causing `Undefined symbols` linker errors for any newly added C functions referenced from Rust.

### 4. Rust bridge

In `src/desktop.rs`:

- Declare `extern "C"` functions matching the C header.
- Wrap calls in `#[cfg(target_os = "macos")]`.
- On non-macOS desktop, return an `UnsupportedPlatform` error.
- Expose methods on the plugin struct so commands can call them.

### 5. Commands and permissions

- Define request/response models in `src/models.rs`.
- Add `#[command]` handlers in `src/commands.rs`.
- Register commands in the plugin `init` function.
- Update `permissions/default.toml` with `allow-<command>` entries.
- Update `build.rs` `COMMANDS` array.

### 6. Frontend

Provide either:

- A TypeScript API in `guest-js/index.ts` built with Rollup, or
- Direct `invoke` calls from the frontend for demos.

Example direct invoke:

```ts
import { invoke } from "@tauri-apps/api/core";
await invoke("plugin:<plugin-name>|set_text", { payload: { top: "Sensor", bottom: "16W" } });
```

### 7. Click → popup WebView window (menubar-app behaviour)

Reference convention: the macOS menubar plugin family (`tauri-plugin-menubar-dnd`) owns its own `NSStatusItem`, and on click it positions a Tauri WebView window below the item and emits `menubar://*` events. Align to that:

- **Native side**: set `statusItem.button.target`/`action` to an `NSObject` handler. In the action, convert the button rect to screen coords:
  ```objc
  NSRect f = [button convertRect:[button bounds] toView:nil];
  NSRect s = [[button window] convertRectToScreen:f];
  ```
  Use `[NSApp currentEvent].type` to tell left/right. Call a registered C callback
  `void(*)(const char* button, double x, double y, double w, double h)` with the
  rect (macOS: origin bottom-left, y up).

### 7b. Right-click context menu (version + quit)

A native `NSMenu` is the cleanest macOS-way to expose version info and quit:

- In the click handler, use `[NSApp currentEvent].type` to detect right click
  (`NSEventTypeRightMouseDown/Up`). To make the status item button ALSO fire on
  right press, call the **method** (not property!):
  `[button sendActionOn:(NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown)];`
  in `ensure_status_item()`. On right click, branch early and show the menu instead
  of invoking the popup callback.
- Build the menu with `menu.autoenablesItems = NO;` then add a disabled `Version x.y.z`
  item (`action = nil; enabled = NO`), a separator, and a `Quit` item whose action
  calls `[[NSApplication sharedApplication] terminate:nil]`.
  Anchor it with `[menu popUpMenuPositioningItem:nil atLocation:NSMakePoint(0, NSMaxY(button.bounds)) inView:button];`
- Feed the version string from Rust `init` via a `multiline_menubar_set_version(const char*)`
  C function (read it with `app.package_info().version.to_string()`), copied into an
  `NSString` global on the native side.
- **Rust side**: store `AppHandle<Wry>` in a `OnceLock` set in `init` via
  `unsafe { std::mem::transmute_copy(app) }` (R is a zero-sized marker, layout
  identical). The `extern "C"` callback emits a `click` event and toggles the popup.
- **Position popup below item**: use `app.primary_monitor()` geometry; center
  horizontally on the item, flip y (`tauri_y = screen_h - rect_y - win_h`). Append
  an `on_window_event` handler that hides the popup on `WindowEvent::Focused(false)`
  (add a ~200ms ignore window so opening doesn't immediately self-close).
- **Events** on the `plugin-name://` scheme: `ready`, `click` (`{button,x,y,width,height}`),
  `popup-open`/`popup-close` (`{window}`).

### 8. Transparent popup window (required for frosted card UI)

`transparent: true` on a window needs `"app": { "macOSPrivateApi": true }` in
`tauri.conf.json` **and** the `macos-private-api` cargo feature on `tauri`,
otherwise macOS renders the window background black and prints:
`The window is set to be transparent but the macos-private-api is not enabled.`

## Important implementation notes

- Objective-C++ files compiled by `cc` require `libc++` linkage on Apple Silicon; add `cargo:rustc-link-lib=c++`.
- Menu bar rendering must happen on the main thread; dispatch UI work to `dispatch_get_main_queue()` from native code.
- Use `NSColor.textColor` so text follows light/dark mode automatically.
- Keep the plugin compile on non-macOS platforms by gating native calls with `cfg(target_os = "macos")` and returning `UnsupportedPlatform` errors.
- `NSStatusItem` created by the plugin is independent of Tauri's system-tray plugin.
- In ObjC, declare global `static` variables and `@interface` types BEFORE the
  `@implementation` that references them, or you get "use of undeclared identifier".

## Common pitfalls

- **macOS 26: dev and release MUST NOT share a bundle ID.** Control Center
  remembers menu-bar visibility per bundle ID (`trackedApplications`); stale
  state survives updates, so a dev run can mark the release app's status item
  hidden and vice versa — the app launches but no menu bar item appears, and
  System Settings toggling may not recover it because both builds fight over
  the same remembered state. Reference:
  https://b-log.to/tech-analysis/macos-26-controlcenter-trackedapplications-ghost/
  - Fix: give dev its own identity. Tauri v2 does NOT auto-load
    `tauri.conf.dev.json` — pass it explicitly:
    `tauri dev --config src-tauri/tauri.conf.dev.json` (JSON Merge Patch,
    RFC 7396; only the listed keys are overridden). Dev config example:
    `{ "productName": "MyApp-dev", "identifier": "com.example.myapp.dev" }`,
    and add `tauri:dev` / `tauri:build` npm scripts. Release keeps the base
    `tauri.conf.json` identity.
  - If the status item still never shows: quit the app → System Settings →
    Menu Bar → toggle the app entry off/on; ensure no other build shares the
    bundle ID; as a last resort rebuild the release app with a brand-new
    identifier to rule out stale remembered state.
- Forgetting to add `cargo:rustc-link-lib=c++` causes linker errors for `___gxx_personality_v0`.
- Mismatch between command names in `build.rs`, `lib.rs`, and permissions breaks invoke calls.
- Not updating `src-tauri/capabilities/default.json` causes permission denials at runtime.
- `app.primary_monitor()` returns `Result<Option<Monitor>, _>` — handle with `if let Ok(Some(m)) = ...`, not `if let Some(m) = ...`.
- `cfg(target_os = "macos")` blocks used as a function's tail expression need an `else`/explicit `return` branch, or you get `E0317` (expected Result, found `()`).
- A closure passed to `win.on_window_event` must be `'static`; clone the `AppHandle` (`app.clone()`) instead of capturing `&app`.
- `NSButton.sendActionOn` is a **method** (`- (void)sendActionOn:(NSEventMask)`), not a property — use bracket syntax `[button sendActionOn:...]`, not dot syntax `button.sendActionOn = ...` (the latter fails to compile).
- Native right-click menus: set `menu.autoenablesItems = NO` or the disabled `Version` item still shows; use `action = nil; enabled = NO` to grey it out as a title.
