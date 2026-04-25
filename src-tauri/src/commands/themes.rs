use std::path::PathBuf;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CustomTheme {
    pub name: String,
    pub colors: serde_json::Value,
}

fn themes_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("Splice").join("themes"))
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
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
