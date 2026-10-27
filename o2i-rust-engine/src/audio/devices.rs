use anyhow::{Context, Result};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    EDataFlow, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Variant::VT_LPWSTR;

#[derive(Clone, Debug)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
}

/// Call once per thread before using WASAPI on that thread.
/// Tolerates RPC_E_CHANGED_MODE / S_FALSE (already initialized): both count as success.
pub fn init_com() -> Result<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    Ok(())
}

fn list(flow: EDataFlow) -> Result<Vec<DeviceInfo>> {
    init_com()?;
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .context("create MMDeviceEnumerator")?;

        let collection = enumerator
            .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
            .context("EnumAudioEndpoints")?;

        let count = collection.GetCount().context("GetCount")?;
        let mut out = Vec::with_capacity(count as usize);

        for i in 0..count {
            let device = collection.Item(i).context("Item")?;

            // Device endpoint ID string. GetId returns a CoTaskMem-allocated PWSTR
            // that the caller must free with CoTaskMemFree.
            let id_pwstr = device.GetId().context("GetId")?;
            let id = id_pwstr.to_string().context("id PWSTR to_string")?;
            // Free the CoTaskMem buffer now that we have an owned String.
            CoTaskMemFree(Some(id_pwstr.as_ptr() as *const _));

            // Friendly name from property store
            let store = device
                .OpenPropertyStore(STGM_READ)
                .context("OpenPropertyStore")?;

            let mut prop = store
                .GetValue(&PKEY_Device_FriendlyName)
                .context("GetValue FriendlyName")?;

            // windows_core::PROPVARIANT wraps imp::PROPVARIANT (repr transparent).
            // For VT_LPWSTR the wide string pointer sits at:
            //   .as_raw().Anonymous.Anonymous.Anonymous.pwszVal
            let name = prop_to_string(&prop).unwrap_or_else(|| "<unknown>".into());

            // Explicitly release the CoTaskMem-allocated PWSTR inside the PROPVARIANT.
            // PropVariantClear frees the string buffer and resets vt to VT_EMPTY.
            // We then forget `prop` to prevent its Drop impl from calling PropVariantClear
            // a second time on the now-empty (zeroed) variant.
            PropVariantClear(&mut prop).ok();
            std::mem::forget(prop);

            out.push(DeviceInfo { id, name });
        }

        Ok(out)
    }
}

/// Extract a String from a `windows_core::PROPVARIANT` holding VT_LPWSTR.
///
/// # Safety
/// Must be called while `prop` is still live and the PWSTR it contains
/// points to valid memory (guaranteed here: called immediately after
/// `GetValue`, before the variant is cleared).
unsafe fn prop_to_string(prop: &windows::core::PROPVARIANT) -> Option<String> {
    // Access the inner imp::PROPVARIANT via as_raw() and walk the anonymous
    // union chain to reach the PWSTR field for VT_LPWSTR variants.
    let raw = prop.as_raw();
    // Verify the variant type is VT_LPWSTR before reading the pwszVal field.
    // raw.Anonymous.Anonymous.vt is imp::VARENUM = u16; VT_LPWSTR.0 extracts its u16 value.
    if raw.Anonymous.Anonymous.vt != VT_LPWSTR.0 {
        return None;
    }
    // pwszVal is imp::PWSTR = *mut u16; wrap in the safe windows::core::PWSTR newtype.
    let raw_ptr: *mut u16 = raw.Anonymous.Anonymous.Anonymous.pwszVal;
    if raw_ptr.is_null() {
        return None;
    }
    windows::core::PWSTR::from_raw(raw_ptr).to_string().ok()
}

pub fn list_capture_devices() -> Result<Vec<DeviceInfo>> {
    list(windows::Win32::Media::Audio::eCapture)
}

pub fn list_render_devices() -> Result<Vec<DeviceInfo>> {
    list(windows::Win32::Media::Audio::eRender)
}

/// Endpoint id of the system default render device (eRender / eConsole).
/// Used as the soundboard monitor output when the user hasn't picked one.
pub fn default_render_id() -> Result<String> {
    init_com()?;
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .context("create MMDeviceEnumerator")?;
        let device = enumerator
            .GetDefaultAudioEndpoint(
                windows::Win32::Media::Audio::eRender,
                windows::Win32::Media::Audio::eConsole,
            )
            .context("GetDefaultAudioEndpoint(render)")?;
        let id_pwstr = device.GetId().context("GetId")?;
        // GetId returns a CoTaskMem-allocated PWSTR the caller must free. Capture
        // the conversion result first, free unconditionally, then propagate, so
        // the buffer is never leaked on the to_string() error path.
        let id_result = id_pwstr.to_string().context("id PWSTR to_string");
        CoTaskMemFree(Some(id_pwstr.as_ptr() as *const _));
        let id = id_result?;
        Ok(id)
    }
}

pub fn find_render_by_name(substr: &str) -> Result<Option<DeviceInfo>> {
    let needle = substr.to_lowercase();
    Ok(list_render_devices()?
        .into_iter()
        .find(|d| d.name.to_lowercase().contains(&needle)))
}

// Capture-side twin of find_render_by_name; used to match the saved input device by name.
#[allow(dead_code)]
pub fn find_capture_by_name(substr: &str) -> Result<Option<DeviceInfo>> {
    let needle = substr.to_lowercase();
    Ok(list_capture_devices()?
        .into_iter()
        .find(|d| d.name.to_lowercase().contains(&needle)))
}
