fn main() {
    tauri_build::build();

    // macOS: tauri-plugin-multiline-menubar 的 native ObjC++（cc 编译）会生成对
    // `___isPlatformVersionAtLeast` 的引用（@available 平台检查），该符号定义在
    // Xcode toolchain 的 clang runtime（libclang_rt.osx.a）。rustc 默认不链接它，
    // 而 rustc 链接用 `-nodefaultlibs`（clang 驱动不会自动附加），导致
    // `cargo build --bins --release`（tauri build 的调用方式）报 undefined symbol。
    // 这里显式把 clang runtime 加入链接搜索路径并静态链接。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        link_clang_rt();
    }
}

fn link_clang_rt() {
    // 定位 clang 可执行文件 → toolchain 根 → lib/clang/<ver>/lib/darwin/libclang_rt.osx.a
    let Ok(out) = std::process::Command::new("xcrun")
        .args(["--find", "clang"])
        .output()
    else {
        return;
    };
    if !out.status.success() {
        return;
    }
    let clang_path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let toolchain_usr = std::path::Path::new(&clang_path)
        .parent() // bin
        .and_then(|p| p.parent()); // usr
    let Some(toolchain_usr) = toolchain_usr else {
        return;
    };
    let clang_dir = toolchain_usr.join("lib/clang");
    let Ok(entries) = std::fs::read_dir(&clang_dir) else {
        return;
    };
    for e in entries.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let darwin_dir = e.path().join("lib/darwin");
        if darwin_dir.join("libclang_rt.osx.a").exists() {
            println!("cargo:rustc-link-search=native={}", darwin_dir.display());
            println!("cargo:rustc-link-lib=static=clang_rt.osx");
            return;
        }
    }
}
