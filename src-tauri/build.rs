fn main() {
    println!("cargo:rerun-if-env-changed=RAMPULSE_SERVER_URL");
    tauri_build::build()
}
