//! Piper natural voices (`piper:<name>`). A small curated catalogue of English
//! voices, an installer that downloads the official Piper Windows runtime and
//! a voice into `%APPDATA%\o2i\tts\`, and a `Synth` that runs `piper.exe` as a
//! child process (text on stdin, raw 16-bit mono PCM on stdout).
//!
//! Layout under the tts dir:
//!   `runtime\piper.exe` (+ DLLs, `espeak-ng-data\`)  the Piper runtime
//!   `voices\<key>.onnx` and `voices\<key>.onnx.json`   one installed voice
//!   `*.part`, `runtime.tmp\`                           transient, removed on failure
//!
//! Installs run on their own thread, so speech keeps working during a
//! download. The network and the process are behind the `Downloader` and
//! `Runner` traits so tests use mocks. Nothing here runs on an audio thread.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::{Audio, Synth, Voice};

pub const PREFIX: &str = "piper:";

/// A synthesis run longer than this is killed.
const RUN_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Raw PCM accepted from one run (about 12 minutes at 22.05 kHz).
const MAX_PCM_BYTES: usize = 32 * 1024 * 1024;
/// Total bytes accepted when unpacking the runtime archive.
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One file to download: URL, exact size and SHA-256 (lowercase hex).
#[derive(Clone, Debug)]
pub struct FileSpec {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct VoiceEntry {
    /// The part of the id after `piper:`; also the file stem on disk.
    pub key: String,
    pub name: String,
    pub model: FileSpec,
    pub config: FileSpec,
}

impl VoiceEntry {
    pub fn id(&self) -> String {
        format!("{PREFIX}{}", self.key)
    }
}

#[derive(Clone, Debug)]
pub struct Catalogue {
    pub runtime: FileSpec,
    pub voices: Vec<VoiceEntry>,
}

/// Every voice file is pinned to the immutable `v1.0.0` tag of
/// `rhasspy/piper-voices`. SHA-256 and size come from the Hugging Face tree
/// API (`lfs.oid` / `size`) for the models; the small configs were hashed
/// once from the same tag. The runtime is the official `rhasspy/piper`
/// release `2023.11.14-2` (the release API has no digest, so it was hashed
/// once from the official download).
const VOICES_BASE: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0";
const RUNTIME_URL: &str = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
const RUNTIME_SHA256: &str = "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea";
const RUNTIME_SIZE: u64 = 22_477_236;
/// Every medium model in the list is the same size.
const MODEL_SIZE: u64 = 63_201_294;

/// (language, speaker, display name, model sha256, config sha256, config size)
/// Dataset licenses are from each voice's MODEL_CARD.
const VOICES: [(&str, &str, &str, &str, &str, u64); 6] = [
    // Blizzard 2013 Lessac dataset: its own license, see the dataset page.
    (
        "en_US",
        "lessac",
        "Lessac (US)",
        "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
        "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
        4885,
    ),
    // Mycroft mimic3-voices dataset: "See URL" (github.com/MycroftAI/mimic3-voices).
    (
        "en_US",
        "amy",
        "Amy (US)",
        "b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18",
        "95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77",
        4882,
    ),
    // Nabu Casa voice datasets: CC0.
    (
        "en_US",
        "joe",
        "Joe (US)",
        "58afce0321b8d9c46d7cdf9c16500cc55a793b4220212dba6b70fb788b3baf06",
        "3d6d5410b3795cb1950595247ef8f06190719e6fdbfa3a2356d8ec368e1aad33",
        4794,
    ),
    // Mycroft mimic3-voices (apope_low): "See URL".
    (
        "en_GB",
        "alan",
        "Alan (UK)",
        "0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330",
        "c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e",
        4888,
    ),
    // University of Edinburgh DataShare 10283/3270: CC BY 4.0.
    (
        "en_GB",
        "alba",
        "Alba (UK)",
        "401369c4a81d09fdd86c32c5c864440811dbdcc66466cde2d64f7133a66ad03b",
        "aa965a2f02ecced632c2694e1fc72bbff6d65f265fab567ca945918c73dd89f4",
        4888,
    ),
    // dioco-group jenny-tts-dataset: "See URL".
    (
        "en_GB",
        "jenny_dioco",
        "Jenny (UK)",
        "469c630d209e139dd392a66bf4abde4ab86390a0269c1e47b4e5d7ce81526b01",
        "a9a7a93a317c9a3cb6563e37eb057df9ef09c06188a8a4341b0fcb58cba54dd4",
        4895,
    ),
];

impl Catalogue {
    pub fn official() -> Catalogue {
        let voices = VOICES
            .iter()
            .map(|(lang, speaker, name, model_sha, config_sha, config_size)| {
                let key = format!("{lang}-{speaker}-medium");
                let url = format!("{VOICES_BASE}/en/{lang}/{speaker}/medium/{key}.onnx");
                VoiceEntry {
                    name: (*name).to_string(),
                    model: FileSpec {
                        url: url.clone(),
                        sha256: (*model_sha).to_string(),
                        size: MODEL_SIZE,
                    },
                    config: FileSpec {
                        url: format!("{url}.json"),
                        sha256: (*config_sha).to_string(),
                        size: *config_size,
                    },
                    key,
                }
            })
            .collect();
        Catalogue {
            runtime: FileSpec {
                url: RUNTIME_URL.into(),
                sha256: RUNTIME_SHA256.into(),
                size: RUNTIME_SIZE,
            },
            voices,
        }
    }
}

/// `%APPDATA%\o2i\tts` (`.\o2i\tts` without `APPDATA`, like the config and log dirs).
pub fn default_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
        .join("o2i")
        .join("tts")
}

/// Fetches one URL into a file.
pub trait Downloader: Send + Sync {
    /// Download `url` to `dest` (created or truncated). Fails if the body
    /// would exceed `max_size` bytes. `progress` gets the byte count of each
    /// chunk written.
    fn fetch(&self, url: &str, dest: &Path, max_size: u64, progress: &mut dyn FnMut(u64)) -> Result<(), String>;
}

/// Runs the Piper executable.
pub trait Runner: Send + Sync {
    /// Run `exe` in `cwd` with `args`, write `stdin` to it, and return its
    /// stdout. A non-zero exit, a run longer than `timeout` (the child is
    /// killed) or too much output is an error.
    fn run(&self, exe: &Path, cwd: &Path, args: &[String], stdin: &[u8], timeout: Duration) -> Result<Vec<u8>, String>;
}

/// HTTPS downloads through `ureq` (rustls).
pub struct HttpsDownloader;

impl Downloader for HttpsDownloader {
    fn fetch(&self, url: &str, dest: &Path, max_size: u64, progress: &mut dyn FnMut(u64)) -> Result<(), String> {
        if !url.starts_with("https://") {
            return Err("Only HTTPS downloads are allowed".into());
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(CONNECT_TIMEOUT)
            .timeout_read(READ_TIMEOUT)
            .redirects(5)
            .https_only(true)
            .build();
        let resp = agent.get(url).call().map_err(|e| format!("Download failed: {e}"))?;
        let declared = resp
            .header("Content-Length")
            .and_then(|v| v.trim().parse::<u64>().ok());
        if declared.is_some_and(|n| n > max_size) {
            return Err("Download is larger than expected".into());
        }
        let mut reader = resp.into_reader();
        let mut file = File::create(dest).map_err(|e| format!("Could not write the download: {e}"))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > max_size {
                return Err("Download is larger than expected".into());
            }
            file.write_all(&buf[..n])
                .map_err(|e| format!("Could not write the download: {e}"))?;
            progress(n as u64);
        }
        file.flush().map_err(|e| format!("Could not write the download: {e}"))?;
        Ok(())
    }
}

/// Real child processes: no shell, an argument array, no console window.
pub struct SystemRunner;

impl Runner for SystemRunner {
    fn run(&self, exe: &Path, cwd: &Path, args: &[String], stdin: &[u8], timeout: Duration) -> Result<Vec<u8>, String> {
        let mut cmd = Command::new(exe);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not start the voice: {e}"))?;
        let mut child_in = child.stdin.take();
        let Some(mut child_out) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Could not start the voice".into());
        };
        let text = stdin.to_vec();
        let writer = thread::spawn(move || {
            if let Some(w) = child_in.as_mut() {
                let _ = w.write_all(&text);
            }
            // Dropping stdin closes it, which tells Piper the text is complete.
        });
        let overflow = Arc::new(AtomicBool::new(false));
        let over = overflow.clone();
        let reader = thread::spawn(move || {
            let mut buf = Vec::new();
            let r = (&mut child_out).take(MAX_PCM_BYTES as u64 + 1).read_to_end(&mut buf);
            if buf.len() > MAX_PCM_BYTES {
                over.store(true, Ordering::SeqCst);
            }
            r.map(|_| buf)
        });

        let deadline = Instant::now() + timeout;
        let outcome = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(e) => break Err(format!("Voice failed: {e}")),
            }
            if overflow.load(Ordering::SeqCst) {
                break Err("The voice produced too much audio".to_string());
            }
            if Instant::now() >= deadline {
                break Err("Voice timed out".to_string());
            }
            thread::sleep(Duration::from_millis(10));
        };
        if !matches!(outcome, Ok(_)) {
            let _ = child.kill();
            let _ = child.wait();
        }
        // The pipes are closed by now (exit or kill), so both threads end.
        let _ = writer.join();
        let pcm = reader.join().map_err(|_| "Voice failed".to_string())?;
        let status = outcome?;
        if !status.success() {
            return Err(match status.code() {
                Some(c) => format!("Voice exited with code {c}"),
                None => "Voice exited abnormally".into(),
            });
        }
        pcm.map_err(|e| format!("Could not read the voice output: {e}"))
    }
}

struct Status {
    id: String,
    done: u64,
    total: u64,
}

/// Installer plus synthesizer for the `piper:` voice family.
pub struct Piper {
    dir: PathBuf,
    catalogue: Catalogue,
    downloader: Arc<dyn Downloader>,
    runner: Arc<dyn Runner>,
    status: Mutex<Option<Status>>,
    results: Mutex<Vec<Result<String, String>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn mb(bytes: u64) -> u32 {
    bytes.div_ceil(1024 * 1024) as u32
}

impl Piper {
    pub fn new(
        dir: PathBuf,
        catalogue: Catalogue,
        downloader: Arc<dyn Downloader>,
        runner: Arc<dyn Runner>,
    ) -> Arc<Piper> {
        Arc::new(Piper {
            dir,
            catalogue,
            downloader,
            runner,
            status: Mutex::new(None),
            results: Mutex::new(Vec::new()),
        })
    }

    /// The real catalogue, downloader and runner, under `dir`.
    pub fn system(dir: PathBuf) -> Arc<Piper> {
        Piper::new(dir, Catalogue::official(), Arc::new(HttpsDownloader), Arc::new(SystemRunner))
    }

    fn entry(&self, id: &str) -> Option<&VoiceEntry> {
        let key = id.strip_prefix(PREFIX)?;
        self.catalogue.voices.iter().find(|v| v.key == key)
    }

    fn runtime_dir(&self) -> PathBuf {
        self.dir.join("runtime")
    }

    fn exe(&self) -> PathBuf {
        self.runtime_dir().join("piper.exe")
    }

    fn voices_dir(&self) -> PathBuf {
        self.dir.join("voices")
    }

    fn model_path(&self, e: &VoiceEntry) -> PathBuf {
        self.voices_dir().join(format!("{}.onnx", e.key))
    }

    fn config_path(&self, e: &VoiceEntry) -> PathBuf {
        self.voices_dir().join(format!("{}.onnx.json", e.key))
    }

    /// `(voice id, progress 0..1)` while an install runs.
    pub fn progress(&self) -> Option<(String, f32)> {
        lock(&self.status).as_ref().map(|s| {
            let p = if s.total == 0 { 0.0 } else { (s.done as f64 / s.total as f64).clamp(0.0, 1.0) };
            (s.id.clone(), p as f32)
        })
    }

    /// Finished installs since the last call: `Ok(id)` or `Err(reason)`.
    pub fn take_results(&self) -> Vec<Result<String, String>> {
        std::mem::take(&mut *lock(&self.results))
    }

    /// Start installing voice `id` (and the runtime if missing) on its own
    /// thread. Returns at once; the result arrives through `take_results`.
    /// One install at a time.
    pub fn install(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let Some(entry) = self.entry(id).cloned() else {
            return Err(format!("Unknown voice: {id}"));
        };
        {
            let mut st = lock(&self.status);
            if st.is_some() {
                return Err("A voice is already being installed".into());
            }
            *st = Some(Status {
                id: id.to_string(),
                done: 0,
                total: 0,
            });
        }
        let me = self.clone();
        let spawned = thread::Builder::new().name("o2i-tts-install".into()).spawn(move || {
            // A panic must not leave the installer marked busy forever.
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| me.run_install(&entry)))
                .unwrap_or_else(|_| Err("The installer failed".to_string()));
            // Progress clears before the result becomes visible.
            *lock(&me.status) = None;
            lock(&me.results).push(r.map(|()| entry.id()));
        });
        if spawned.is_err() {
            *lock(&self.status) = None;
            return Err("Could not start the installer".into());
        }
        Ok(())
    }

    fn run_install(&self, entry: &VoiceEntry) -> Result<(), String> {
        let mut temps: Vec<PathBuf> = Vec::new();
        let r = self.install_inner(entry, &mut temps);
        if r.is_err() {
            for t in &temps {
                let _ = std::fs::remove_file(t);
                let _ = std::fs::remove_dir_all(t);
            }
        }
        r
    }

    fn download(&self, spec: &FileSpec, dest: &Path) -> Result<(), String> {
        let id = lock(&self.status).as_ref().map(|s| s.id.clone()).unwrap_or_default();
        let mut progress = |n: u64| {
            if let Some(s) = lock(&self.status).as_mut() {
                if s.id == id {
                    s.done += n;
                }
            }
        };
        self.downloader.fetch(&spec.url, dest, spec.size, &mut progress)?;
        verify(dest, spec)
    }

    fn install_inner(&self, entry: &VoiceEntry, temps: &mut Vec<PathBuf>) -> Result<(), String> {
        let io = |what: &str, e: std::io::Error| format!("{what}: {e}");
        let voices_dir = self.voices_dir();
        std::fs::create_dir_all(&voices_dir).map_err(|e| io("Could not create the voice folder", e))?;
        let runtime_part = self.dir.join("runtime.zip.part");
        let runtime_tmp = self.dir.join("runtime.tmp");
        let model_part = voices_dir.join(format!("{}.onnx.part", entry.key));
        let config_part = voices_dir.join(format!("{}.onnx.json.part", entry.key));
        // Anything left by an earlier crashed run.
        for t in [&runtime_part, &runtime_tmp, &model_part, &config_part] {
            let _ = std::fs::remove_file(t);
            let _ = std::fs::remove_dir_all(t);
        }
        temps.extend([runtime_part.clone(), runtime_tmp.clone(), model_part.clone(), config_part.clone()]);

        let need_runtime = !self.exe().is_file();
        let total = entry.model.size + entry.config.size + if need_runtime { self.catalogue.runtime.size } else { 0 };
        if let Some(s) = lock(&self.status).as_mut() {
            s.total = total;
        }

        if need_runtime {
            self.download(&self.catalogue.runtime, &runtime_part)?;
            extract_runtime(&runtime_part, &runtime_tmp)?;
            let _ = std::fs::remove_file(&runtime_part);
            let runtime = self.runtime_dir();
            if runtime.exists() {
                std::fs::remove_dir_all(&runtime).map_err(|e| io("Could not replace the old runtime", e))?;
            }
            std::fs::rename(&runtime_tmp, &runtime).map_err(|e| io("Could not install the runtime", e))?;
        }

        self.download(&entry.config, &config_part)?;
        self.download(&entry.model, &model_part)?;
        let (model, config) = (self.model_path(entry), self.config_path(entry));
        temps.extend([model.clone(), config.clone()]);
        std::fs::rename(&config_part, &config).map_err(|e| io("Could not install the voice", e))?;
        std::fs::rename(&model_part, &model).map_err(|e| io("Could not install the voice", e))?;
        Ok(())
    }
}

/// Size, then SHA-256, of a downloaded file.
fn verify(path: &Path, spec: &FileSpec) -> Result<(), String> {
    let mut f = File::open(path).map_err(|e| format!("Could not read the download: {e}"))?;
    let len = f.metadata().map_err(|e| format!("Could not read the download: {e}"))?.len();
    if len != spec.size {
        return Err("Downloaded file has the wrong size".into());
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("Could not read the download: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if hex != spec.sha256 {
        return Err("Downloaded file failed the checksum".into());
    }
    Ok(())
}

/// Map an archive entry name to a path relative to the runtime root. Entries
/// must live under `piper/`; absolute paths, `..`, drive prefixes and stream
/// markers (`:`) are rejected. `None` means a root or empty entry (skip).
fn safe_entry(name: &str) -> Result<Option<PathBuf>, String> {
    let unsafe_path = || format!("Runtime archive has an unsafe path: {name}");
    let name = name.replace('\\', "/");
    let Some(rest) = name.strip_prefix("piper/") else {
        return Err(unsafe_path());
    };
    let mut out = PathBuf::new();
    for comp in rest.split('/') {
        if comp.is_empty() || comp == "." {
            continue;
        }
        if comp == ".." || comp.contains(':') {
            return Err(unsafe_path());
        }
        out.push(comp);
    }
    Ok(if out.as_os_str().is_empty() { None } else { Some(out) })
}

/// Unpack the runtime archive into `tmp` (created here). The caller removes
/// `tmp` on failure.
fn extract_runtime(zip_path: &Path, tmp: &Path) -> Result<(), String> {
    let bad = |e: &dyn std::fmt::Display| format!("Could not unpack the runtime: {e}");
    let file = File::open(zip_path).map_err(|e| bad(&e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| bad(&e))?;
    std::fs::create_dir_all(tmp).map_err(|e| bad(&e))?;
    let mut budget = MAX_UNPACKED_BYTES;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| bad(&e))?;
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(format!("Runtime archive has an unsafe path: {}", entry.name()));
        }
        let Some(rel) = safe_entry(entry.name())? else {
            continue;
        };
        let target = tmp.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| bad(&e))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| bad(&e))?;
        }
        let mut out = File::create(&target).map_err(|e| bad(&e))?;
        let copied = std::io::copy(&mut (&mut entry).take(budget + 1), &mut out).map_err(|e| bad(&e))?;
        if copied > budget {
            return Err("Runtime archive is larger than expected".into());
        }
        budget -= copied;
    }
    if !tmp.join("piper.exe").is_file() {
        return Err("Runtime archive has no piper.exe".into());
    }
    Ok(())
}

impl Synth for Piper {
    fn prefix(&self) -> &'static str {
        PREFIX
    }

    /// Cheap: a few `is_file` checks, no scans, hashing or network.
    fn voices(&self) -> Vec<Voice> {
        let runtime = self.exe().is_file();
        self.catalogue
            .voices
            .iter()
            .map(|v| Voice {
                id: v.id(),
                name: v.name.clone(),
                source: "piper",
                installed: runtime && self.model_path(v).is_file() && self.config_path(v).is_file(),
                size_mb: Some(mb(v.model.size + v.config.size)),
            })
            .collect()
    }

    fn synthesize(&self, voice: &str, text: &str, rate: f32) -> Result<Audio, String> {
        let entry = self.entry(voice).ok_or_else(|| format!("Unknown voice: {voice}"))?;
        let (model, config) = (self.model_path(entry), self.config_path(entry));
        if !(self.exe().is_file() && model.is_file() && config.is_file()) {
            return Err(format!("Voice not installed: {voice}"));
        }
        let rate_hz = sample_rate(&config)?;
        let rate = if rate.is_finite() { rate.clamp(0.5, 2.0) } else { 1.0 };
        let args = [
            "--model".to_string(),
            model.to_string_lossy().into_owned(),
            "--config".to_string(),
            config.to_string_lossy().into_owned(),
            "--output_raw".to_string(),
            "--length_scale".to_string(),
            format!("{:.3}", 1.0 / rate),
        ];
        let mut input = text.trim_end().to_string();
        input.push('\n');
        let pcm = self
            .runner
            .run(&self.exe(), &self.runtime_dir(), &args, input.as_bytes(), RUN_TIMEOUT)?;
        let samples: Vec<f32> = pcm
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();
        if samples.is_empty() {
            return Err("The voice produced no audio".into());
        }
        Ok(Audio { samples, rate: rate_hz })
    }
}

/// `audio.sample_rate` of a voice's `.onnx.json`.
fn sample_rate(config: &Path) -> Result<u32, String> {
    let bytes = std::fs::read(config).map_err(|e| format!("Could not read the voice config: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "The voice config is not valid".to_string())?;
    v["audio"]["sample_rate"]
        .as_u64()
        .filter(|r| (8_000..=96_000).contains(r))
        .map(|r| r as u32)
        .ok_or_else(|| "The voice config has no sample rate".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::{Done, Tts};
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    fn sha(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("o2i-piper-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, data) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    const ONNX: &[u8] = b"fake-onnx-model";
    const JSON: &[u8] = br#"{"audio":{"sample_rate":22050}}"#;

    struct Fixture {
        catalogue: Catalogue,
        files: HashMap<String, Vec<u8>>,
    }

    fn fixture(runtime: Vec<u8>) -> Fixture {
        let mut files = HashMap::new();
        files.insert("https://t/rt.zip".to_string(), runtime.clone());
        files.insert("https://t/v.onnx".to_string(), ONNX.to_vec());
        files.insert("https://t/v.onnx.json".to_string(), JSON.to_vec());
        let spec = |url: &str, b: &[u8]| FileSpec {
            url: url.into(),
            sha256: sha(b),
            size: b.len() as u64,
        };
        Fixture {
            catalogue: Catalogue {
                runtime: spec("https://t/rt.zip", &runtime),
                voices: vec![VoiceEntry {
                    key: "v".into(),
                    name: "Test voice".into(),
                    model: spec("https://t/v.onnx", ONNX),
                    config: spec("https://t/v.onnx.json", JSON),
                }],
            },
            files,
        }
    }

    fn good_runtime() -> Vec<u8> {
        zip_bytes(&[
            ("piper/piper.exe", b"exe"),
            ("piper/espeak-ng-data/voices/x", b"data"),
        ])
    }

    struct MockDl {
        files: HashMap<String, Vec<u8>>,
        calls: AtomicUsize,
        /// 0-based call index that writes half the body then fails.
        fail_call: Mutex<Option<usize>>,
        /// Url served with different bytes than catalogued.
        corrupt: Option<String>,
    }

    impl MockDl {
        fn new(files: HashMap<String, Vec<u8>>) -> Arc<MockDl> {
            Arc::new(MockDl {
                files,
                calls: AtomicUsize::new(0),
                fail_call: Mutex::new(None),
                corrupt: None,
            })
        }
    }

    impl Downloader for MockDl {
        fn fetch(
            &self,
            url: &str,
            dest: &Path,
            max_size: u64,
            progress: &mut dyn FnMut(u64),
        ) -> Result<(), String> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            let mut body = self.files.get(url).cloned().ok_or("404")?;
            if self.corrupt.as_deref() == Some(url) {
                body[0] ^= 0xff;
            }
            assert!(body.len() as u64 <= max_size);
            if *self.fail_call.lock().unwrap() == Some(n) {
                std::fs::write(dest, &body[..body.len() / 2]).unwrap();
                progress(body.len() as u64 / 2);
                return Err("connection reset".into());
            }
            std::fs::write(dest, &body).unwrap();
            progress(body.len() as u64);
            Ok(())
        }
    }

    type Seen = (PathBuf, PathBuf, Vec<String>, Vec<u8>);

    /// Runner returning queued outputs (the last repeats), recording its input.
    struct MockRun {
        out: Mutex<Vec<Result<Vec<u8>, String>>>,
        seen: Mutex<Vec<Seen>>,
    }

    impl MockRun {
        fn new(out: Vec<Result<Vec<u8>, String>>) -> Arc<MockRun> {
            Arc::new(MockRun {
                out: Mutex::new(out),
                seen: Mutex::new(Vec::new()),
            })
        }
    }

    impl Runner for MockRun {
        fn run(
            &self,
            exe: &Path,
            cwd: &Path,
            args: &[String],
            stdin: &[u8],
            _timeout: Duration,
        ) -> Result<Vec<u8>, String> {
            self.seen
                .lock()
                .unwrap()
                .push((exe.into(), cwd.into(), args.to_vec(), stdin.to_vec()));
            let mut o = self.out.lock().unwrap();
            if o.len() > 1 {
                o.remove(0)
            } else {
                o[0].clone()
            }
        }
    }

    fn pcm(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    fn wait_install(p: &Piper) -> Result<String, String> {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(r) = p.take_results().into_iter().next() {
                return r;
            }
            assert!(Instant::now() < end, "install did not finish");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn setup(tag: &str, runtime: Vec<u8>) -> (PathBuf, Arc<MockDl>, Arc<Piper>, Arc<MockRun>) {
        let dir = tmp(tag);
        let fx = fixture(runtime);
        let dl = MockDl::new(fx.files.clone());
        let run = MockRun::new(vec![Ok(pcm(&[1000; 2205]))]);
        let piper = Piper::new(dir.clone(), fx.catalogue.clone(), dl.clone(), run.clone());
        (dir, dl, piper, run)
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        let mut v = Vec::new();
        fn walk(d: &Path, root: &Path, v: &mut Vec<String>) {
            let Ok(rd) = std::fs::read_dir(d) else { return };
            for e in rd.flatten() {
                let p = e.path();
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                if rel.ends_with(".part") || rel.ends_with(".tmp") {
                    v.push(rel);
                }
                if p.is_dir() {
                    walk(&p, root, v);
                }
            }
        }
        walk(dir, dir, &mut v);
        v
    }

    #[test]
    fn install_success_writes_files() {
        let (dir, _dl, piper, _run) = setup("ok", good_runtime());
        assert!(!piper.voices()[0].installed);
        piper.install("piper:v").unwrap();
        assert_eq!(wait_install(&piper), Ok("piper:v".to_string()));
        assert!(dir.join("runtime/piper.exe").is_file());
        assert!(dir.join("runtime/espeak-ng-data/voices/x").is_file());
        assert_eq!(std::fs::read(dir.join("voices/v.onnx")).unwrap(), ONNX);
        assert_eq!(std::fs::read(dir.join("voices/v.onnx.json")).unwrap(), JSON);
        assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
        assert!(piper.progress().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_hash_mismatch_cleans_up() {
        let dir = tmp("hash");
        let fx = fixture(good_runtime());
        let dl = Arc::new(MockDl {
            files: fx.files.clone(),
            calls: AtomicUsize::new(0),
            fail_call: Mutex::new(None),
            corrupt: Some("https://t/v.onnx".into()),
        });
        let piper = Piper::new(dir.clone(), fx.catalogue, dl, MockRun::new(vec![Ok(vec![])]));
        piper.install("piper:v").unwrap();
        let err = wait_install(&piper).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!dir.join("voices/v.onnx").exists());
        assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
        assert!(!piper.voices()[0].installed);
        assert!(piper.progress().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_size_mismatch_cleans_up() {
        let dir = tmp("size");
        let mut fx = fixture(good_runtime());
        fx.catalogue.voices[0].model.size += 1;
        let dl = MockDl::new(fx.files.clone());
        let piper = Piper::new(dir.clone(), fx.catalogue, dl, MockRun::new(vec![Ok(vec![])]));
        piper.install("piper:v").unwrap();
        let err = wait_install(&piper).unwrap_err();
        assert!(err.contains("size"), "{err}");
        assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_interrupted_cleans_up_then_retry_ok() {
        let (dir, dl, piper, _run) = setup("intr", good_runtime());
        // Call 0 is the runtime, call 1 the model: it dies half way.
        *dl.fail_call.lock().unwrap() = Some(1);
        piper.install("piper:v").unwrap();
        let err = wait_install(&piper).unwrap_err();
        assert!(err.contains("connection reset"), "{err}");
        assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
        assert!(!piper.voices()[0].installed);
        assert!(piper.progress().is_none());
        // Retry works; the runtime installed by the first run is kept.
        *dl.fail_call.lock().unwrap() = None;
        let before = dl.calls.load(Ordering::SeqCst);
        piper.install("piper:v").unwrap();
        assert_eq!(wait_install(&piper), Ok("piper:v".to_string()));
        assert_eq!(dl.calls.load(Ordering::SeqCst) - before, 2);
        assert!(piper.voices()[0].installed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn piper_voice_listed_installed_after_install() {
        let (dir, _dl, piper, _run) = setup("list", good_runtime());
        let v = piper.voices();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "piper:v");
        assert_eq!(v[0].source, "piper");
        assert!(!v[0].installed);
        assert!(v[0].size_mb.is_some());
        piper.install("piper:v").unwrap();
        wait_install(&piper).unwrap();
        assert!(piper.voices()[0].installed);
        // Without the runtime no voice counts as installed.
        std::fs::remove_dir_all(dir.join("runtime")).unwrap();
        assert!(!piper.voices()[0].installed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_unknown_id_and_busy_error() {
        let (dir, _dl, piper, _run) = setup("busy", good_runtime());
        assert!(piper.install("piper:nope").unwrap_err().contains("Unknown voice"));
        assert!(piper.install("win:x").unwrap_err().contains("Unknown voice"));
        assert!(piper.install("piper:../../x").is_err());
        // Hold an install open with a downloader that waits for a gate.
        struct Slow(Arc<AtomicUsize>);
        impl Downloader for Slow {
            fn fetch(&self, _: &str, _: &Path, _: u64, _: &mut dyn FnMut(u64)) -> Result<(), String> {
                while self.0.load(Ordering::SeqCst) == 0 {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err("stopped".into())
            }
        }
        let gate = Arc::new(AtomicUsize::new(0));
        let fx = fixture(good_runtime());
        let p2 = Piper::new(
            dir.join("b"),
            fx.catalogue,
            Arc::new(Slow(gate.clone())),
            MockRun::new(vec![Ok(vec![])]),
        );
        p2.install("piper:v").unwrap();
        let (id, prog) = p2.progress().unwrap();
        assert_eq!(id, "piper:v");
        assert!((0.0..=1.0).contains(&prog));
        assert!(p2.install("piper:v").unwrap_err().contains("already"));
        gate.store(1, Ordering::SeqCst);
        assert!(wait_install(&p2).is_err());
        assert!(p2.progress().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_escape_entries_are_rejected() {
        for (i, bad) in [
            "piper/../evil.txt",
            "/abs.txt",
            "C:/evil.txt",
            "piper/a/../../../evil.txt",
            "other/x",
            "piper/C:/x",
        ]
        .iter()
        .enumerate()
        {
            let dir = tmp(&format!("zipbad{i}")).join("tts");
            let rt = zip_bytes(&[("piper/piper.exe", b"exe"), (bad, b"x")]);
            let fx = fixture(rt);
            let dl = MockDl::new(fx.files.clone());
            let piper = Piper::new(dir.clone(), fx.catalogue, dl, MockRun::new(vec![Ok(vec![])]));
            piper.install("piper:v").unwrap();
            let err = wait_install(&piper).unwrap_err();
            assert!(err.contains("unsafe"), "{bad}: {err}");
            assert!(!dir.join("runtime").exists(), "{bad}");
            let parent = dir.parent().unwrap();
            assert!(!parent.join("evil.txt").exists(), "{bad}");
            assert!(!dir.join("evil.txt").exists(), "{bad}");
            assert!(leftovers(&dir).is_empty(), "{bad}: {:?}", leftovers(&dir));
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn runtime_without_exe_is_rejected() {
        let (dir, _dl, piper, _run) = setup("noexe", zip_bytes(&[("piper/readme.txt", b"x")]));
        piper.install("piper:v").unwrap();
        assert!(wait_install(&piper).is_err());
        assert!(!dir.join("runtime").exists());
        assert!(leftovers(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn wait_done(tts: &Tts) -> Done {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(d) = tts.poll().into_iter().next() {
                return d;
            }
            assert!(Instant::now() < end, "no tts result");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn speak_piper_uses_runner() {
        let (dir, _dl, piper, run) = setup("speak", good_runtime());
        piper.install("piper:v").unwrap();
        wait_install(&piper).unwrap();
        let tts = Tts::new(vec![piper.clone()]);
        assert!(tts.knows_voice("piper:v"));
        tts.submit("piper:v", "Hello there", 2.0).unwrap();
        let Done::Ready(p) = wait_done(&tts) else {
            panic!("expected audio");
        };
        // 2205 samples at 22.05 kHz = 0.1 s = 4800 frames at 48 kHz.
        let frames = p.stream.total_frames().unwrap();
        assert!((frames as i64 - 4800).abs() < 64, "{frames}");
        let seen = run.seen.lock().unwrap();
        let (exe, cwd, args, stdin) = &seen[0];
        assert_eq!(exe, &dir.join("runtime/piper.exe"));
        assert_eq!(cwd, &dir.join("runtime"));
        assert_eq!(
            args,
            &[
                "--model".to_string(),
                dir.join("voices").join("v.onnx").to_string_lossy().into_owned(),
                "--config".to_string(),
                dir.join("voices").join("v.onnx.json").to_string_lossy().into_owned(),
                "--output_raw".to_string(),
                "--length_scale".to_string(),
                "0.500".to_string(),
            ]
        );
        assert_eq!(stdin, b"Hello there\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn speak_uninstalled_piper_errors() {
        let (dir, _dl, piper, run) = setup("unin", good_runtime());
        let tts = Tts::new(vec![piper.clone()]);
        assert!(!tts.knows_voice("piper:v"));
        // Straight to the synthesizer anyway: it refuses and never runs.
        let err = piper.synthesize("piper:v", "hi", 1.0).err().unwrap();
        assert!(err.contains("not installed"), "{err}");
        assert!(run.seen.lock().unwrap().is_empty());
        let err = piper.synthesize("piper:nope", "hi", 1.0).err().unwrap();
        assert!(err.contains("Unknown voice"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn piper_failures_become_errors() {
        let (dir, _dl, piper, run) = setup("fail", good_runtime());
        piper.install("piper:v").unwrap();
        wait_install(&piper).unwrap();
        *run.out.lock().unwrap() = vec![Ok(vec![])];
        assert!(piper.synthesize("piper:v", "hi", 1.0).err().unwrap().contains("no audio"));
        *run.out.lock().unwrap() = vec![Err("Voice exited with code 1".into())];
        assert!(piper.synthesize("piper:v", "hi", 1.0).err().unwrap().contains("code 1"));
        // A config without a sample rate.
        std::fs::write(dir.join("voices/v.onnx.json"), b"{}").unwrap();
        *run.out.lock().unwrap() = vec![Ok(pcm(&[1; 10]))];
        assert!(piper.synthesize("piper:v", "hi", 1.0).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn piper_hang_times_out_then_next_speak_works() {
        let (dir, _dl, piper, run) = setup("hang", good_runtime());
        piper.install("piper:v").unwrap();
        wait_install(&piper).unwrap();
        *run.out.lock().unwrap() = vec![Err("Voice timed out".into()), Ok(pcm(&[1000; 2205]))];
        let tts = Tts::new(vec![piper.clone()]);
        tts.submit("piper:v", "one", 1.0).unwrap();
        match wait_done(&tts) {
            Done::Failed(m) => assert!(m.contains("timed out"), "{m}"),
            Done::Ready(_) => panic!("should fail"),
        }
        tts.submit("piper:v", "two", 1.0).unwrap();
        assert!(matches!(wait_done(&tts), Done::Ready(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn system_runner_kills_hung_child_and_reaps() {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let ping = PathBuf::from(&sys).join(r"System32\ping.exe");
        let cwd = std::env::temp_dir();
        let t = Instant::now();
        let err = SystemRunner
            .run(
                &ping,
                &cwd,
                &["-n".into(), "30".into(), "127.0.0.1".into()],
                b"",
                Duration::from_millis(400),
            )
            .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
        // The next run still works and returns stdout.
        let out = SystemRunner
            .run(&ping, &cwd, &["-n".into(), "1".into(), "127.0.0.1".into()], b"", Duration::from_secs(20))
            .unwrap();
        assert!(!out.is_empty());
        // A non-zero exit is an error.
        let err = SystemRunner
            .run(&ping, &cwd, &["-bogus-flag".into()], b"", Duration::from_secs(20))
            .unwrap_err();
        assert!(err.contains("code"), "{err}");
    }

    /// Live check against the official hosts (about 85 MB). Run by hand:
    /// `cargo test live_install -- --ignored --nocapture`. Uses a temp dir and
    /// never plays audio.
    #[test]
    #[ignore]
    fn live_install_and_synthesize() {
        let dir = tmp("live");
        let piper = Piper::system(dir.clone());
        let id = Catalogue::official().voices[0].id();
        piper.install(&id).unwrap();
        let end = Instant::now() + Duration::from_secs(600);
        let r = loop {
            if let Some(r) = piper.take_results().into_iter().next() {
                break r;
            }
            assert!(Instant::now() < end, "live install timed out");
            std::thread::sleep(Duration::from_millis(250));
        };
        let res = r.and_then(|_| {
            assert!(piper.voices().iter().any(|v| v.id == id && v.installed));
            let t = Instant::now();
            let a = piper.synthesize(&id, "Testing one two three.", 1.0)?;
            println!("synth: {} samples at {} Hz in {:?}", a.samples.len(), a.rate, t.elapsed());
            assert!(a.samples.len() > 10_000);
            assert!(a.samples.iter().any(|s| s.abs() > 0.01));
            Ok(())
        });
        let _ = std::fs::remove_dir_all(&dir);
        res.unwrap();
    }

    #[test]
    fn real_catalogue_is_well_formed() {
        let c = Catalogue::official();
        assert!(c.voices.len() >= 5);
        let mut keys = std::collections::HashSet::new();
        let check = |f: &FileSpec| {
            assert!(f.url.starts_with("https://"));
            assert_eq!(f.sha256.len(), 64);
            assert!(f.sha256.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
            assert!(f.size > 0);
        };
        check(&c.runtime);
        for v in &c.voices {
            assert!(keys.insert(v.key.clone()));
            assert!(v.key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
            check(&v.model);
            check(&v.config);
            assert!(v.model.url.contains("/resolve/v1.0.0/"));
        }
    }
}
