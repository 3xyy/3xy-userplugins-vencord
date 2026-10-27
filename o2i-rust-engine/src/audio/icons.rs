//! Best-effort Windows app-icon extraction for the routed-apps picker.
//!
//! Two stages: resolve a pid to its executable path, then load that exe's small
//! shell icon and convert it to RGBA8 bytes egui can upload as a texture.
//!
//! Everything here is best-effort: any failure (access-denied on an elevated
//! process, an exe with no icon, a GDI error) returns `None` so the UI just
//! shows the app name with no icon. Nothing here panics or blocks for long;
//! callers cache the result so it runs at most once per app name.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, MAX_PATH};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Resolve a process id to its full executable path, or `None` if the process
/// can't be opened (e.g. access denied for an elevated/system process) or has
/// already exited.
pub fn exe_path_for_pid(pid: u32) -> Option<String> {
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; MAX_PATH as usize];
        let mut size = buf.len() as u32;
        let res = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        res.ok()?;
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    }
}

/// Load the small shell icon for `path` and return `(width, height, rgba8)`.
///
/// Pipeline: `SHGetFileInfoW(SHGFI_ICON | SHGFI_SMALLICON)` → `HICON` →
/// `GetIconInfo` color `HBITMAP` → `GetDIBits` into a top-down 32-bit BGRA
/// buffer → swap B/R to produce RGBA. If the icon's alpha channel is entirely
/// zero (common for some 32-bit icons), the whole image is treated as opaque.
/// Returns `None` on any failure; never panics. All GDI/icon handles created
/// here are destroyed before returning.
pub fn icon_rgba_for_exe(path: &str) -> Option<(u32, u32, Vec<u8>)> {
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    unsafe {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut shfi = SHFILEINFOW::default();
        let res = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_SMALLICON,
        );
        if res == 0 || shfi.hIcon.is_invalid() {
            return None;
        }
        let hicon = shfi.hIcon;

        // Do the conversion in a closure so we can always DestroyIcon afterwards.
        let result = (|| {
            let mut icon_info = ICONINFO::default();
            GetIconInfo(hicon, &mut icon_info).ok()?;
            let hbm_color = icon_info.hbmColor;
            let hbm_mask = icon_info.hbmMask;

            let cleanup_bitmaps = || {
                if !hbm_color.is_invalid() {
                    let _ = DeleteObject(hbm_color);
                }
                if !hbm_mask.is_invalid() {
                    let _ = DeleteObject(hbm_mask);
                }
            };

            if hbm_color.is_invalid() {
                cleanup_bitmaps();
                return None;
            }

            let mut bmp = BITMAP::default();
            let got = GetObjectW(
                hbm_color,
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bmp as *mut _ as *mut _),
            );
            if got == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
                cleanup_bitmaps();
                return None;
            }
            let width = bmp.bmWidth;
            let height = bmp.bmHeight;

            let mut bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // negative => top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let npx = (width * height) as usize;
            let mut buf = vec![0u8; npx * 4];

            let hdc = GetDC(None);
            let scan = GetDIBits(
                hdc,
                hbm_color,
                0,
                height as u32,
                Some(buf.as_mut_ptr() as *mut _),
                &mut bi,
                DIB_RGB_COLORS,
            );
            ReleaseDC(None, hdc);
            cleanup_bitmaps();

            if scan == 0 {
                return None;
            }

            // GetDIBits gives BGRA. Detect a fully-zero alpha channel (treat as
            // opaque), then swap B/R to RGBA.
            let any_alpha = buf.chunks_exact(4).any(|px| px[3] != 0);
            for px in buf.chunks_exact_mut(4) {
                px.swap(0, 2);
                if !any_alpha {
                    px[3] = 255;
                }
            }

            Some((width as u32, height as u32, buf))
        })();

        let _ = DestroyIcon(hicon);
        result
    }
}
