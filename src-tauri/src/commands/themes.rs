use std::path::PathBuf;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CustomTheme {
    pub name: String,
    pub colors: serde_json::Value,
}

fn themes_dir() -> Option<PathBuf> {
    Some(crate::state::splice_config_dir("Splice").join("themes"))
}

/// Largest theme file we accept (a theme is a few KB of colour keys).
const MAX_THEME_BYTES: u64 = 1024 * 1024;

/// The `name` stored inside a theme file on disk, if it parses.
fn stored_theme_name(path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("name")?.as_str().map(str::to_string)
}

/// Distinct names can share a sanitised file name ("a b", "a_b", "a/b" → a_b.json).
/// Importing must not silently replace another theme, and deleting by name must
/// only remove the file that actually holds that theme.
fn file_belongs_to(path: &std::path::Path, name: &str) -> bool {
    stored_theme_name(path).as_deref() == Some(name)
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect::<String>()
        .trim()
        .replace(' ', "_")
}

/// Required color keys every theme must provide.
const REQUIRED_KEYS: &[&str] = &[
    "bg-editor", "bg-sidebar", "bg-statusbar", "bg-tab", "bg-tab-active",
    "bg-hover", "bg-selected", "bg-input", "bg-palette",
    "text", "text-dim", "text-bright",
    "border", "accent", "tab-indicator",
    "syn-kw", "syn-fn", "syn-str", "syn-ty", "syn-num", "syn-cm", "syn-mac", "syn-attr",
    "ansi-red", "ansi-yellow",
];

#[tauri::command]
pub async fn list_custom_themes() -> Result<Vec<CustomTheme>, String> {
    let dir = match themes_dir() {
        Some(d) => d,
        None => return Ok(vec![]),
    };
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut themes = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let json: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let name = match json.get("name").and_then(|n| n.as_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let colors = match json.get("colors") {
            Some(c) => c.clone(),
            None => continue,
        };
        themes.push(CustomTheme { name, colors });
    }
    Ok(themes)
}

#[tauri::command]
pub async fn import_theme(file_path: String) -> Result<CustomTheme, String> {
    let size = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_THEME_BYTES {
        return Err(format!("Theme file is too large ({} bytes)", size));
    }
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let name = json
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("Theme must have a \"name\" field")?
        .to_string();

    if name.trim().is_empty() {
        return Err("Theme name cannot be empty".to_string());
    }

    let colors = json
        .get("colors")
        .ok_or("Theme must have a \"colors\" field")?
        .clone();

    // Validate required color keys
    let missing: Vec<&str> = REQUIRED_KEYS
        .iter()
        .filter(|&&k| colors.get(k).is_none())
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!("Theme is missing required color keys: {}", missing.join(", ")));
    }

    let dir = themes_dir().ok_or("Could not determine config directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let filename = sanitize_filename(&name);
    let dest = dir.join(format!("{}.json", filename));
    if dest.exists() && !file_belongs_to(&dest, &name) {
        return Err(format!(
            "A different theme ({}) is already stored under the file name {}.json; rename one of them",
            stored_theme_name(&dest).unwrap_or_else(|| "unknown".into()),
            filename
        ));
    }
    let tmp = dest.with_extension("json.tmp");

    std::fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;

    Ok(CustomTheme { name, colors })
}

#[tauri::command]
pub async fn delete_custom_theme(name: String) -> Result<(), String> {
    let dir = themes_dir().ok_or("Could not determine config directory")?;
    let filename = sanitize_filename(&name);
    let path = dir.join(format!("{}.json", filename));
    if path.exists() && file_belongs_to(&path, &name) {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_names_can_collide_on_disk_and_are_told_apart_by_stored_name() {
        assert_eq!(sanitize_filename("a b"), sanitize_filename("a_b"));
        assert_eq!(sanitize_filename("a/b"), "a_b");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a_b.json");
        std::fs::write(&path, r#"{"name":"a b","colors":{}}"#).unwrap();
        assert!(file_belongs_to(&path, "a b"));
        assert!(!file_belongs_to(&path, "a_b"), "a different theme must not claim this file");
        assert!(!file_belongs_to(&dir.path().join("missing.json"), "a b"));
    }
}
