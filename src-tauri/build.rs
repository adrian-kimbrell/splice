// Security note — tauri.conf.json "security" section:
//
// style-src requires 'unsafe-inline' because CodeMirror 6 injects editor theme
// styles at runtime via CSSStyleSheet / adoptedStyleSheets. Removing it breaks
// syntax highlighting. dangerousDisableAssetCspModification: ["style-src"]
// prevents Tauri from overriding this intentional allowance at asset-serve time.
// Revisit if Tauri gains nonce support for constructed stylesheets.

fn main() {
    tauri_build::build()
}
