//! App listing for the headless picker: the window's picker rules plus PNG icons.

use std::collections::{BTreeMap, HashSet};

use base64::Engine as _;

use crate::audio::processes::{self, ProcInfo};
use crate::audio::{devices, icons, sessions};
use crate::headless::protocol::AppJson;

/// Routable apps, the same set the window's picker shows: windowed processes,
/// not blocklisted, one entry per name, apps playing audio first (then by name).
/// Runs on a spawned MTA thread (audio-session enumeration and shell icon
/// lookup are COM). Icons are PNG data URLs, `None` when extraction fails.
pub fn list_apps() -> Vec<AppJson> {
    std::thread::spawn(|| {
        devices::init_com().ok();
        let procs = processes::list_processes().unwrap_or_default();
        let windowed = processes::pids_with_visible_windows();
        let playing = sessions::pids_playing_audio();
        pick_apps(&procs, &windowed, &playing)
            .into_iter()
            .map(|(name, pid, playing)| {
                let icon = icons::exe_path_for_pid(pid)
                    .and_then(|path| icons::icon_rgba_for_exe(&path))
                    .and_then(|(w, h, rgba)| png_data_url(w, h, &rgba));
                AppJson {
                    name,
                    pid,
                    playing,
                    icon,
                }
            })
            .collect()
    })
    .join()
    .unwrap_or_default()
}

/// The picker rules as a pure function: `(name, pid, playing)` per app name.
/// `pid` is the process-tree root (what attaching would target); an app counts
/// as playing if any of its processes has an active audio session.
fn pick_apps(
    procs: &[ProcInfo],
    windowed: &HashSet<u32>,
    playing: &HashSet<u32>,
) -> Vec<(String, u32, bool)> {
    // Names with at least one playing process (windowless audio children count).
    let playing_names: HashSet<&str> = procs
        .iter()
        .filter(|q| playing.contains(&q.pid))
        .map(|q| q.name.as_str())
        .collect();
    // name -> (first windowed pid, playing)
    let mut by_name: BTreeMap<String, (u32, bool)> = BTreeMap::new();
    for p in procs {
        if windowed.contains(&p.pid) && !processes::is_blocked(&p.name) {
            by_name
                .entry(p.name.clone())
                .or_insert((p.pid, playing_names.contains(p.name.as_str())));
        }
    }
    let mut out: Vec<(String, u32, bool)> = by_name
        .into_iter()
        .map(|(name, (windowed_pid, is_playing))| {
            let pid = processes::pick_tree_root(procs, &name).unwrap_or(windowed_pid);
            (name, pid, is_playing)
        })
        .collect();
    out.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });
    out
}

/// Encode straight RGBA8 pixels as a `data:image/png;base64,…` URL.
/// `None` if the buffer doesn't match `width * height * 4` or encoding fails.
fn png_data_url(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    let expected = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if expected == 0 || rgba.len() != expected {
        return None;
    }
    let mut bytes = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut bytes, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
        writer.finish().ok()?;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::processes::ProcInfo;
    use std::collections::HashSet;

    fn p(pid: u32, parent: u32, name: &str) -> ProcInfo {
        ProcInfo {
            pid,
            parent_pid: parent,
            name: name.into(),
        }
    }

    #[test]
    fn picker_rules_filter_dedup_and_sort() {
        let procs = vec![
            p(1, 0, "explorer.exe"),
            p(10, 1, "zoom.exe"),
            p(20, 1, "chrome.exe"),
            p(21, 20, "chrome.exe"),
            p(30, 1, "Spotify.exe"),
            p(40, 1, "background.exe"),
        ];
        // explorer is windowed but blocklisted; background has no window.
        let windowed: HashSet<u32> = [1, 10, 20, 30].into();
        // chrome plays via its windowless child pid 21 (the window is the root, 20).
        let playing: HashSet<u32> = [21].into();
        let got = pick_apps(&procs, &windowed, &playing);
        assert_eq!(
            got,
            vec![
                ("chrome.exe".to_string(), 20, true),
                ("Spotify.exe".to_string(), 30, false),
                ("zoom.exe".to_string(), 10, false),
            ]
        );
    }

    #[test]
    fn png_data_url_encodes_rgba() {
        let rgba = [255u8, 0, 0, 255, 0, 255, 0, 128];
        let url = png_data_url(2, 1, &rgba).expect("encodes");
        let b64 = url
            .strip_prefix("data:image/png;base64,")
            .expect("data-url prefix");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        // IHDR: width/height big-endian at bytes 16..24, bit depth 8, color type 6 (RGBA).
        assert_eq!(&bytes[16..20], &2u32.to_be_bytes());
        assert_eq!(&bytes[20..24], &1u32.to_be_bytes());
        assert_eq!(bytes[24], 8);
        assert_eq!(bytes[25], 6);
    }

    #[test]
    fn png_data_url_rejects_bad_buffer() {
        assert!(png_data_url(2, 2, &[0u8; 4]).is_none());
        assert!(png_data_url(0, 0, &[]).is_none());
    }
}
