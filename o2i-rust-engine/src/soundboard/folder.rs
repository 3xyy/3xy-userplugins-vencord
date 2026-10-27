use std::path::{Path, PathBuf};

const AUDIO_EXTS: &[&str] = &["mp3", "wav", "flac", "ogg", "m4a", "aac"];

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn list_audio_files(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_file() && is_audio_file(p))
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort_by_key(|p| {
        p.file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn detects_audio_extensions() {
        assert!(is_audio_file(Path::new("a/b/horn.MP3")));
        assert!(is_audio_file(Path::new("clip.wav")));
        assert!(!is_audio_file(Path::new("notes.txt")));
        assert!(!is_audio_file(Path::new("noext")));
    }

    #[test]
    fn missing_dir_is_empty() {
        assert!(list_audio_files(Path::new("Z:/definitely/not/here")).is_empty());
    }
}
