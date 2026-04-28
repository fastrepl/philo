fn main() {
    println!("cargo:rerun-if-env-changed=GOOGLE_OAUTH_CLIENT_SECRET");

    #[cfg(target_os = "macos")]
    build_check_permissions();

    ensure_cli_placeholder();
    tauri_build::build();
}

fn ensure_cli_placeholder() {
    let target_triple = std::env::var("TAURI_ENV_TARGET_TRIPLE")
        .or_else(|_| std::env::var("TARGET"))
        .unwrap_or_default();

    if target_triple.is_empty() {
        return;
    }

    let ext = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };

    let binary_dir = std::path::Path::new("binaries");
    let binary_path = binary_dir.join(format!("philo-cli-{target_triple}{ext}"));

    if !binary_path.exists() {
        let _ = std::fs::create_dir_all(binary_dir);
        let _ = std::fs::write(&binary_path, b"placeholder");
    }
}

#[cfg(target_os = "macos")]
fn build_check_permissions() {
    let triple = std::env::var("TARGET").unwrap();
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let swift_src = manifest_dir
        .join("../../../plugins/permissions/swift/check-permissions.swift");
    let binaries_dir = manifest_dir.join("binaries");
    let dst = binaries_dir.join(format!("check-permissions-{triple}"));
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let tmp = out_dir.join(format!("check-permissions-{triple}"));

    println!("cargo:rerun-if-changed={}", swift_src.display());
    std::fs::create_dir_all(&binaries_dir).expect("create binaries/");

    let status = std::process::Command::new("swiftc")
        .args(["-O", "-o"])
        .arg(&tmp)
        .arg(&swift_src)
        .status()
        .expect("failed to run swiftc");

    assert!(
        status.success(),
        "swiftc failed to compile check-permissions"
    );

    let compiled = std::fs::read(&tmp).expect("read compiled check-permissions");
    let should_update = std::fs::read(&dst)
        .map(|existing| existing != compiled)
        .unwrap_or(true);

    if should_update {
        std::fs::copy(&tmp, &dst).expect("copy check-permissions binary");
    }
}
