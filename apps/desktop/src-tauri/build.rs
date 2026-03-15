fn main() {
    println!("cargo:rerun-if-env-changed=GOOGLE_OAUTH_CLIENT_SECRET");

    let target_triple = std::env::var("TAURI_ENV_TARGET_TRIPLE")
        .or_else(|_| std::env::var("TARGET"))
        .unwrap_or_default();
    if !target_triple.is_empty() {
        let extension = if target_triple.contains("windows") {
            ".exe"
        } else {
            ""
        };
        let binary_dir = std::path::Path::new("binaries");
        let binary_path = binary_dir.join(format!("philo-cli-{}{}", target_triple, extension));
        if !binary_path.exists() {
            let _ = std::fs::create_dir_all(binary_dir);
            let _ = std::fs::write(&binary_path, b"placeholder");
        }
    }
    tauri_build::build()
}
