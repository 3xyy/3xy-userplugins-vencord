use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Arc;

/// Voice-changer preset for the mic channel. Each maps to a (pitch, formant)
/// semitone shift at full intensity; the intensity slider scales both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoicePreset {
    Off,
    Manly,
    Girly,
}

impl VoicePreset {
    /// (pitch_semitones, formant_semitones) at intensity = 1.0.
    /// Starting values; tuned during the live test.
    pub fn base_semitones(self) -> (f32, f32) {
        match self {
            VoicePreset::Off => (0.0, 0.0),
            VoicePreset::Manly => (-4.0, -3.0),
            VoicePreset::Girly => (4.0, 3.0),
        }
    }

    /// Effective (pitch, formant) semitones after applying intensity (clamped 0..1).
    pub fn semitones_at(self, intensity: f32) -> (f32, f32) {
        let k = intensity.clamp(0.0, 1.0);
        let (p, f) = self.base_semitones();
        (p * k, f * k)
    }

    pub fn to_u8(self) -> u8 {
        match self {
            VoicePreset::Off => 0,
            VoicePreset::Manly => 1,
            VoicePreset::Girly => 2,
        }
    }
    pub fn from_u8(v: u8) -> VoicePreset {
        match v {
            1 => VoicePreset::Manly,
            2 => VoicePreset::Girly,
            _ => VoicePreset::Off,
        }
    }

    /// Stable string id used for config persistence.
    pub fn as_str(self) -> &'static str {
        match self {
            VoicePreset::Off => "off",
            VoicePreset::Manly => "manly",
            VoicePreset::Girly => "girly",
        }
    }
    pub fn from_str_id(s: &str) -> VoicePreset {
        match s {
            "manly" => VoicePreset::Manly,
            "girly" => VoicePreset::Girly,
            _ => VoicePreset::Off,
        }
    }
}

/// Default auto-gate margin above the noise floor (dB).
pub const DEFAULT_GATE_AUTO_MARGIN_DB: f32 = 6.0;

/// Lock-free, live-tunable mic-processing parameters shared between the UI
/// thread (writer) and the capture/audio thread (reader). f32 fields are
/// stored as raw bits in an AtomicU32.
pub struct MicParams {
    gate_enabled: AtomicBool,
    gate_threshold: AtomicU32,
    suppress_enabled: AtomicBool,
    suppress_amount: AtomicU32,
    agc_enabled: AtomicBool,
    agc_target: AtomicU32,
    volume: AtomicU32,
    input_level: AtomicU32,
    voice_preset: AtomicU8,
    voice_intensity: AtomicU32,
    /// Listen to yourself: the capture thread also feeds the processed mic to
    /// the monitor (headphones) output.
    monitor_mic: AtomicBool,
    /// Gain of the mic in the monitor output (f32 bits, 0..2). Shared (`Arc`)
    /// so the monitor mixer can read it directly as a source volume.
    monitor_mic_volume: Arc<AtomicU32>,
    /// Track the noise floor and derive the gate threshold from it.
    gate_auto: AtomicBool,
    /// Auto-gate margin above the noise floor, in dB (f32 bits).
    gate_auto_margin_db: AtomicU32,
    /// The threshold (linear RMS) the auto gate currently uses, published by
    /// the capture thread while `gate_auto` is on.
    gate_threshold_live: AtomicU32,
    /// Mic mute: the chain ramps its output to silence (what Discord and the
    /// mic monitor hear); the soundboard and routed apps are not affected.
    /// Not a profile setting, so `configure` never changes it.
    mic_muted: AtomicBool,
    /// Mic quality 0..100 (f32 bits): lower values make the mic sound worse
    /// (`degrade` stage); 100 leaves it untouched.
    mic_quality: AtomicU32,
}

impl Default for MicParams {
    fn default() -> Self {
        Self {
            gate_enabled: AtomicBool::new(false),
            gate_threshold: AtomicU32::new(0.02f32.to_bits()),
            suppress_enabled: AtomicBool::new(false),
            suppress_amount: AtomicU32::new(1.0f32.to_bits()),
            agc_enabled: AtomicBool::new(false),
            agc_target: AtomicU32::new(0.1f32.to_bits()),
            volume: AtomicU32::new(1.0f32.to_bits()),
            input_level: AtomicU32::new(0.0f32.to_bits()),
            voice_preset: AtomicU8::new(0), // VoicePreset::Off
            voice_intensity: AtomicU32::new(0.6f32.to_bits()),
            monitor_mic: AtomicBool::new(false),
            monitor_mic_volume: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            gate_auto: AtomicBool::new(false),
            gate_auto_margin_db: AtomicU32::new(DEFAULT_GATE_AUTO_MARGIN_DB.to_bits()),
            gate_threshold_live: AtomicU32::new(0.0f32.to_bits()),
            mic_muted: AtomicBool::new(false),
            mic_quality: AtomicU32::new(100.0f32.to_bits()),
        }
    }
}

impl MicParams {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn gate_enabled(&self) -> bool {
        self.gate_enabled.load(Ordering::Relaxed)
    }
    pub fn set_gate_enabled(&self, v: bool) {
        self.gate_enabled.store(v, Ordering::Relaxed);
    }
    pub fn gate_threshold(&self) -> f32 {
        f32::from_bits(self.gate_threshold.load(Ordering::Relaxed))
    }
    pub fn set_gate_threshold(&self, v: f32) {
        self.gate_threshold.store(v.to_bits(), Ordering::Relaxed);
    }

    pub fn suppress_enabled(&self) -> bool {
        self.suppress_enabled.load(Ordering::Relaxed)
    }
    pub fn set_suppress_enabled(&self, v: bool) {
        self.suppress_enabled.store(v, Ordering::Relaxed);
    }
    pub fn suppress_amount(&self) -> f32 {
        f32::from_bits(self.suppress_amount.load(Ordering::Relaxed))
    }
    pub fn set_suppress_amount(&self, v: f32) {
        self.suppress_amount.store(v.to_bits(), Ordering::Relaxed);
    }

    pub fn agc_enabled(&self) -> bool {
        self.agc_enabled.load(Ordering::Relaxed)
    }
    pub fn set_agc_enabled(&self, v: bool) {
        self.agc_enabled.store(v, Ordering::Relaxed);
    }
    pub fn agc_target(&self) -> f32 {
        f32::from_bits(self.agc_target.load(Ordering::Relaxed))
    }
    pub fn set_agc_target(&self, v: f32) {
        self.agc_target.store(v.to_bits(), Ordering::Relaxed);
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }
    pub fn set_volume(&self, v: f32) {
        self.volume.store(v.to_bits(), Ordering::Relaxed);
    }

    pub fn input_level(&self) -> f32 {
        f32::from_bits(self.input_level.load(Ordering::Relaxed))
    }
    pub fn set_input_level(&self, v: f32) {
        self.input_level.store(v.to_bits(), Ordering::Relaxed);
    }

    pub fn voice_preset(&self) -> VoicePreset {
        VoicePreset::from_u8(self.voice_preset.load(Ordering::Relaxed))
    }
    pub fn set_voice_preset(&self, p: VoicePreset) {
        self.voice_preset.store(p.to_u8(), Ordering::Relaxed);
    }
    pub fn voice_intensity(&self) -> f32 {
        f32::from_bits(self.voice_intensity.load(Ordering::Relaxed))
    }
    pub fn set_voice_intensity(&self, v: f32) {
        self.voice_intensity.store(v.to_bits(), Ordering::Relaxed);
    }

    pub fn monitor_mic(&self) -> bool {
        self.monitor_mic.load(Ordering::Relaxed)
    }
    pub fn set_monitor_mic(&self, v: bool) {
        self.monitor_mic.store(v, Ordering::Relaxed);
    }
    // The monitor mixer reads the shared atomic (`monitor_mic_volume_handle`)
    // directly; this getter is for UIs and tests.
    #[allow(dead_code)]
    pub fn monitor_mic_volume(&self) -> f32 {
        f32::from_bits(self.monitor_mic_volume.load(Ordering::Relaxed))
    }
    pub fn set_monitor_mic_volume(&self, v: f32) {
        self.monitor_mic_volume
            .store(v.to_bits(), Ordering::Relaxed);
    }
    /// The shared monitor-mic gain atomic, for use as a mixer source volume.
    pub fn monitor_mic_volume_handle(&self) -> Arc<AtomicU32> {
        self.monitor_mic_volume.clone()
    }

    pub fn gate_auto(&self) -> bool {
        self.gate_auto.load(Ordering::Relaxed)
    }
    pub fn set_gate_auto(&self, v: bool) {
        self.gate_auto.store(v, Ordering::Relaxed);
    }
    pub fn gate_auto_margin_db(&self) -> f32 {
        f32::from_bits(self.gate_auto_margin_db.load(Ordering::Relaxed))
    }
    pub fn set_gate_auto_margin_db(&self, v: f32) {
        self.gate_auto_margin_db
            .store(v.to_bits(), Ordering::Relaxed);
    }
    pub fn gate_threshold_live(&self) -> f32 {
        f32::from_bits(self.gate_threshold_live.load(Ordering::Relaxed))
    }
    pub fn set_gate_threshold_live(&self, v: f32) {
        self.gate_threshold_live
            .store(v.to_bits(), Ordering::Relaxed);
    }

    pub fn mic_muted(&self) -> bool {
        self.mic_muted.load(Ordering::Relaxed)
    }
    pub fn set_mic_muted(&self, v: bool) {
        self.mic_muted.store(v, Ordering::Relaxed);
    }

    pub fn mic_quality(&self) -> f32 {
        f32::from_bits(self.mic_quality.load(Ordering::Relaxed))
    }
    pub fn set_mic_quality(&self, v: f32) {
        self.mic_quality.store(v.to_bits(), Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let p = MicParams::new();
        assert!(!p.gate_enabled());
        assert!((p.volume() - 1.0).abs() < 1e-6);
        assert!((p.gate_threshold() - 0.02).abs() < 1e-6);
        assert!((p.agc_target() - 0.1).abs() < 1e-6);
    }

    #[test]
    fn f32_fields_round_trip() {
        let p = MicParams::new();
        p.set_gate_threshold(0.137);
        p.set_volume(1.75);
        p.set_input_level(0.5);
        assert!((p.gate_threshold() - 0.137).abs() < 1e-6);
        assert!((p.volume() - 1.75).abs() < 1e-6);
        assert!((p.input_level() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn bool_fields_toggle() {
        let p = MicParams::new();
        p.set_suppress_enabled(true);
        p.set_agc_enabled(true);
        assert!(p.suppress_enabled());
        assert!(p.agc_enabled());
    }

    #[test]
    fn monitor_and_auto_gate_defaults_and_round_trip() {
        let p = MicParams::new();
        assert!(!p.monitor_mic());
        assert!((p.monitor_mic_volume() - 1.0).abs() < 1e-6);
        assert!(!p.gate_auto());
        assert!((p.gate_auto_margin_db() - 6.0).abs() < 1e-6);
        assert_eq!(p.gate_threshold_live(), 0.0);
        p.set_monitor_mic(true);
        p.set_monitor_mic_volume(1.5);
        p.set_gate_auto(true);
        p.set_gate_auto_margin_db(9.0);
        p.set_gate_threshold_live(0.03);
        assert!(p.monitor_mic() && p.gate_auto());
        assert!((p.gate_auto_margin_db() - 9.0).abs() < 1e-6);
        assert!((p.gate_threshold_live() - 0.03).abs() < 1e-6);
        // The handle is the same atomic the accessors use.
        let h = p.monitor_mic_volume_handle();
        assert!((f32::from_bits(h.load(Ordering::Relaxed)) - 1.5).abs() < 1e-6);
    }

    #[test]
    fn mic_muted_defaults_off_and_round_trips() {
        let p = MicParams::new();
        assert!(!p.mic_muted(), "a fresh engine starts unmuted");
        p.set_mic_muted(true);
        assert!(p.mic_muted());
        // Mute is its own flag: the volume setting is kept.
        assert!((p.volume() - 1.0).abs() < 1e-6);
        p.set_mic_muted(false);
        assert!(!p.mic_muted());
    }

    #[test]
    fn mic_quality_defaults_to_100_and_round_trips() {
        let p = MicParams::new();
        assert_eq!(
            p.mic_quality(),
            100.0,
            "a fresh engine leaves the mic untouched"
        );
        p.set_mic_quality(35.0);
        assert_eq!(p.mic_quality(), 35.0);
    }

    #[test]
    fn voice_defaults_are_off_and_default_intensity() {
        let p = MicParams::new();
        assert_eq!(p.voice_preset(), VoicePreset::Off);
        assert!((p.voice_intensity() - 0.6).abs() < 1e-6);
    }

    #[test]
    fn voice_preset_round_trips() {
        let p = MicParams::new();
        p.set_voice_preset(VoicePreset::Manly);
        assert_eq!(p.voice_preset(), VoicePreset::Manly);
        p.set_voice_preset(VoicePreset::Girly);
        assert_eq!(p.voice_preset(), VoicePreset::Girly);
        p.set_voice_intensity(0.25);
        assert!((p.voice_intensity() - 0.25).abs() < 1e-6);
    }

    #[test]
    fn voice_preset_u8_and_str_round_trip() {
        for pr in [VoicePreset::Off, VoicePreset::Manly, VoicePreset::Girly] {
            assert_eq!(VoicePreset::from_u8(pr.to_u8()), pr);
            assert_eq!(VoicePreset::from_str_id(pr.as_str()), pr);
        }
        // Unknown inputs fall back to Off.
        assert_eq!(VoicePreset::from_u8(99), VoicePreset::Off);
        assert_eq!(VoicePreset::from_str_id("bogus"), VoicePreset::Off);
    }

    #[test]
    fn voice_semitones_scale_with_intensity() {
        assert_eq!(VoicePreset::Off.semitones_at(1.0), (0.0, 0.0));
        let (p, f) = VoicePreset::Manly.semitones_at(1.0);
        assert!(p < 0.0 && f < 0.0, "manly shifts down: ({p}, {f})");
        let (p, f) = VoicePreset::Girly.semitones_at(1.0);
        assert!(p > 0.0 && f > 0.0, "girly shifts up: ({p}, {f})");
        // Half intensity halves the shift.
        let (p1, f1) = VoicePreset::Girly.semitones_at(1.0);
        let (ph, fh) = VoicePreset::Girly.semitones_at(0.5);
        assert!((ph - p1 * 0.5).abs() < 1e-6 && (fh - f1 * 0.5).abs() < 1e-6);
        // Intensity 0 => no shift; intensity is clamped above 1.0.
        assert_eq!(VoicePreset::Girly.semitones_at(0.0), (0.0, 0.0));
        assert_eq!(
            VoicePreset::Girly.semitones_at(5.0),
            VoicePreset::Girly.semitones_at(1.0)
        );
    }
}
