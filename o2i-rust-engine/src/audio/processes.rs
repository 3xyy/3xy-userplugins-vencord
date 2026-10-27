use anyhow::{Context, Result};
use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

/// Lowercase exe-name substrings that are always excluded from the app picker.
/// Covers system services, shells, and OS overlays that the user never wants to route.
pub const BLOCKLIST: &[&str] = &[
    "svchost",
    "cmd.exe",
    "explorer.exe",
    "vantage",
    "lenovovantage",
    "nvidia overlay",
    "nvidiaoverlay",
    "nvcontainer",
    "powershell",
    "textinputhost",
    "windowsterminal",
];

/// Returns `true` if `name` (case-insensitive) matches any substring in `BLOCKLIST`.
pub fn is_blocked(name: &str) -> bool {
    let lower = name.to_lowercase();
    BLOCKLIST.iter().any(|&sub| lower.contains(sub))
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProcInfo {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
}

pub fn list_processes() -> Result<Vec<ProcInfo>> {
    unsafe {
        let snap =
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).context("CreateToolhelp32Snapshot")?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut out = Vec::new();
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(MAX_PATH as usize);
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                out.push(ProcInfo {
                    pid: entry.th32ProcessID,
                    parent_pid: entry.th32ParentProcessID,
                    name,
                });
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        Ok(out)
    }
}

/// Among processes whose name contains `substr` (case-insensitive), return the
/// pid of the tree root (the match whose parent is NOT also a match), so we
/// target the parent rather than a child "Audio Service" process.
pub fn pick_tree_root(procs: &[ProcInfo], substr: &str) -> Option<u32> {
    let needle = substr.to_lowercase();
    let matches: Vec<&ProcInfo> = procs
        .iter()
        .filter(|p| p.name.to_lowercase().contains(&needle))
        .collect();
    let match_pids: std::collections::HashSet<u32> = matches.iter().map(|p| p.pid).collect();
    matches
        .iter()
        .find(|p| !match_pids.contains(&p.parent_pid))
        .or_else(|| matches.first())
        .map(|p| p.pid)
}

/// Returns the set of PIDs that own at least one visible top-level window.
/// Used to filter the app picker to real user-facing apps, excluding
/// background/system processes (e.g. RuntimeBroker.exe, TextInputHost.exe).
pub fn pids_with_visible_windows() -> std::collections::HashSet<u32> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // Safety: lparam is a valid *mut HashSet<u32> that lives for the duration of EnumWindows.
        if IsWindowVisible(hwnd).as_bool() {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 {
                let set = &mut *(lparam.0 as *mut std::collections::HashSet<u32>);
                set.insert(pid);
            }
        }
        TRUE
    }

    let mut pids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    // Errors are ignored: an empty set means the picker just shows all processes.
    let _ = unsafe { EnumWindows(Some(enum_cb), LPARAM(&mut pids as *mut _ as isize)) };
    pids
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, name: &str) -> ProcInfo {
        ProcInfo {
            pid,
            parent_pid: parent,
            name: name.into(),
        }
    }

    #[test]
    fn picks_parent_over_child() {
        // chrome.exe 100 (parent 1) spawns chrome.exe 101 (audio service, parent 100).
        let procs = vec![
            p(1, 0, "explorer.exe"),
            p(100, 1, "chrome.exe"),
            p(101, 100, "chrome.exe"),
        ];
        assert_eq!(pick_tree_root(&procs, "chrome"), Some(100));
    }

    #[test]
    fn none_when_no_match() {
        let procs = vec![p(1, 0, "explorer.exe")];
        assert_eq!(pick_tree_root(&procs, "spotify"), None);
    }

    #[test]
    fn case_insensitive_single_match() {
        let procs = vec![p(42, 1, "Spotify.exe")];
        assert_eq!(pick_tree_root(&procs, "spotify"), Some(42));
    }

    #[test]
    fn blocklist_matches_substrings_case_insensitively() {
        assert!(is_blocked("svchost.exe"));
        assert!(is_blocked("SVCHOST.exe"));
        assert!(is_blocked("PowerShell.exe"));
        assert!(is_blocked("NvContainer.exe"));
        assert!(!is_blocked("spotify.exe"));
        assert!(!is_blocked("chrome.exe"));
        assert!(!is_blocked("discord.exe"));
    }
}
