//! Diagnostic engine log: `%APPDATA%\o2i\logs\engine.log`, rotated at 5 MB
//! keeping three files (`engine.log`, `engine.1.log`, `engine.2.log`), so
//! the logs can be attached to a bug report.
//!
//! Two kinds of lines, both one per line (CR/LF in messages become spaces):
//! - plain: `[<unix ms>] <msg>`, every `elog!` diagnostic (also on stderr,
//!   exactly as `eprintln!` printed it before);
//! - events: `[<unix ms>] EVENT <kind> <detail>`, from `event(...)`, file only.
//!
//! Callers only format and `try_send` into a bounded queue drained by a
//! background writer thread: logging never blocks (a full queue drops the
//! line and counts it), never panics, and on any I/O failure the writer
//! disables logging quietly. Never log from per-buffer real-time paths
//! (capture/render/mixer/soundboard mixing loops, DSP blocks): formatting
//! allocates. Thread start/exit is fine. Logs never contain secrets or
//! message content (device/app/file names and paths are fine).
//!
//! Until `init` runs (always in unit tests) `elog!` only prints to stderr and
//! `event` does nothing.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// `eprintln!` that also appends the line to the engine log (when
/// initialised). Thread start/exit and control paths only, never per buffer.
macro_rules! elog {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        eprintln!("{msg}");
        $crate::elog::plain(&msg);
    }};
}

const LOG_FILE: &str = "engine.log";
const LOG_FILE_1: &str = "engine.1.log";
const LOG_FILE_2: &str = "engine.2.log";
/// `engine.log` rotates once it reaches this size.
const MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Lines queued for the writer before new ones are dropped.
const QUEUE_LINES: usize = 1024;
/// How long `flush` waits for the writer.
const FLUSH_TIMEOUT: Duration = Duration::from_millis(500);

static LOGGER: OnceLock<Logger> = OnceLock::new();

enum Msg {
    Line(String),
    /// Write and flush everything queued before this, then ack.
    Flush(SyncSender<()>),
}

/// State shared by the senders and the writer thread.
struct Shared {
    /// False once the log can't be written (logging is then a no-op).
    enabled: AtomicBool,
    /// Lines dropped on a full queue since the writer last reported them.
    dropped: AtomicU64,
}

impl Shared {
    fn new() -> Shared {
        Shared {
            enabled: AtomicBool::new(true),
            dropped: AtomicU64::new(0),
        }
    }
}

pub struct Logger {
    tx: SyncSender<Msg>,
    shared: Arc<Shared>,
    /// The writer thread (`None` if it never started). Only tests join it;
    /// the global logger's writer lives until the process exits.
    #[cfg_attr(not(test), allow(dead_code))]
    handle: Option<JoinHandle<()>>,
}

impl Logger {
    /// Create `dir`, open `dir/engine.log` for appending and start the writer
    /// (rotating at `cap` bytes, queue of `queue` lines). Any failure leaves
    /// a disabled logger. The cap is a parameter only so tests can make it
    /// tiny; `init` always uses `MAX_BYTES`.
    fn open(dir: &Path, cap: u64, queue: usize) -> Logger {
        let shared = Arc::new(Shared::new());
        let (tx, rx) = sync_channel(queue);
        let handle = fs::create_dir_all(dir)
            .and_then(|()| Writer::open(dir, cap))
            .ok()
            .and_then(|writer| {
                let s = shared.clone();
                thread::Builder::new()
                    .name("o2i-log".into())
                    .spawn(move || writer.run(&rx, &s))
                    .ok()
            });
        // No writer: `rx` is gone, so sends would fail anyway.
        if handle.is_none() {
            shared.enabled.store(false, Ordering::Relaxed);
        }
        Logger { tx, shared, handle }
    }

    fn is_enabled(&self) -> bool {
        self.shared.enabled.load(Ordering::Relaxed)
    }

    /// Queue `line`; drop it (counted) if the queue is full. Never blocks.
    fn send(&self, line: String) {
        match self.tx.try_send(Msg::Line(line)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {
                self.shared.enabled.store(false, Ordering::Relaxed);
            }
        }
    }

    fn plain(&self, msg: &str) {
        if self.is_enabled() {
            self.send(format_line(now_ms(), msg));
        }
    }

    fn event(&self, kind: &str, detail: &str) {
        if self.is_enabled() {
            self.send(format_event(now_ms(), kind, detail));
        }
    }

    /// Wait (up to `timeout`) until everything queued so far is written and
    /// flushed. Returns whether the writer confirmed it.
    fn flush(&self, timeout: Duration) -> bool {
        if !self.is_enabled() {
            return false;
        }
        let deadline = Instant::now() + timeout;
        let (ack_tx, ack_rx) = sync_channel(1);
        let mut msg = Msg::Flush(ack_tx);
        loop {
            match self.tx.try_send(msg) {
                Ok(()) => break,
                Err(TrySendError::Full(m)) => {
                    if Instant::now() >= deadline {
                        return false;
                    }
                    msg = m;
                    thread::sleep(Duration::from_millis(1));
                }
                Err(TrySendError::Disconnected(_)) => return false,
            }
        }
        ack_rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_ok()
    }
}

/// The writer thread's side: the open `engine.log` and its size.
struct Writer {
    dir: PathBuf,
    cap: u64,
    /// `None` only briefly while rotating.
    file: Option<BufWriter<File>>,
    size: u64,
}

impl Writer {
    fn open(dir: &Path, cap: u64) -> io::Result<Writer> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(LOG_FILE))?;
        let size = file.metadata()?.len();
        Ok(Writer {
            dir: dir.to_path_buf(),
            cap,
            file: Some(BufWriter::new(file)),
            size,
        })
    }

    /// Write queued lines, flushing whenever the queue runs empty (so the
    /// file is current between bursts); report dropped lines. Ends when every
    /// sender is gone, or on the first I/O error (disabling logging).
    fn run(mut self, rx: &Receiver<Msg>, shared: &Shared) {
        while let Ok(first) = rx.recv() {
            let mut next = Some(first);
            while let Some(msg) = next {
                let ok = match msg {
                    Msg::Line(line) => self.write_line(&line),
                    Msg::Flush(ack) => self.flush().map(|()| {
                        let _ = ack.try_send(());
                    }),
                };
                if ok.is_err() {
                    shared.enabled.store(false, Ordering::Relaxed);
                    return;
                }
                next = rx.try_recv().ok();
            }
            let dropped = shared.dropped.swap(0, Ordering::Relaxed);
            let note = if dropped > 0 {
                let msg = format!("[elog] {dropped} log lines dropped (queue full)");
                self.write_line(&format_line(now_ms(), &msg))
            } else {
                Ok(())
            };
            if note.and_then(|()| self.flush()).is_err() {
                shared.enabled.store(false, Ordering::Relaxed);
                return;
            }
        }
        let _ = self.flush();
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        if self.size >= self.cap {
            self.rotate()?;
        }
        let file = self.file.as_mut().ok_or(io::ErrorKind::NotConnected)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        self.size += line.len() as u64 + 1;
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }

    /// `engine.2.log` removed, `engine.1.log` → `.2`, `engine.log` → `.1`,
    /// then a fresh `engine.log`. The current file is closed first (Windows
    /// can't rename a file open without delete sharing); `fs::rename`
    /// replaces an existing target on Windows, and `.2` is removed first
    /// anyway.
    fn rotate(&mut self) -> io::Result<()> {
        if let Some(mut f) = self.file.take() {
            f.flush()?;
        }
        let path = |name: &str| self.dir.join(name);
        ignore_missing(fs::remove_file(path(LOG_FILE_2)))?;
        ignore_missing(fs::rename(path(LOG_FILE_1), path(LOG_FILE_2)))?;
        fs::rename(path(LOG_FILE), path(LOG_FILE_1))?;
        let fresh = Writer::open(&self.dir, self.cap)?;
        self.file = fresh.file;
        self.size = fresh.size;
        Ok(())
    }
}

/// `Ok` for a missing file (nothing to remove/rename); other errors pass.
fn ignore_missing(r: io::Result<()>) -> io::Result<()> {
    match r {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Start the engine log in `dir` (once per process; later calls do nothing)
/// and log panics there before the default handler runs. If the directory or
/// file can't be opened, logging stays off and `elog!` only prints to stderr.
pub fn init(dir: &Path) {
    let mut fresh = false;
    LOGGER.get_or_init(|| {
        fresh = true;
        Logger::open(dir, MAX_BYTES, QUEUE_LINES)
    });
    if fresh {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let thread = thread::current();
            let name = thread.name().unwrap_or("unnamed");
            event("panic", &format!("thread {name}: {info}"));
            flush();
            previous(info);
        }));
    }
}

/// `<appdata>\o2i\logs`, or `.\o2i\logs` without `APPDATA` (like `config.rs`).
pub fn logs_dir_from(appdata: Option<String>) -> PathBuf {
    PathBuf::from(appdata.unwrap_or_else(|| ".".into()))
        .join("o2i")
        .join("logs")
}

/// The log directory: `%APPDATA%\o2i\logs`.
pub fn default_dir() -> PathBuf {
    logs_dir_from(std::env::var("APPDATA").ok())
}

/// CR/LF → spaces, so one record is always one line.
fn one_line(s: &str) -> std::borrow::Cow<'_, str> {
    if s.contains(['\r', '\n']) {
        s.replace(['\r', '\n'], " ").into()
    } else {
        s.into()
    }
}

/// `[<ms>] <msg>`.
pub fn format_line(ms: u128, msg: &str) -> String {
    format!("[{ms}] {}", one_line(msg))
}

/// `[<ms>] EVENT <kind> <detail>`.
pub fn format_event(ms: u128, kind: &str, detail: &str) -> String {
    format!("[{ms}] EVENT {} {}", one_line(kind), one_line(detail))
}

/// Milliseconds since the Unix epoch (0 if the clock is before it).
pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Append a plain line (no stderr: that's `elog!`'s job).
pub fn plain(msg: &str) {
    if let Some(l) = LOGGER.get() {
        l.plain(msg);
    }
}

/// Append `[<ms>] EVENT <kind> <detail>` to the engine log (file only).
pub fn event(kind: &str, detail: &str) {
    if let Some(l) = LOGGER.get() {
        l.event(kind, detail);
    }
}

/// Wait briefly until queued lines are on disk; call before the process
/// exits (the writer thread dies with it).
pub fn flush() {
    if let Some(l) = LOGGER.get() {
        l.flush(FLUSH_TIMEOUT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Instant;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("o2i-elog-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// Stop the writer and wait until it wrote everything queued.
    fn close(logger: Logger) {
        let Logger { tx, handle, .. } = logger;
        drop(tx);
        if let Some(h) = handle {
            h.join().expect("writer thread must not panic");
        }
    }

    fn lines_of(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// The `n` in a test line `... line <n> ...`.
    fn line_no(line: &str) -> u32 {
        let rest = line.split("line ").nth(1).unwrap();
        rest.split_whitespace().next().unwrap().parse().unwrap()
    }

    #[test]
    fn rotates_at_cap_keeping_three_files() {
        let dir = temp_dir("rotate");
        let cap = 300;
        let logger = Logger::open(&dir, cap, 4096);
        for i in 0..200u32 {
            logger.plain(&format!("line {i} padding-padding"));
        }
        close(logger);

        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["engine.1.log", "engine.2.log", "engine.log"]);

        let cur = lines_of(&dir.join("engine.log"));
        let one = lines_of(&dir.join("engine.1.log"));
        let two = lines_of(&dir.join("engine.2.log"));
        for (name, lines) in [("engine.log", &cur), ("engine.1.log", &one), ("engine.2.log", &two)] {
            assert!(!lines.is_empty(), "{name} is empty");
            let size = fs::metadata(dir.join(name)).unwrap().len();
            // A file only rotates once it reached the cap, so it can exceed it
            // by at most one line.
            assert!(size < cap + 100, "{name} is {size} bytes");
        }
        // Oldest → newest: .2, .1, current; the newest line is in engine.log.
        assert!(line_no(two.last().unwrap()) < line_no(&one[0]));
        assert!(line_no(one.last().unwrap()) < line_no(&cur[0]));
        assert_eq!(line_no(cur.last().unwrap()), 199);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_replaces_existing_rotated_files() {
        let dir = temp_dir("rotate-existing");
        fs::write(dir.join("engine.log"), "x".repeat(400)).unwrap();
        fs::write(dir.join("engine.1.log"), "old one\n").unwrap();
        fs::write(dir.join("engine.2.log"), "old two\n").unwrap();
        let logger = Logger::open(&dir, 300, 64);
        logger.plain("line 1 fresh");
        close(logger);
        assert_eq!(fs::read_to_string(dir.join("engine.1.log")).unwrap(), "x".repeat(400));
        assert_eq!(fs::read_to_string(dir.join("engine.2.log")).unwrap(), "old one\n");
        let cur = lines_of(&dir.join("engine.log"));
        assert_eq!(cur.len(), 1);
        assert!(cur[0].ends_with("] line 1 fresh"), "{cur:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn line_format_has_timestamp_and_kind() {
        assert_eq!(
            format_event(1_700_000_000_123, "audio_start", "input=mic output=cable"),
            "[1700000000123] EVENT audio_start input=mic output=cable"
        );
        assert_eq!(format_line(42, "[engine] hello"), "[42] [engine] hello");
        // One record per line, whatever the message holds.
        assert_eq!(format_line(7, "a\r\nb\nc"), "[7] a  b c");
        assert_eq!(format_event(7, "panic", "x\ny"), "[7] EVENT panic x y");

        // End to end: real timestamps, event + plain lines in order.
        let dir = temp_dir("format");
        let before = now_ms();
        let logger = Logger::open(&dir, 1 << 20, 64);
        logger.event("startup", "o2i 0.1.0 mode=test");
        logger.plain("[test] plain message");
        assert!(logger.flush(Duration::from_secs(5)), "flush must be acknowledged");
        let after = now_ms();
        let lines = lines_of(&dir.join("engine.log"));
        assert_eq!(lines.len(), 2, "{lines:?}");
        for line in &lines {
            let (stamp, _) = line
                .strip_prefix('[')
                .and_then(|l| l.split_once(']'))
                .unwrap_or_else(|| panic!("no timestamp: {line}"));
            let ms: u128 = stamp.parse().unwrap();
            assert!(before <= ms && ms <= after, "{ms} not in {before}..={after}");
        }
        assert!(lines[0].ends_with("] EVENT startup o2i 0.1.0 mode=test"), "{}", lines[0]);
        assert!(lines[1].ends_with("] [test] plain message"), "{}", lines[1]);
        close(logger);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writer_failure_disables_without_panic() {
        // Can't even create the directory: a regular file is in the way.
        let base = temp_dir("fail");
        let blocker = base.join("not-a-dir");
        fs::write(&blocker, "file").unwrap();
        let logger = Logger::open(&blocker.join("logs"), 300, 64);
        assert!(!logger.is_enabled());
        logger.plain("dropped");
        logger.event("startup", "dropped");
        assert!(!logger.flush(Duration::from_millis(200)));
        close(logger);

        // Fails part-way: rotation can't remove engine.2.log (a non-empty
        // directory), so the writer disables itself; later lines are dropped.
        let dir = temp_dir("fail-rotate");
        fs::create_dir_all(dir.join("engine.2.log").join("sub")).unwrap();
        let logger = Logger::open(&dir, 100, 4096);
        assert!(logger.is_enabled());
        for i in 0..50u32 {
            logger.plain(&format!("line {i} padding-padding-padding"));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while logger.is_enabled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!logger.is_enabled(), "a failed rotation must disable logging");
        logger.plain("after failure");
        assert!(!logger.flush(Duration::from_millis(200)));
        close(logger); // joins the writer: it ended without panicking
        let cur = fs::read_to_string(dir.join("engine.log")).unwrap();
        assert!(!cur.contains("after failure"));
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn channel_full_drops_instead_of_blocking() {
        // A writer that never drains: the queue holds 4 lines.
        let (tx, rx) = sync_channel(4);
        let logger = Logger {
            tx,
            shared: Arc::new(Shared::new()),
            handle: None,
        };
        let logger = Arc::new(logger);
        let sender = logger.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for i in 0..10 {
                sender.plain(&format!("line {i}"));
                sender.event("tick", "x");
            }
            let _ = done_tx.send(());
        });
        assert!(
            done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "logging blocked on a full queue"
        );
        assert_eq!(logger.shared.dropped.load(Ordering::Relaxed), 16);
        assert_eq!(rx.try_iter().count(), 4);
        assert!(logger.is_enabled(), "a full queue is not a failure");
    }

    #[test]
    fn dropped_lines_are_reported_once_the_writer_catches_up() {
        let dir = temp_dir("dropped");
        let logger = Logger::open(&dir, 1 << 20, 64);
        logger.shared.dropped.store(3, Ordering::Relaxed);
        logger.plain("line 1 after drops");
        assert!(logger.flush(Duration::from_secs(5)));
        let text = fs::read_to_string(dir.join("engine.log")).unwrap();
        assert!(text.contains("3 log lines dropped"), "{text}");
        close(logger);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn logs_dir_is_under_appdata_with_local_fallback() {
        assert_eq!(
            logs_dir_from(Some(r"C:\Users\x\AppData\Roaming".into())),
            PathBuf::from(r"C:\Users\x\AppData\Roaming\o2i\logs")
        );
        assert_eq!(logs_dir_from(None), PathBuf::from(r".\o2i\logs"));
    }
}
