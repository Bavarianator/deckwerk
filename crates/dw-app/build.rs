fn main() {
    // hell wie shell.css, unabhängig vom System-Thema
    let cfg = slint_build::CompilerConfiguration::new().with_style("fluent-light".into());
    slint_build::compile_with_config("ui/app.slint", cfg).expect("Slint-Datei");
}
