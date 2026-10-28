use eframe::egui;

// First: its `elog!` macro is in scope for every module declared after it.
#[macro_use]
mod elog;
mod audio;
mod config;
mod control;
mod dsp;
mod engine;
mod headless;
mod hotkey_thread;
mod hotkeys;
mod instance;
mod llhooks;
mod soundboard;
mod tts;

use audio::devices::DeviceInfo;
use control::{apply_profile_dsp, attach_routed_apps, enumerate_devices};
use instance::InstanceLock;
use engine::Engine;
use hotkeys::Hotkeys;
use soundboard::folder::list_audio_files;
use soundboard::ClipGains;

// ---------------------------------------------------------------------------
// MTA enumeration helper
//
// eframe/winit may initialize the UI thread as STA, which can break WASAPI
// COM calls made directly from the UI thread. We therefore run all WASAPI
// device enumeration on a dedicated short-lived thread that calls init_com()
// (MTA) before touching any device APIs.
// ---------------------------------------------------------------------------

fn playing_pids() -> std::collections::HashSet<u32> {
    std::thread::spawn(audio::sessions::pids_playing_audio)
        .join()
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

struct App {
    engine: Engine,
    params: std::sync::Arc<dsp::MicParams>,
    inputs: Vec<DeviceInfo>,
    outputs: Vec<DeviceInfo>,
    selected_input: Option<String>,
    selected_output: Option<String>,
    status: String,
    /// Held while this window's engine is running; guarantees one audio owner.
    audio_lock: Option<InstanceLock>,
    cable_present: bool,
    procs: Vec<audio::processes::ProcInfo>,
    windowed_pids: std::collections::HashSet<u32>,
    playing_pids: std::collections::HashSet<u32>,
    selected_app: Option<String>,
    app_search: String,
    /// Snapshot of routed apps (name + volume) kept up-to-date while running and
    /// retained after Stop so `on_exit`/`current_config` always persists them.
    routed_snapshot: Vec<config::RoutedApp>,
    /// Lazily-loaded app icons keyed by app NAME. `None` caches a failed lookup
    /// so we don't retry (and re-do the slow shell call) every frame.
    icons: std::collections::HashMap<String, Option<egui::TextureHandle>>,

    // ----- Soundboard UI state -----
    /// Text field buffer for folder path (editable by the user).
    sb_folder_text: String,
    /// The committed soundboard folder (set when user clicks "Set").
    sb_folder: Option<std::path::PathBuf>,
    /// Audio files found in `sb_folder`, sorted alphabetically.
    sb_files: Vec<std::path::PathBuf>,
    /// Per-clip hotkey assignments: path → (accel-string, hotkey-id).
    clip_hotkeys: std::collections::HashMap<std::path::PathBuf, (String, u32)>,
    /// Stop-all hotkey, if set: (accel-string, hotkey-id).
    stop_all_hotkey: Option<(String, u32)>,
    /// Hotkey-capture mode:
    ///   `None`  = not capturing.
    ///   `Some(p)` where `p` is non-empty = waiting for a key for clip `p`.
    ///   `Some(empty PathBuf)` = waiting for the stop-all key.
    binding: Option<std::path::PathBuf>,
    /// Global hotkey manager (None if initialization failed).
    hotkeys: Option<Hotkeys>,
    /// Monitor render device id shown in the UI; drives `engine.set_monitor_device`.
    sb_monitor_device: Option<String>,
    /// Per-clip mixing settings keyed by file name. Defaults applied on first use.
    clip_settings: std::collections::HashMap<String, ClipSettings>,
    /// Live filter for the clip grid (case-insensitive substring of file name).
    sb_search: String,
    /// Clip whose settings editor is currently expanded (None = none shown).
    sb_selected_clip: Option<String>,
    /// Global soundboard settings used when `sb_global_override` is true.
    sb_global: ClipSettings,
    /// When true, `sb_global` supersedes each clip's own settings at play time.
    sb_global_override: bool,
    /// Apps muted via the routed-app list: id → volume captured before muting.
    /// Transient (not persisted).
    muted_apps: std::collections::HashMap<u64, f32>,
    /// Exponentially-smoothed level-meter position (0..1) to stop idle flicker.
    meter_smooth: f32,
}

/// Per-clip soundboard mixing settings (others/self gains + local monitoring).
#[derive(Clone)]
struct ClipSettings {
    vol_others: f32,
    vol_self: f32,
    hear_local: bool,
}

impl Default for ClipSettings {
    fn default() -> Self {
        Self {
            vol_others: 1.0,
            vol_self: 1.0,
            hear_local: false,
        }
    }
}

impl Default for App {
    fn default() -> Self {
        // Enumerate on a dedicated MTA thread. Do NOT call WASAPI directly here
        let devs = enumerate_devices();

        // Check CABLE Input presence (result already available from enumeration)
        let cable_present = devs
            .outputs
            .iter()
            .any(|d| d.name.to_lowercase().contains("cable input"));
        let default_input = devs.inputs.first().map(|d| d.id.clone());
        // Prefer CABLE Input; fall back to first render device
        let default_output = devs
            .cable
            .as_ref()
            .map(|d| d.id.clone())
            .or_else(|| devs.outputs.first().map(|d| d.id.clone()));

        // Load persisted config and prefer the last profile's device ids when present,
        // falling back to the auto-detected defaults. Config I/O is plain disk, no COM.
        let cfg = config::load();
        let (selected_input, selected_output) = cfg
            .profiles
            .iter()
            .find(|p| p.name == cfg.last_profile)
            .map(|p| {
                (
                    p.input_id.clone().or(default_input.clone()),
                    p.output_id.clone().or(default_output.clone()),
                )
            })
            .unwrap_or((default_input, default_output));

        let mut engine = Engine::new();
        let params = engine.params();

        // Load saved DSP params + duck + master from the last profile.
        // Option<f32> fields are None in older configs (absent key) and
        // Some(x) when the user explicitly saved a value, 0.0 included.
        if let Some(p) = cfg.profiles.iter().find(|p| p.name == cfg.last_profile) {
            apply_window_profile_dsp(&params, p);
            engine.duck_params().set_enabled(p.duck_enabled);
            if let Some(t) = p.duck_target {
                engine.duck_params().set_target(t);
            }
            if let Some(m) = p.master_volume {
                audio::mixer::store_f32(&engine.master(), m);
            }
        }

        // Restore per-clip soundboard settings (others/self gains + hear-local).
        let clip_settings: std::collections::HashMap<String, ClipSettings> = cfg
            .profiles
            .iter()
            .find(|p| p.name == cfg.last_profile)
            .map(|p| {
                p.sb_clip_settings
                    .iter()
                    .map(|s| {
                        (
                            s.name.clone(),
                            ClipSettings {
                                vol_others: s.vol_others,
                                vol_self: s.vol_self,
                                hear_local: s.hear_local,
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();

        // Restore global soundboard settings + override flag.
        let (sb_global, sb_global_override) = cfg
            .profiles
            .iter()
            .find(|p| p.name == cfg.last_profile)
            .map(|p| {
                (
                    ClipSettings {
                        vol_others: p.sb_global_others.unwrap_or(1.0),
                        vol_self: p.sb_global_self.unwrap_or(1.0),
                        hear_local: p.sb_global_hear_local,
                    },
                    p.sb_global_override,
                )
            })
            .unwrap_or_else(|| (ClipSettings::default(), false));

        // Extract soundboard fields needed for restore (clone out of cfg before it's moved).
        let (sb_folder_str_init, sb_clip_hotkeys_saved, sb_stop_all_saved, sb_monitor_device_saved) =
            cfg.profiles
                .iter()
                .find(|p| p.name == cfg.last_profile)
                .map(|p| {
                    (
                        p.sb_folder.clone(),
                        p.sb_clip_hotkeys.clone(),
                        p.sb_stop_all_hotkey.clone(),
                        p.sb_monitor_device.clone(),
                    )
                })
                .unwrap_or_else(|| (None, Vec::new(), None, None));

        let sb_folder: Option<std::path::PathBuf> =
            sb_folder_str_init.as_deref().map(std::path::PathBuf::from);
        let sb_folder_text = sb_folder_str_init.unwrap_or_default();
        let sb_files = sb_folder
            .as_ref()
            .map_or_else(Vec::new, |f| list_audio_files(f));

        // Apply the saved monitor device so the engine is ready for the next Start.
        engine.set_monitor_device(sb_monitor_device_saved.clone());
        let sb_monitor_device = sb_monitor_device_saved;

        // Snapshot of routed apps from the saved profile, so apps survive
        // Stop-then-close even if Start was never clicked this session.
        let routed_snapshot = cfg
            .profiles
            .iter()
            .find(|p| p.name == cfg.last_profile)
            .map(|p| p.routed_apps.clone())
            .unwrap_or_default();

        let mut procs = audio::processes::list_processes().unwrap_or_default();
        procs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        let windowed_pids = audio::processes::pids_with_visible_windows();
        let playing_pids = playing_pids();

        // Hotkey manager. Must be constructed on the UI/event-loop thread.
        let mut hotkeys = Hotkeys::new()
            .map_err(|e| elog!("[hotkeys] init failed: {e:#}"))
            .ok();

        // Re-register saved clip hotkeys for files that still exist in the folder.
        let mut clip_hotkeys: std::collections::HashMap<std::path::PathBuf, (String, u32)> =
            std::collections::HashMap::new();
        let mut stop_all_hotkey: Option<(String, u32)> = None;
        if let Some(ref mut hk) = hotkeys {
            if let Some(ref folder) = sb_folder {
                for (file_name, accel) in &sb_clip_hotkeys_saved {
                    let path = folder.join(file_name);
                    if path.exists() {
                        match hk.register(accel) {
                            Ok(id) => {
                                clip_hotkeys.insert(path, (accel.clone(), id));
                            }
                            Err(e) => {
                                elog!("[sb restore] clip hotkey '{accel}' failed: {e:#}");
                            }
                        }
                    }
                }
            }
            if let Some(ref accel) = sb_stop_all_saved {
                match hk.register(accel) {
                    Ok(id) => {
                        stop_all_hotkey = Some((accel.clone(), id));
                    }
                    Err(e) => {
                        elog!("[sb restore] stop-all hotkey '{accel}' failed: {e:#}");
                    }
                }
            }
        }

        Self {
            engine,
            params,
            selected_input,
            selected_output,
            inputs: devs.inputs,
            outputs: devs.outputs,
            status: "Idle".into(),
            audio_lock: None,
            cable_present,
            procs,
            windowed_pids,
            playing_pids,
            selected_app: None,
            app_search: String::new(),
            routed_snapshot,
            icons: std::collections::HashMap::new(),
            // Soundboard, restored from the saved profile above.
            sb_folder_text,
            sb_folder,
            sb_files,
            clip_hotkeys,
            stop_all_hotkey,
            binding: None,
            hotkeys,
            sb_monitor_device,
            clip_settings,
            sb_search: String::new(),
            sb_selected_clip: None,
            sb_global,
            sb_global_override,
            muted_apps: std::collections::HashMap::new(),
            meter_smooth: 0.0,
        }
    }
}

impl App {
    fn name_of(list: &[DeviceInfo], id: &Option<String>) -> String {
        match id {
            Some(id) => list
                .iter()
                .find(|d| &d.id == id)
                .map(|d| d.name.clone())
                .unwrap_or_else(|| "<none>".into()),
            None => "<none>".into(),
        }
    }

    /// Discord-style level meter: a live input-level bar (dBFS scale) with the
    /// noise-gate threshold drawn as a draggable vertical line over it.
    fn draw_gate_meter(&mut self, ui: &mut egui::Ui) {
        let raw = self.params.input_level();
        let gate_on = self.params.gate_enabled();

        let (rect, response) =
            ui.allocate_exact_size(egui::vec2(260.0, 26.0), egui::Sense::click_and_drag());

        // Drag/click on the bar sets the gate threshold to that horizontal position.
        if gate_on {
            if let Some(pos) = response.interact_pointer_pos() {
                if response.dragged() || response.clicked() {
                    let norm = ((pos.x - rect.left()) / rect.width()).clamp(0.0, 1.0);
                    self.params.set_gate_threshold(meter_to_rms(norm));
                }
            }
        }

        let threshold = self.params.gate_threshold();
        let painter = ui.painter_at(rect);
        painter.rect_filled(rect, 3.0, egui::Color32::from_gray(28));

        // Exponentially smooth the meter position so idle static reads as a
        // steady level instead of flickering frame-to-frame.
        self.meter_smooth += (rms_to_meter(raw) - self.meter_smooth) * 0.2;
        let level_norm = self.meter_smooth;
        // Compare the gate against the smoothed level (converted back to RMS) so
        // the open/closed color matches the displayed bar.
        let smoothed_rms = meter_to_rms(level_norm);
        // Live level fill, green when the gate is open, grey when muted.
        let open = !gate_on || smoothed_rms >= threshold;
        let fill_color = if gate_on {
            if open {
                egui::Color32::from_rgb(80, 200, 120)
            } else {
                egui::Color32::from_gray(95)
            }
        } else {
            egui::Color32::from_rgb(100, 150, 220)
        };
        let fill_rect = egui::Rect::from_min_size(
            rect.min,
            egui::vec2(rect.width() * level_norm, rect.height()),
        );
        painter.rect_filled(fill_rect, 3.0, fill_color);

        // Gate threshold handle.
        if gate_on {
            let x = rect.left() + rect.width() * rms_to_meter(threshold);
            painter.line_segment(
                [egui::pos2(x, rect.top()), egui::pos2(x, rect.bottom())],
                egui::Stroke::new(2.0, egui::Color32::WHITE),
            );
        }

        painter.text(
            rect.center(),
            egui::Align2::CENTER_CENTER,
            format!("{:.0} dBFS", rms_to_dbfs(smoothed_rms)),
            egui::FontId::proportional(12.0),
            egui::Color32::from_gray(235),
        );

        if gate_on {
            ui.label(
                egui::RichText::new(
                    "Drag the white line. Your mic opens when your voice goes past it.",
                )
                .small()
                .weak(),
            );
        }
    }

    /// Return the cached texture id for an app's icon, lazily loading it on first
    /// request. A failed lookup is cached as "no icon" so we never retry it.
    /// Best-effort: returns `None` (render no icon) on any failure.
    fn icon_for(&mut self, name: &str, ctx: &egui::Context) -> Option<egui::TextureId> {
        if !self.icons.contains_key(name) {
            let tex = audio::processes::pick_tree_root(&self.procs, name)
                .and_then(audio::icons::exe_path_for_pid)
                .and_then(|p| audio::icons::icon_rgba_for_exe(&p))
                .map(|(w, h, rgba)| {
                    let img =
                        egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
                    ctx.load_texture(name, img, Default::default())
                });
            self.icons.insert(name.to_string(), tex);
        }
        self.icons
            .get(name)
            .and_then(|o| o.as_ref())
            .map(|t| t.id())
    }

    /// Build a `Config` snapshot of the current UI + engine state for persistence.
    fn current_config(&self) -> config::Config {
        let routed_apps = self.routed_snapshot.clone();

        // Persist per-clip mixing settings (file name + others/self gains + hear-local).
        let sb_clip_settings: Vec<config::SbClipSetting> = self
            .clip_settings
            .iter()
            .map(|(name, s)| config::SbClipSetting {
                name: name.clone(),
                vol_others: s.vol_others,
                vol_self: s.vol_self,
                hear_local: s.hear_local,
            })
            .collect();

        // Collect per-clip hotkeys as (file_name, accel): file names only, no paths.
        let sb_clip_hotkeys: Vec<(String, String)> = self
            .clip_hotkeys
            .iter()
            .filter_map(|(path, (accel, _))| {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .map(|name| (name.to_string(), accel.clone()))
            })
            .collect();

        config::Config {
            last_profile: "default".into(),
            profiles: vec![config::Profile {
                name: "default".into(),
                input_id: self.selected_input.clone(),
                output_id: self.selected_output.clone(),
                gate_enabled: self.params.gate_enabled(),
                gate_threshold: Some(self.params.gate_threshold()),
                suppress_enabled: self.params.suppress_enabled(),
                suppress_amount: Some(self.params.suppress_amount()),
                agc_enabled: self.params.agc_enabled(),
                agc_target: Some(self.params.agc_target()),
                mic_volume: Some(self.params.volume()),
                duck_enabled: self.engine.duck_params().enabled(),
                duck_target: Some(self.engine.duck_params().target()),
                routed_apps,
                master_volume: Some(audio::mixer::load_f32(&self.engine.master())),
                // Soundboard
                sb_folder: self
                    .sb_folder
                    .as_ref()
                    .and_then(|p| p.to_str())
                    .map(str::to_string),
                sb_clip_hotkeys,
                sb_stop_all_hotkey: self.stop_all_hotkey.as_ref().map(|(a, _)| a.clone()),
                sb_monitor_device: self.sb_monitor_device.clone(),
                sb_clip_settings,
                sb_global_others: Some(self.sb_global.vol_others),
                sb_global_self: Some(self.sb_global.vol_self),
                sb_global_hear_local: self.sb_global.hear_local,
                sb_global_override: self.sb_global_override,
                voice_preset: Some(self.params.voice_preset().as_str().to_string()),
                voice_intensity: Some(self.params.voice_intensity()),
                // Headless-only fields (sb_folders, monitor_mic, gate_auto, …) are
                // headless-only for now; the window uses `sb_folder`.
                ..Default::default()
            }],
        }
    }

    fn refresh_devices(&mut self) {
        let devs = enumerate_devices();
        self.cable_present = devs
            .outputs
            .iter()
            .any(|d| d.name.to_lowercase().contains("cable input"));
        let default_input = devs.inputs.first().map(|d| d.id.clone());
        let default_output = devs
            .cable
            .as_ref()
            .map(|d| d.id.clone())
            .or_else(|| devs.outputs.first().map(|d| d.id.clone()));
        self.inputs = devs.inputs;
        self.outputs = devs.outputs;
        // Keep existing selections if still valid, otherwise reset
        if self
            .selected_input
            .as_ref()
            .map_or(true, |sel| !self.inputs.iter().any(|d| &d.id == sel))
        {
            self.selected_input = default_input;
        }
        if self
            .selected_output
            .as_ref()
            .map_or(true, |sel| !self.outputs.iter().any(|d| &d.id == sel))
        {
            self.selected_output = default_output;
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // ----- Global hotkey polling (process-global, no &self needed) -----
        for id in Hotkeys::poll() {
            if self
                .stop_all_hotkey
                .as_ref()
                .map_or(false, |&(_, hid)| hid == id)
            {
                self.engine.stop_all_clips();
                continue;
            }
            let path_opt = self
                .clip_hotkeys
                .iter()
                .find(|(_, (_, hid))| *hid == id)
                .map(|(p, _)| p.clone());
            if let Some(path) = path_opt {
                let clip_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let s = if self.sb_global_override {
                    self.sb_global.clone()
                } else {
                    self.clip_settings
                        .get(&clip_name)
                        .cloned()
                        .unwrap_or_default()
                };
                // `path` is the full file path (folder + file name); the clip
                // is decoded while it plays. The window doesn't change gains
                // mid-play, so it doesn't keep the ClipGains.
                let gains = ClipGains::new(s.vol_others, s.vol_self, s.hear_local);
                self.engine
                    .play_clip(clip_name, path, std::sync::Arc::new(gains));
            }
        }

        // ----- Hotkey binding capture -----
        // If `binding` is Some, intercept the next key press (Escape = cancel).
        if self.binding.is_some() {
            let captured: Option<Option<(egui::Key, egui::Modifiers)>> = ctx.input(|i| {
                i.events.iter().find_map(|e| {
                    if let egui::Event::Key {
                        key,
                        pressed: true,
                        modifiers,
                        ..
                    } = e
                    {
                        if *key == egui::Key::Escape {
                            Some(None) // cancel
                        } else {
                            Some(Some((*key, *modifiers)))
                        }
                    } else {
                        None
                    }
                })
            });
            match captured {
                Some(None) => {
                    self.binding = None; // user pressed Escape
                }
                Some(Some((key, mods))) => {
                    if let Some(accel) = egui_key_to_accel(key, mods) {
                        let result = if let Some(hk) = self.hotkeys.as_mut() {
                            hk.register(&accel).ok().map(|id| (accel, id))
                        } else {
                            None
                        };
                        if let Some((accel, new_id)) = result {
                            let target = self.binding.take().unwrap();
                            if target == std::path::PathBuf::new() {
                                // Evict any clip that already owns new_id (4-way collision fix).
                                self.clip_hotkeys.retain(|_, (_, hid)| *hid != new_id);
                                // stop-all binding: unregister the old one if the id differs
                                let old_id = self
                                    .stop_all_hotkey
                                    .replace((accel, new_id))
                                    .map(|(_, i)| i);
                                if let (Some(old), Some(hk)) = (old_id, self.hotkeys.as_mut()) {
                                    if old != new_id {
                                        hk.unregister(old);
                                    }
                                }
                            } else {
                                // Evict any other clip that already owns new_id (4-way collision fix).
                                self.clip_hotkeys
                                    .retain(|p, (_, hid)| p == &target || *hid != new_id);
                                // Evict stop_all if it owns new_id.
                                if self
                                    .stop_all_hotkey
                                    .as_ref()
                                    .map_or(false, |&(_, hid)| hid == new_id)
                                {
                                    self.stop_all_hotkey = None;
                                }
                                // per-clip binding: unregister the old one if the id differs
                                let old_id = self
                                    .clip_hotkeys
                                    .insert(target, (accel, new_id))
                                    .map(|(_, i)| i);
                                if let (Some(old), Some(hk)) = (old_id, self.hotkeys.as_mut()) {
                                    if old != new_id {
                                        hk.unregister(old);
                                    }
                                }
                            }
                        } else {
                            // Key not mappable or no hotkey manager: keep waiting
                        }
                    }
                    // Key not in our mappable set: keep waiting so the user can try again
                }
                None => {} // still waiting, nothing pressed this frame
            }
        }

        // Keep the snapshot current while running so Stop-then-close persists the
        // latest set (including live volume edits and add/remove while running).
        if self.engine.is_running() {
            self.routed_snapshot = self
                .engine
                .app_channels()
                .iter()
                .map(|c| config::RoutedApp {
                    name: c.name.clone(),
                    volume: self
                        .muted_apps
                        .get(&c.id)
                        .copied()
                        .unwrap_or_else(|| audio::mixer::load_f32(&c.volume)),
                })
                .collect();
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.heading("o2i");
                ui.separator();

                // VB-CABLE missing banner
                if !self.cable_present {
                    ui.colored_label(
                        egui::Color32::YELLOW,
                        "VB-CABLE isn't installed. Get it from vb-audio.com/Cable",
                    );
                    ui.add_space(4.0);
                }

                ui.horizontal(|ui| {
                    if !self.engine.is_running() {
                        if ui.button("▶ Start routing").clicked() {
                            // Release any stale lock of our own, then take the global one.
                            self.audio_lock = None;
                            match (&self.selected_input, &self.selected_output) {
                                (Some(_), Some(_)) if {
                                    self.audio_lock = InstanceLock::acquire();
                                    self.audio_lock.is_none()
                                } => {
                                    self.status = "o2i is already running audio (probably inside Discord). Leave the call or close Discord first.".into();
                                }
                                (Some(i), Some(o)) => {
                                    match self.engine.start(i.clone(), o.clone()) {
                                        Ok(_) => {
                                            self.status = "Routing mic → output".into();

                                            // Re-attach previously routed apps from snapshot.
                                            let (_attached, skipped) = attach_routed_apps(
                                                &mut self.engine,
                                                &self.routed_snapshot,
                                            );
                                            if !skipped.is_empty() {
                                                self.status = format!(
                                                    "Routing mic → output | {}",
                                                    skipped.join("; ")
                                                );
                                            }

                                            // Persist all settings at Start time too.
                                            if let Err(e) = config::save(&self.current_config()) {
                                                self.status = format!("Save failed: {e:#}");
                                            }
                                        }
                                        Err(e) => {
                                            self.audio_lock = None;
                                            self.status = format!("Error: {e:#}");
                                        }
                                    }
                                }
                                _ => self.status = "Select input and output first".into(),
                            }
                        }
                    } else if ui.button("■ Stop").clicked() {
                        self.engine.stop();
                        self.audio_lock = None;
                        self.status = "Idle".into();
                    }

                    if ui.button("↺ Refresh devices").clicked() {
                        self.refresh_devices();
                    }
                });

                ui.add_space(8.0);
                ui.label(format!("Status: {}", &self.status));

                ui.add_space(8.0);

                // -----------------------------------------------------------
                // Devices
                // -----------------------------------------------------------
                egui::CollapsingHeader::new("Devices")
                    .default_open(true)
                    .show(ui, |ui| {
                        egui::ComboBox::from_label("Microphone (input)")
                            .selected_text(Self::name_of(&self.inputs, &self.selected_input))
                            .show_ui(ui, |ui| {
                                for d in &self.inputs {
                                    ui.selectable_value(
                                        &mut self.selected_input,
                                        Some(d.id.clone()),
                                        &d.name,
                                    );
                                }
                            });

                        egui::ComboBox::from_label("Virtual mic (output)")
                            .selected_text(Self::name_of(&self.outputs, &self.selected_output))
                            .show_ui(ui, |ui| {
                                for d in &self.outputs {
                                    ui.selectable_value(
                                        &mut self.selected_output,
                                        Some(d.id.clone()),
                                        &d.name,
                                    );
                                }
                            });

                        // Warn if the chosen output is a real playback device, not a
                        // virtual cable. Otherwise audio plays to that device and no
                        // app receives it as a mic (a footgun, e.g. selecting Headphones).
                        if let Some(id) = &self.selected_output {
                            if let Some(dev) = self.outputs.iter().find(|d| &d.id == id) {
                                if !output_is_cable(&dev.name) {
                                    ui.add_space(4.0);
                                    ui.colored_label(
                                        egui::Color32::from_rgb(255, 160, 0),
                                        format!(
                                            "⚠ Output \"{}\" isn't a VB-CABLE device, so other \
                                         apps won't hear it as a mic. Pick \"CABLE Input\".",
                                            dev.name
                                        ),
                                    );
                                }
                            }
                        }
                    });

                // -----------------------------------------------------------
                // Master output
                // -----------------------------------------------------------
                egui::CollapsingHeader::new("Master output")
                    .default_open(true)
                    .show(ui, |ui| {
                        let master = self.engine.master();
                        let mut m = audio::mixer::load_f32(&master) * 100.0;
                        if ui
                            .add(
                                egui::Slider::new(&mut m, 0.0..=200.0)
                                    .suffix(" %")
                                    .text("Master volume"),
                            )
                            .changed()
                        {
                            audio::mixer::store_f32(&master, m / 100.0);
                        }
                        ui.label(
                            egui::RichText::new(
                                "Overall level of everything sent to VB-CABLE (mic + apps).",
                            )
                            .small()
                            .weak(),
                        );
                    });

                // -----------------------------------------------------------
                // Microphone
                // -----------------------------------------------------------
                egui::CollapsingHeader::new("Microphone")
                    .default_open(true)
                    .show(ui, |ui| {
                        // Input level + noise gate, Discord-style: a live dBFS level bar
                        // with the gate threshold drawn as a draggable line over it.
                        ui.label("Input level");
                        let mut gate_on = self.params.gate_enabled();
                        if ui
                            .checkbox(&mut gate_on, "Noise gate (input sensitivity)")
                            .changed()
                        {
                            self.params.set_gate_enabled(gate_on);
                        }
                        self.draw_gate_meter(ui);

                        // Noise suppression (RNNoise is a fixed model; the one meaningful
                        // knob is a wet/dry mix: how much denoised signal to blend in).
                        let mut sup_on = self.params.suppress_enabled();
                        if ui
                            .checkbox(&mut sup_on, "Noise suppression (RNNoise)")
                            .changed()
                        {
                            self.params.set_suppress_enabled(sup_on);
                        }
                        let mut sup_amt = self.params.suppress_amount() * 100.0;
                        if ui
                            .add(
                                egui::Slider::new(&mut sup_amt, 0.0..=100.0)
                                    .suffix(" %")
                                    .text("Suppression amount"),
                            )
                            .changed()
                        {
                            self.params.set_suppress_amount(sup_amt / 100.0);
                        }

                        // AGC: one toggle, like Discord. It auto-levels your voice to a
                        // fixed, comfortable loudness, so there's no number to tune.
                        let mut agc_on = self.params.agc_enabled();
                        if ui
                            .checkbox(&mut agc_on, "Automatic gain control (auto-level my voice)")
                            .changed()
                        {
                            self.params.set_agc_enabled(agc_on);
                        }

                        // Mic volume: 100% = unchanged, 200% = double.
                        let mut vol_pct = self.params.volume() * 100.0;
                        if ui
                            .add(
                                egui::Slider::new(&mut vol_pct, 0.0..=200.0)
                                    .suffix(" %")
                                    .text("Mic volume"),
                            )
                            .changed()
                        {
                            self.params.set_volume(vol_pct / 100.0);
                        }

                        // Voice changer: presets + intensity. No EQ knobs by design.
                        ui.separator();
                        ui.label("Voice changer");
                        let cur_preset = self.params.voice_preset();
                        let mut sel = cur_preset;
                        ui.horizontal(|ui| {
                            ui.selectable_value(&mut sel, dsp::VoicePreset::Off, "Off");
                            ui.selectable_value(&mut sel, dsp::VoicePreset::Manly, "Deeper");
                            ui.selectable_value(&mut sel, dsp::VoicePreset::Girly, "Higher");
                        });
                        if sel != cur_preset {
                            self.params.set_voice_preset(sel);
                        }
                        if sel != dsp::VoicePreset::Off {
                            let mut intensity = self.params.voice_intensity() * 100.0;
                            if ui
                                .add(
                                    egui::Slider::new(&mut intensity, 0.0..=100.0)
                                        .suffix(" %")
                                        .text("Intensity"),
                                )
                                .changed()
                            {
                                self.params
                                    .set_voice_intensity((intensity / 100.0).clamp(0.0, 1.0));
                            }
                        }
                    });

                // -----------------------------------------------------------
                // Routed apps
                // -----------------------------------------------------------
                egui::CollapsingHeader::new("Routed apps")
                    .default_open(true)
                    .show(ui, |ui| {
                        // De-duplicated, windowed-only, search-filtered app list (one entry
                        // per app name; Add resolves the name to its process-tree root).
                        let search = self.app_search.to_lowercase();
                        // (name, is_playing): one entry per app name, windowed-only,
                        // search-filtered. An app is "playing" if ANY of its pids has
                        // an active audio session. Playing apps sort first (then
                        // alphabetical) and are marked with a speaker glyph.
                        let names: Vec<(String, bool)> = {
                            let mut map: std::collections::BTreeMap<String, bool> =
                                std::collections::BTreeMap::new();
                            for p in &self.procs {
                                if self.windowed_pids.contains(&p.pid)
                                    && !audio::processes::is_blocked(&p.name)
                                    && (search.is_empty()
                                        || p.name.to_lowercase().contains(&search))
                                {
                                    let playing = self.playing_pids.contains(&p.pid);
                                    let e = map.entry(p.name.clone()).or_insert(false);
                                    *e = *e || playing;
                                }
                            }
                            let mut v: Vec<(String, bool)> = map.into_iter().collect();
                            // Playing first (true before false), then alphabetical.
                            v.sort_by(|a, b| {
                                b.1.cmp(&a.1).then_with(|| {
                                    a.0.to_lowercase().cmp(&b.0.to_lowercase())
                                })
                            });
                            v
                        };
                        ui.horizontal(|ui| {
                            ui.add(
                                egui::TextEdit::singleline(&mut self.app_search)
                                    .desired_width(160.0)
                                    .hint_text("filter apps…"),
                            );
                            if ui.button("Refresh apps").clicked() {
                                self.procs = audio::processes::list_processes().unwrap_or_default();
                                self.procs.sort_by(|a, b| {
                                    a.name.to_lowercase().cmp(&b.name.to_lowercase())
                                });
                                self.windowed_pids = audio::processes::pids_with_visible_windows();
                                self.playing_pids = playing_pids();
                                if let Some(sel) = self.selected_app.clone() {
                                    if !self.procs.iter().any(|p| p.name == sel) {
                                        self.selected_app = None;
                                    }
                                }
                            }
                        });
                        egui::ScrollArea::vertical()
                            .id_source("proc_list")
                            .max_height(160.0)
                            .show(ui, |ui| {
                                for (name, playing) in &names {
                                    let label = if *playing {
                                        format!("🔊 {name}")
                                    } else {
                                        name.clone()
                                    };
                                    let icon = self.icon_for(name, ui.ctx());
                                    let selected =
                                        self.selected_app.as_deref() == Some(name.as_str());
                                    ui.horizontal(|ui| {
                                        if let Some(id) = icon {
                                            ui.image((id, egui::vec2(16.0, 16.0)));
                                        }
                                        if ui.selectable_label(selected, label).clicked() {
                                            self.selected_app = Some(name.clone());
                                        }
                                    });
                                }
                            });
                        let can_add = self.engine.is_running() && self.selected_app.is_some();
                        if ui
                            .add_enabled(can_add, egui::Button::new("➕ Add"))
                            .clicked()
                        {
                            if let Some(name) = self.selected_app.clone() {
                                match audio::processes::pick_tree_root(&self.procs, &name) {
                                    Some(pid) => {
                                        if let Err(e) = self.engine.add_app(pid, name) {
                                            self.status = format!("Add app failed: {e:#}");
                                        }
                                    }
                                    None => self.status = format!("'{name}' not running"),
                                }
                            }
                        }
                        if !self.engine.is_running() {
                            ui.label(
                                egui::RichText::new("Start routing to add apps.")
                                    .small()
                                    .weak(),
                            );
                        }

                        // Active app channels
                        // Pre-resolve icons by name first (icon_for needs &mut self,
                        // but the channel loop borrows self.engine immutably).
                        let chan_names: Vec<String> = self
                            .engine
                            .app_channels()
                            .iter()
                            .map(|ch| ch.name.clone())
                            .collect();
                        let chan_icons: std::collections::HashMap<String, Option<egui::TextureId>> =
                            chan_names
                                .iter()
                                .map(|n| (n.clone(), self.icon_for(n, ui.ctx())))
                                .collect();
                        let mut to_remove: Option<u64> = None;
                        // Collected mute/unmute action (id, mute?) applied after the
                        // loop to avoid borrowing self.muted_apps while iterating channels.
                        let mut to_toggle_mute: Option<(u64, bool)> = None;
                        for ch in self.engine.app_channels() {
                            ui.horizontal(|ui| {
                                if let Some(Some(id)) = chan_icons.get(&ch.name) {
                                    ui.image((*id, egui::vec2(16.0, 16.0)));
                                }
                                ui.label(&ch.name);
                                let is_muted = self.muted_apps.contains_key(&ch.id);
                                let shown = if is_muted {
                                    *self.muted_apps.get(&ch.id).unwrap()
                                } else {
                                    audio::mixer::load_f32(&ch.volume)
                                };
                                let mut v = shown * 100.0;
                                let resp = ui.add_enabled(
                                    !is_muted,
                                    egui::Slider::new(&mut v, 0.0..=200.0).suffix(" %"),
                                );
                                if !is_muted && resp.changed() {
                                    audio::mixer::store_f32(&ch.volume, v / 100.0);
                                }
                                if ui
                                    .button(if is_muted { "🔈 Unmute" } else { "🔇 Mute" })
                                    .clicked()
                                {
                                    to_toggle_mute = Some((ch.id, !is_muted));
                                }
                                if ui.button("✖ Remove").clicked() {
                                    to_remove = Some(ch.id);
                                }
                            });
                        }
                        if let Some((id, mute)) = to_toggle_mute {
                            if mute {
                                if let Some(ch) =
                                    self.engine.app_channels().iter().find(|c| c.id == id)
                                {
                                    self.muted_apps.insert(id, audio::mixer::load_f32(&ch.volume));
                                    audio::mixer::store_f32(&ch.volume, 0.0);
                                }
                            } else if let Some(v) = self.muted_apps.remove(&id) {
                                if let Some(ch) =
                                    self.engine.app_channels().iter().find(|c| c.id == id)
                                {
                                    audio::mixer::store_f32(&ch.volume, v);
                                }
                            }
                        }
                        if let Some(id) = to_remove {
                            self.engine.remove_app(id);
                            self.muted_apps.remove(&id);
                        }

                        // Ducking: apps and the soundboard get quieter while you talk.
                        ui.separator();
                        let duck = self.engine.duck_params();
                        let mut duck_on = duck.enabled();
                        if ui
                            .checkbox(&mut duck_on, "Duck apps + soundboard while I talk")
                            .changed()
                        {
                            duck.set_enabled(duck_on);
                        }
                        let mut duck_pct = duck.target() * 100.0;
                        if ui
                            .add(
                                egui::Slider::new(&mut duck_pct, 0.0..=100.0)
                                    .suffix(" %")
                                    .text("Lower apps to"),
                            )
                            .changed()
                        {
                            duck.set_target(duck_pct / 100.0);
                        }
                        ui.label(
                            egui::RichText::new(
                                "While you talk, apps drop to this % of their volume, then restore.",
                            )
                            .small()
                            .weak(),
                        );
                    });

                // -----------------------------------------------------------
                // Soundboard
                // -----------------------------------------------------------
                egui::CollapsingHeader::new("Soundboard")
                    .default_open(false)
                    .show(ui, |ui| {
                        // -- Folder picker --
                        ui.horizontal(|ui| {
                            ui.label("Folder:");
                            let te = ui.add(
                                egui::TextEdit::singleline(&mut self.sb_folder_text)
                                    .desired_width(220.0)
                                    .hint_text("path to soundboard folder"),
                            );
                            let set_clicked = ui.button("Set").clicked();
                            let enter_pressed =
                                te.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                            if set_clicked || enter_pressed {
                                // Unregister all clip hotkeys from the old folder.
                                for (_, (_, id)) in self.clip_hotkeys.drain() {
                                    if let Some(hk) = self.hotkeys.as_mut() {
                                        hk.unregister(id);
                                    }
                                }
                                let path = std::path::PathBuf::from(self.sb_folder_text.trim());
                                self.sb_files = list_audio_files(&path);
                                self.sb_folder = Some(path);
                            }
                        });
                        if let Some(ref f) = self.sb_folder {
                            ui.label(
                                egui::RichText::new(format!("{} clip(s)", self.sb_files.len()))
                                    .small()
                                    .weak(),
                            );
                            if self.sb_files.is_empty() {
                                ui.colored_label(
                                    egui::Color32::YELLOW,
                                    format!("No audio files found in {}", f.display()),
                                );
                            }
                        }

                        // -- Global soundboard settings --
                        ui.separator();
                        egui::CollapsingHeader::new("Global soundboard settings")
                            .default_open(false)
                            .show(ui, |ui| {
                                let mut vo = self.sb_global.vol_others * 100.0;
                                if ui
                                    .add(
                                        egui::Slider::new(&mut vo, 0.0..=200.0)
                                            .suffix(" %")
                                            .text("Others"),
                                    )
                                    .changed()
                                {
                                    self.sb_global.vol_others = vo / 100.0;
                                }
                                let mut vs = self.sb_global.vol_self * 100.0;
                                if ui
                                    .add(
                                        egui::Slider::new(&mut vs, 0.0..=200.0)
                                            .suffix(" %")
                                            .text("Self"),
                                    )
                                    .changed()
                                {
                                    self.sb_global.vol_self = vs / 100.0;
                                }
                                ui.checkbox(&mut self.sb_global.hear_local, "Hear local");
                                ui.checkbox(
                                    &mut self.sb_global_override,
                                    "Override all clips (use these at play time)",
                                );
                            });

                        // -- Search box --
                        ui.separator();
                        ui.horizontal(|ui| {
                            ui.label("🔍");
                            ui.add(
                                egui::TextEdit::singleline(&mut self.sb_search)
                                    .desired_width(200.0)
                                    .hint_text("search clips…"),
                            );
                            if !self.sb_search.is_empty() && ui.button("✖").clicked() {
                                self.sb_search.clear();
                            }
                        });

                        // -- Clip grid --
                        // Compact tiles that flow + fill the available width. Each tile
                        // shows only the clip name, ▶ Play, and a ⚙ settings toggle;
                        // per-clip settings appear in the editor panel below the grid.
                        const TILE_W: f32 = 120.0;
                        let needle = self.sb_search.to_lowercase();
                        let files_snapshot: Vec<std::path::PathBuf> = self
                            .sb_files
                            .iter()
                            .filter(|p| {
                                needle.is_empty()
                                    || p.file_name()
                                        .map(|n| {
                                            n.to_string_lossy().to_lowercase().contains(&needle)
                                        })
                                        .unwrap_or(false)
                            })
                            .cloned()
                            .collect();
                        egui::ScrollArea::vertical()
                            .id_source("sb_clip_grid")
                            .max_height(240.0)
                            .show(ui, |ui| {
                                ui.horizontal_wrapped(|ui| {
                                    for path in files_snapshot.iter() {
                                        let name = path
                                            .file_name()
                                            .map(|n| n.to_string_lossy().to_string())
                                            .unwrap_or_default();
                                        ui.allocate_ui(egui::vec2(TILE_W, 0.0), |ui| {
                                            ui.group(|ui| {
                                                ui.set_width(TILE_W);
                                                ui.vertical(|ui| {
                                                    ui.add(
                                                        egui::Label::new(
                                                            egui::RichText::new(&name).strong(),
                                                        )
                                                        .truncate(),
                                                    );
                                                    ui.horizontal(|ui| {
                                                        if ui.button("▶").clicked() {
                                                            let s = if self.sb_global_override {
                                                                self.sb_global.clone()
                                                            } else {
                                                                self.clip_settings
                                                                    .get(&name)
                                                                    .cloned()
                                                                    .unwrap_or_default()
                                                            };
                                                            // `path` = folder + file name;
                                                            // decoded while it plays.
                                                            let gains = ClipGains::new(
                                                                s.vol_others,
                                                                s.vol_self,
                                                                s.hear_local,
                                                            );
                                                            self.engine.play_clip(
                                                                name.clone(),
                                                                path.clone(),
                                                                std::sync::Arc::new(gains),
                                                            );
                                                        }
                                                        let selected = self.sb_selected_clip.as_deref()
                                                            == Some(name.as_str());
                                                        if ui
                                                            .selectable_label(selected, "⚙")
                                                            .clicked()
                                                        {
                                                            self.sb_selected_clip = if selected {
                                                                None
                                                            } else {
                                                                Some(name.clone())
                                                            };
                                                        }
                                                        if self.clip_hotkeys.contains_key(path) {
                                                            ui.label(
                                                                egui::RichText::new("⌨")
                                                                    .small()
                                                                    .weak(),
                                                            );
                                                        }
                                                    });
                                                });
                                            });
                                        });
                                    }
                                });
                            });

                        // -- Per-clip settings editor (only for the selected clip) --
                        if let Some(sel) = self.sb_selected_clip.clone() {
                            // Resolve the path for the selected clip (for hotkey binding).
                            let sel_path = self
                                .sb_files
                                .iter()
                                .find(|p| {
                                    p.file_name()
                                        .map(|n| n.to_string_lossy() == sel.as_str())
                                        .unwrap_or(false)
                                })
                                .cloned();
                            ui.separator();
                            ui.group(|ui| {
                                ui.horizontal(|ui| {
                                    ui.strong(format!("Settings: {sel}"));
                                    if ui.small_button("✖").clicked() {
                                        self.sb_selected_clip = None;
                                    }
                                });
                                let mut cs = self
                                    .clip_settings
                                    .get(&sel)
                                    .cloned()
                                    .unwrap_or_default();
                                let mut changed = false;
                                let mut vo = cs.vol_others * 100.0;
                                if ui
                                    .add(
                                        egui::Slider::new(&mut vo, 0.0..=200.0)
                                            .suffix(" %")
                                            .text("Others"),
                                    )
                                    .changed()
                                {
                                    cs.vol_others = vo / 100.0;
                                    changed = true;
                                }
                                let mut vs = cs.vol_self * 100.0;
                                if ui
                                    .add(
                                        egui::Slider::new(&mut vs, 0.0..=200.0)
                                            .suffix(" %")
                                            .text("Self"),
                                    )
                                    .changed()
                                {
                                    cs.vol_self = vs / 100.0;
                                    changed = true;
                                }
                                if ui.checkbox(&mut cs.hear_local, "Hear local").changed() {
                                    changed = true;
                                }
                                if changed {
                                    self.clip_settings.insert(sel.clone(), cs);
                                }
                                if self.sb_global_override {
                                    ui.label(
                                        egui::RichText::new(
                                            "Global override is on, so these are ignored when a sound plays.",
                                        )
                                        .small()
                                        .weak(),
                                    );
                                }
                                if let Some(ref path) = sel_path {
                                    ui.horizontal(|ui| {
                                        let is_waiting = self.binding.as_ref() == Some(path);
                                        let btn_label =
                                            if is_waiting { "Press key…" } else { "Set hotkey" };
                                        if ui.button(btn_label).clicked() {
                                            self.binding = if is_waiting {
                                                None
                                            } else {
                                                Some(path.clone())
                                            };
                                        }
                                        if let Some((accel, _)) = self.clip_hotkeys.get(path) {
                                            ui.label(
                                                egui::RichText::new(format!("[{accel}]"))
                                                    .monospace(),
                                            );
                                        }
                                    });
                                }
                            });
                        }

                        // -- Now playing --
                        {
                            let now_playing: Vec<_> = self
                                .engine
                                .sb_playing()
                                .lock()
                                .ok()
                                .map(|g| g.clone())
                                .unwrap_or_default();
                            if !now_playing.is_empty() {
                                ui.separator();
                                ui.strong("Now playing");
                                for state in &now_playing {
                                    ui.horizontal(|ui| {
                                        ui.label(&state.name);
                                        match state.len_frames {
                                            Some(len) => {
                                                let progress = (state.pos_frames as f64
                                                    / len.max(1) as f64)
                                                    .min(1.0)
                                                    as f32;
                                                ui.add(
                                                    egui::ProgressBar::new(progress)
                                                        .desired_width(160.0),
                                                );
                                            }
                                            None => {
                                                // Length unknown (or decoder still
                                                // opening): show elapsed time.
                                                let secs = state.pos_frames as f64
                                                    / audio::format::SAMPLE_RATE as f64;
                                                ui.label(format!("{secs:.1} s"));
                                            }
                                        }
                                        if state.paused {
                                            if ui.button("▶").clicked() {
                                                self.engine.resume_clip(state.id);
                                            }
                                        } else if ui.button("⏸").clicked() {
                                            self.engine.pause_clip(state.id);
                                        }
                                        if ui.button("⏹").clicked() {
                                            self.engine.stop_clip(state.id);
                                        }
                                    });
                                }
                                // Keep the UI animating while clips are playing.
                                ctx.request_repaint();
                            }
                        }

                        // -- Stop all --
                        ui.separator();
                        ui.horizontal(|ui| {
                            if ui.button("⏹ Stop all").clicked() {
                                self.engine.stop_all_clips();
                            }
                            let stop_sentinel = std::path::PathBuf::new();
                            let stop_waiting =
                                self.binding.as_deref() == Some(stop_sentinel.as_path());
                            let stop_label =
                                if stop_waiting { "Press key…" } else { "Set stop-all hotkey" };
                            if ui.button(stop_label).clicked() {
                                self.binding = if stop_waiting {
                                    None
                                } else {
                                    Some(stop_sentinel)
                                };
                            }
                            if let Some((accel, _)) = &self.stop_all_hotkey {
                                ui.label(egui::RichText::new(format!("[{accel}]")).monospace());
                            }
                        });

                        // -- Monitoring --
                        ui.separator();
                        ui.strong("Monitoring");
                        ui.label(
                            egui::RichText::new(
                                "Per-clip 'Hear local' decides which clips play to this device.",
                            )
                            .small()
                            .weak(),
                        );

                        // Monitor device picker
                        let current_mon_name = self
                            .sb_monitor_device
                            .as_ref()
                            .and_then(|id| self.outputs.iter().find(|d| &d.id == id))
                            .map(|d| d.name.clone())
                            .unwrap_or_else(|| "<system default>".to_string());
                        let outputs_snap: Vec<(String, String)> =
                            self.outputs.iter().map(|d| (d.id.clone(), d.name.clone())).collect();
                        let mut new_mon_device = self.sb_monitor_device.clone();
                        egui::ComboBox::from_label("Monitor device")
                            .selected_text(&current_mon_name)
                            .show_ui(ui, |ui| {
                                ui.selectable_value(&mut new_mon_device, None, "<system default>");
                                for (id, name) in &outputs_snap {
                                    ui.selectable_value(
                                        &mut new_mon_device,
                                        Some(id.clone()),
                                        name,
                                    );
                                }
                            });
                        if new_mon_device != self.sb_monitor_device {
                            self.sb_monitor_device = new_mon_device;
                            self.engine.set_monitor_device(self.sb_monitor_device.clone());
                        }

                        if self.engine.is_running() {
                            ui.label(
                                egui::RichText::new(
                                    "Monitor device change takes effect on next Start.",
                                )
                                .small()
                                .weak(),
                            );
                        }

                        if self.hotkeys.is_none() {
                            ui.colored_label(
                                egui::Color32::RED,
                                "Hotkeys aren't available (GlobalHotKeyManager failed to start).",
                            );
                        } else if self.binding.is_some() {
                            ui.colored_label(
                                egui::Color32::YELLOW,
                                "Waiting for hotkey… (Escape to cancel)",
                            );
                        }
                    });

                // Animate the level meter only while routing or while binding a hotkey
                // (binding mode needs fast repaints to capture the key press promptly).
                if self.engine.is_running() || self.binding.is_some() {
                    ctx.request_repaint_after(std::time::Duration::from_millis(33));
                    // ~30 FPS
                }
            }); // end ScrollArea
        });
    }

    /// Persist the full current state when the window is closed.
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        let _ = config::save(&self.current_config());
        self.audio_lock = None;
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/// True if a render-device name looks like a VB-CABLE virtual input.
/// Used to warn when the user picks a real playback device as the output,
/// which would play audio to that device instead of feeding a virtual mic.
fn output_is_cable(name: &str) -> bool {
    name.to_lowercase().contains("cable")
}

/// Map a linear RMS amplitude to a 0..1 meter position on a dBFS scale
/// (-60 dBFS floor -> 0.0, 0 dBFS -> 1.0). Linear RMS for speech is tiny
/// (~0.02-0.08), so a raw linear bar barely leaves zero; the dB mapping makes
/// normal speech read around the middle of the meter.
fn rms_to_meter(rms: f32) -> f32 {
    if rms <= 1e-6 {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

/// Inverse of `rms_to_meter`: map a 0..1 meter position back to linear RMS,
/// so a percentage slider value can be stored as a linear threshold/target.
fn meter_to_rms(norm: f32) -> f32 {
    let db = norm.clamp(0.0, 1.0) * 60.0 - 60.0;
    10f32.powf(db / 20.0)
}

/// Map an egui key + modifiers to an accelerator string accepted by the
/// `global-hotkey` crate (e.g. `"Ctrl+Shift+F8"`, `"F1"`, `"Alt+A"`).
///
/// Only F-keys and letter/digit keys are mapped; other keys return `None` so
/// the binding loop keeps waiting for a recognisable key.
fn egui_key_to_accel(key: egui::Key, mods: egui::Modifiers) -> Option<String> {
    use egui::Key;
    let key_str = match key {
        Key::F1 => "F1",
        Key::F2 => "F2",
        Key::F3 => "F3",
        Key::F4 => "F4",
        Key::F5 => "F5",
        Key::F6 => "F6",
        Key::F7 => "F7",
        Key::F8 => "F8",
        Key::F9 => "F9",
        Key::F10 => "F10",
        Key::F11 => "F11",
        Key::F12 => "F12",
        Key::A => "A",
        Key::B => "B",
        Key::C => "C",
        Key::D => "D",
        Key::E => "E",
        Key::F => "F",
        Key::G => "G",
        Key::H => "H",
        Key::I => "I",
        Key::J => "J",
        Key::K => "K",
        Key::L => "L",
        Key::M => "M",
        Key::N => "N",
        Key::O => "O",
        Key::P => "P",
        Key::Q => "Q",
        Key::R => "R",
        Key::S => "S",
        Key::T => "T",
        Key::U => "U",
        Key::V => "V",
        Key::W => "W",
        Key::X => "X",
        Key::Y => "Y",
        Key::Z => "Z",
        Key::Num0 => "0",
        Key::Num1 => "1",
        Key::Num2 => "2",
        Key::Num3 => "3",
        Key::Num4 => "4",
        Key::Num5 => "5",
        Key::Num6 => "6",
        Key::Num7 => "7",
        Key::Num8 => "8",
        Key::Num9 => "9",
        _ => return None,
    };
    let mut parts: Vec<&str> = Vec::new();
    // On Windows `ctrl` is the Control key and `command` mirrors it, so avoid duplicates.
    if mods.ctrl {
        parts.push("Ctrl");
    }
    if mods.shift {
        parts.push("Shift");
    }
    if mods.alt {
        parts.push("Alt");
    }
    parts.push(key_str);
    Some(parts.join("+"))
}

/// Linear RMS amplitude to dBFS for display (floored at -90 dB for silence).
fn rms_to_dbfs(rms: f32) -> f32 {
    if rms <= 1e-6 {
        -90.0
    } else {
        20.0 * rms.log10()
    }
}

/// `apply_profile_dsp` for the window: the auto gate, listen-to-yourself and
/// mic quality are headless-only (the window has no controls for them, and with
/// auto on its threshold slider would do nothing), so they are forced off here.
fn apply_window_profile_dsp(params: &dsp::MicParams, p: &config::Profile) {
    apply_profile_dsp(params, p);
    params.set_gate_auto(false);
    params.set_monitor_mic(false);
    params.set_mic_quality(100.0);
}

#[cfg(test)]
mod tests {
    use super::{meter_to_rms, output_is_cable, rms_to_dbfs, rms_to_meter};

    #[test]
    fn window_forces_headless_only_dsp_off() {
        // The window has no controls for these: a shared config that has them
        // on must not leave the window stuck with them.
        let params = crate::dsp::MicParams::new();
        super::apply_window_profile_dsp(
            &params,
            &crate::config::Profile {
                gate_enabled: true,
                gate_threshold: Some(0.05),
                gate_auto: true,
                monitor_mic: true,
                mic_quality: Some(20.0),
                ..Default::default()
            },
        );
        assert!(!params.gate_auto());
        assert!(!params.monitor_mic());
        assert_eq!(params.mic_quality(), 100.0);
        // Everything else still applies.
        assert!(params.gate_enabled());
        assert!((params.gate_threshold() - 0.05).abs() < 1e-6);
    }

    #[test]
    fn dbfs_conversion() {
        assert!(rms_to_dbfs(1.0).abs() < 0.01); // full scale -> 0 dBFS
        assert!((rms_to_dbfs(0.1) + 20.0).abs() < 0.1); // 0.1 -> -20 dBFS
        assert!(rms_to_dbfs(0.0) <= -89.0); // silence floored
    }

    #[test]
    fn meter_maps_dbfs_range() {
        assert_eq!(rms_to_meter(0.0), 0.0);
        // 0 dBFS (full scale) -> ~1.0
        assert!((rms_to_meter(1.0) - 1.0).abs() < 1e-6);
        // ~-60 dBFS -> ~0.0
        assert!(rms_to_meter(0.001) < 0.02);
        // ~-30 dBFS (typical speech) -> around the middle
        let mid = rms_to_meter(0.0316); // 10^(-30/20)
        assert!(mid > 0.4 && mid < 0.6, "mid = {}", mid);
    }

    #[test]
    fn meter_to_rms_inverts_rms_to_meter() {
        for &rms in &[0.01f32, 0.0316, 0.1, 0.5] {
            let back = meter_to_rms(rms_to_meter(rms));
            assert!(
                (back - rms).abs() < rms * 0.05 + 1e-4,
                "rms={} back={}",
                rms,
                back
            );
        }
    }

    #[test]
    fn detects_cable_devices() {
        assert!(output_is_cable("CABLE Input (VB-Audio Virtual Cable)"));
        assert!(output_is_cable("CABLE In 16ch (VB-Audio Virtual Cable)"));
    }

    #[test]
    fn rejects_real_playback_devices() {
        assert!(!output_is_cable("Headphones (2- Realtek(R) Audio)"));
        assert!(!output_is_cable("Speakers (7.1 Surround Sound)"));
    }

}

fn main() -> eframe::Result<()> {
    let is_headless = std::env::args().any(|a| a == "--headless");
    // `--dump-config` stays a pure one-liner: no log, no side effects.
    if !is_headless && std::env::args().any(|a| a == "--dump-config") {
        println!("{}", headless::protocol::legacy_profile_json(&config::load()));
        return Ok(());
    }
    elog::init(&elog::default_dir());
    if is_headless {
        // Logs its own startup/shutdown events and flushes the log.
        std::process::exit(headless::run());
    }
    elog::event(
        "startup",
        &format!(
            "o2i {} mode=window pid={}",
            env!("CARGO_PKG_VERSION"),
            std::process::id()
        ),
    );
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([520.0, 360.0]),
        ..Default::default()
    };
    let result = eframe::run_native("o2i", options, Box::new(|_cc| Ok(Box::<App>::default())));
    elog::event(
        "shutdown",
        &match &result {
            Ok(()) => "window closed".to_string(),
            Err(e) => format!("window error: {e}"),
        },
    );
    elog::flush();
    result
}
