//! A native MATLAB session, driven over a file-based request/response REPL.
//!
//! Unlike a Jupyter kernel there is no ZMQ wire protocol for MATLAB, and on
//! Windows `matlab.exe` is a *launcher* that detaches from piped stdin — so the
//! usual "spawn + talk over stdio" approach does not survive. Instead we launch
//! one long-lived MATLAB process running a tiny supervisor loop ([`ARIS_REPL_M`])
//! that watches a per-session temp directory:
//!   - Rust writes the next cell's code to `request.m` (atomic rename).
//!   - MATLAB runs it in the **base** workspace via `evalc(evalin('base', …))`,
//!     captures command-window text, exports any open figures to base64 PNGs,
//!     and writes `response.json` (atomic rename).
//!   - Rust polls for `response.json`, parses it, maps it to [`CellOutput`]s.
//!
//! State (variables, paths) lives in MATLAB's base workspace and persists across
//! cells for free, exactly like a Jupyter kernel. Startup is ~10–20s (one MATLAB
//! boot); subsequent cells are sub-second plus the cell's own work.
//!
//! The launcher detaches, so the *real* MATLAB pid is written to a `pid` file by
//! the supervisor and used for managed-process registration + termination.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::kernel::{CellOutput, ExecStatus, ExecuteOutcome, OutputCallback};
use crate::NotebookError;

const READY_TIMEOUT: Duration = Duration::from_secs(90);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The MATLAB supervisor loop, written into the session dir and launched with
/// `-r "aris_repl('<dir>')"`. Single-quoted MATLAB strings; keep it ASCII.
const ARIS_REPL_M: &str = r"function aris_repl(d)
  set(groot, 'defaultFigureVisible', 'off');
  format compact;
  fid = fopen(fullfile(d, 'pid'), 'w'); fprintf(fid, '%d', feature('getpid')); fclose(fid);
  fid = fopen(fullfile(d, 'ready'), 'w'); fprintf(fid, '1'); fclose(fid);
  logf = fullfile(d, 'stream.log');
  while true
    req = fullfile(d, 'request.m');
    if isfile(req)
      try
        code = fileread(req, 'Encoding', 'UTF-8');
      catch
        pause(0.02); continue;
      end
      delete(req);
      if isfile(logf), delete(logf); end
      err = '';
      % `diary` mirrors command-window output to a file that flushes
      % incrementally, so the Rust side can tail it for live streaming.
      diary(logf);
      try
        evalin('base', code);
      catch e
        err = getReport(e, 'extended', 'hyperlinks', 'off');
      end
      diary off;
      out = '';
      if isfile(logf)
        try, out = fileread(logf, 'Encoding', 'UTF-8'); catch, end
      end
      imgs = {};
      figs = findall(groot, 'Type', 'figure');
      for k = 1:numel(figs)
        try
          p = [tempname '.png'];
          exportgraphics(figs(k), p);
          bytes = fread(fopen(p), Inf, '*uint8');
          imgs{end+1} = char(matlab.net.base64encode(bytes)); %#ok<AGROW>
          delete(p);
        catch
        end
      end
      close all;
      resp = struct('status', aris_tern(isempty(err), 'ok', 'error'), ...
                    'stdout', out, 'error', err, 'images', {imgs});
      tmp = fullfile(d, 'response.tmp');
      fid = fopen(tmp, 'w', 'n', 'UTF-8'); fprintf(fid, '%s', jsonencode(resp)); fclose(fid);
      movefile(tmp, fullfile(d, 'response.json'), 'f');
    end
    pause(0.03);
  end
end

function r = aris_tern(c, a, b)
  if c, r = a; else, r = b; end
end
";

/// MATLAB analogue of the Python variable-inspection snippet: walk `whos` in the
/// base workspace, emit a JSON array behind the same `__ARIS_VARS_JSON__`
/// sentinel the desktop layer already scans for. MATLAB identifiers must start
/// with a letter (a leading `_` is a syntax error), so the temps are
/// `arisInspect`-prefixed; they are created after the `whos` snapshot, filtered
/// out defensively, and cleared at the end so they never pollute the workspace.
pub const VAR_INSPECT_CODE: &str = r"arisInspectT = whos;
arisInspectT(strcmp({arisInspectT.name}, 'ans') | startsWith({arisInspectT.name}, 'arisInspect')) = [];
if isempty(arisInspectT)
  disp('__ARIS_VARS_JSON__[]');
else
  arisInspectR = arrayfun(@(x) sprintf('%s %s', strjoin(string(x.size), 'x'), x.class), arisInspectT, 'UniformOutput', false);
  arisInspectV = struct('name', {arisInspectT.name}, 'type', {arisInspectT.class}, 'repr', arisInspectR(:)', 'shape', {arisInspectT.size});
  disp(['__ARIS_VARS_JSON__' jsonencode(arisInspectV)]);
end
clear arisInspectT arisInspectR arisInspectV
";

/// The kernel name reported for the native MATLAB backend.
pub const KERNEL_NAME: &str = "matlab";

/// Whether `name` selects the native MATLAB backend rather than a Jupyter kernel.
pub fn is_matlab_kernel(name: &str) -> bool {
    name.eq_ignore_ascii_case("matlab")
}

/// The MATLAB executable, if one can be located, for kernelspec discovery.
pub fn find_matlab() -> Option<PathBuf> {
    matlab_executable()
}

/// One MATLAB-side response, parsed from `response.json`.
#[derive(Debug, Deserialize)]
struct MatlabResponse {
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    images: Vec<String>,
}

/// A running native MATLAB session keyed by a notebook path in [`crate::KernelManager`].
pub struct MatlabSession {
    dir: PathBuf,
    pid: u32,
    alive: AtomicBool,
    /// Monotonic per-session execution count (MATLAB has no native one).
    counter: AtomicI64,
    /// Serializes executes — one request file is in flight at a time.
    exec_lock: Mutex<()>,
    _guard: runtime::ManagedProcessGuard,
}

impl MatlabSession {
    /// Launch MATLAB with the supervisor loop and block until it signals ready.
    pub fn start(workdir: &Path) -> Result<Self, NotebookError> {
        let exe = matlab_executable().ok_or_else(|| {
            NotebookError::Kernel(
                "MATLAB not found. Install MATLAB or put `matlab` on PATH.".into(),
            )
        })?;

        let dir = std::env::temp_dir().join(format!("aris-matlab-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("aris_repl.m"), ARIS_REPL_M)?;

        let dir_ml = matlab_path(&dir);
        let start_dir = if workdir.as_os_str().is_empty() {
            dir.clone()
        } else {
            workdir.to_path_buf()
        };

        let mut cmd = Command::new(&exe);
        cmd.arg("-nosplash")
            .arg("-nodesktop")
            .arg("-minimize")
            .arg("-sd")
            .arg(&start_dir)
            .arg("-r")
            .arg(format!("addpath('{dir_ml}'); aris_repl('{dir_ml}')"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        runtime::hide_window(&mut cmd);

        let mut launcher = cmd
            .spawn()
            .map_err(|e| NotebookError::Kernel(format!("spawn MATLAB: {e}")))?;

        // Wait for the supervisor to write `ready`, then read the real pid. On
        // Windows `matlab.exe` is a launcher that exits ~immediately after handing
        // off to the detached MATLAB.exe, so a launcher exit is NOT a failure — the
        // `ready` file (written by the real MATLAB after its ~10–20s boot) is the
        // only readiness signal. We only give up on the overall timeout.
        let ready = dir.join("ready");
        let started = Instant::now();
        while !ready.exists() {
            if started.elapsed() > READY_TIMEOUT {
                let _ = launcher.kill();
                if let Some(pid) = read_pid(&dir) {
                    runtime::terminate_managed_process_tree(pid);
                }
                let _ = std::fs::remove_dir_all(&dir);
                return Err(NotebookError::Kernel(
                    "MATLAB did not become ready within 90s".into(),
                ));
            }
            std::thread::sleep(POLL_INTERVAL);
        }
        let _ = launcher.wait(); // reap the already-exited launcher

        let pid = read_pid(&dir)
            .ok_or_else(|| NotebookError::Kernel("MATLAB became ready but wrote no pid".into()))?;
        let guard = runtime::register_managed_process(
            pid,
            "matlab-kernel",
            runtime::ManagedProcessKind::Mcp,
        );

        Ok(Self {
            dir,
            pid,
            alive: AtomicBool::new(true),
            counter: AtomicI64::new(0),
            exec_lock: Mutex::new(()),
            _guard: guard,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn kernel_name(&self) -> &str {
        KERNEL_NAME
    }

    pub fn language(&self) -> &'static str {
        "matlab"
    }

    pub fn execute(&self, code: &str, timeout: Duration) -> Result<ExecuteOutcome, NotebookError> {
        self.execute_inner(code, timeout, None)
    }

    pub fn execute_streaming(
        &self,
        code: &str,
        timeout: Duration,
        on_output: OutputCallback,
    ) -> Result<ExecuteOutcome, NotebookError> {
        self.execute_inner(code, timeout, Some(on_output))
    }

    fn execute_inner(
        &self,
        code: &str,
        timeout: Duration,
        on_output: Option<OutputCallback>,
    ) -> Result<ExecuteOutcome, NotebookError> {
        let _exec = self.exec_lock.lock().unwrap();
        if !self.alive.load(Ordering::SeqCst) {
            return Err(NotebookError::Kernel(
                "MATLAB session was terminated; restart the kernel".into(),
            ));
        }

        let request = self.dir.join("request.m");
        let request_tmp = self.dir.join("request.tmp");
        let response = self.dir.join("response.json");
        let stream_log = self.dir.join("stream.log");
        let _ = std::fs::remove_file(&response);
        let _ = std::fs::remove_file(&stream_log);

        // Atomic publish so the supervisor never reads a half-written request.
        std::fs::write(&request_tmp, code)?;
        std::fs::rename(&request_tmp, &request)?;

        // Tail the diary log so output appears live (when a callback is given),
        // instead of all-at-once when the cell finishes. The final canonical
        // text still comes from `response.stdout`, so this is preview-only and
        // degrades gracefully if the log can't be read.
        let mut stream_offset: u64 = 0;
        let emit_chunk = |on: &Option<OutputCallback>, offset: &mut u64| {
            if let Some(cb) = on {
                let chunk = read_new_text(&stream_log, offset);
                if !chunk.is_empty() {
                    cb(CellOutput::Stream {
                        name: "stdout".into(),
                        text: chunk,
                    });
                }
            }
        };

        let started = Instant::now();
        loop {
            emit_chunk(&on_output, &mut stream_offset);
            if response.exists() {
                break;
            }
            if started.elapsed() > timeout {
                // A runaway cell can't be interrupted cleanly in a busy MATLAB;
                // terminate the session so the next run starts fresh.
                self.kill();
                return Ok(ExecuteOutcome {
                    status: ExecStatus::Timeout,
                    execution_count: None,
                    outputs: vec![CellOutput::Error {
                        ename: "Timeout".into(),
                        evalue: format!(
                            "MATLAB cell exceeded {}s; session terminated",
                            timeout.as_secs()
                        ),
                        traceback: vec!["Restart the kernel to continue.".into()],
                    }],
                });
            }
            std::thread::sleep(POLL_INTERVAL);
        }
        emit_chunk(&on_output, &mut stream_offset); // drain any trailing output

        let text = std::fs::read_to_string(&response)?;
        let _ = std::fs::remove_file(&response);
        let _ = std::fs::remove_file(&stream_log);
        let parsed: MatlabResponse = serde_json::from_str(&text)
            .map_err(|e| NotebookError::Kernel(format!("parse MATLAB response: {e}")))?;

        let count = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let mut outputs: Vec<CellOutput> = Vec::new();
        // The full stdout is the canonical record written into the cell; the live
        // chunks above were a preview, so it is NOT re-emitted via `on_output`.
        if !parsed.stdout.is_empty() {
            outputs.push(CellOutput::Stream {
                name: "stdout".into(),
                text: parsed.stdout,
            });
        }
        // Images + errors weren't streamed, so emit them once via the callback.
        for b64 in parsed.images {
            let output = CellOutput::DisplayData {
                data: json!({ "image/png": b64 }),
            };
            if let Some(cb) = on_output.as_deref() {
                cb(output.clone());
            }
            outputs.push(output);
        }
        let had_error = !parsed.error.is_empty();
        if had_error {
            let output = CellOutput::Error {
                ename: "MATLABError".into(),
                evalue: parsed.error.lines().next().unwrap_or("").to_string(),
                traceback: parsed.error.lines().map(str::to_string).collect(),
            };
            if let Some(cb) = on_output.as_deref() {
                cb(output.clone());
            }
            outputs.push(output);
        }

        Ok(ExecuteOutcome {
            status: if had_error {
                ExecStatus::Error
            } else {
                ExecStatus::Ok
            },
            execution_count: Some(count),
            outputs,
        })
    }

    /// Best-effort interrupt: a busy MATLAB cannot service a cooperative signal
    /// over the file channel, so we terminate the process. State is lost; the
    /// caller is expected to restart. Mirrors the timeout path.
    pub fn interrupt(&self) -> Result<(), NotebookError> {
        self.kill();
        Ok(())
    }

    pub fn shutdown(&self) -> Result<(), NotebookError> {
        self.kill();
        Ok(())
    }

    fn kill(&self) {
        if self.alive.swap(false, Ordering::SeqCst) {
            runtime::terminate_managed_process_tree(self.pid);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

impl Drop for MatlabSession {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Read bytes appended to `path` since `*offset`, advancing `offset` past them.
/// Returns empty on any error (the file may be momentarily locked by MATLAB's
/// diary writer, or not yet created) — streaming is best-effort.
fn read_new_text(path: &Path, offset: &mut u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() || buf.is_empty() {
        return String::new();
    }
    *offset += buf.len() as u64;
    String::from_utf8_lossy(&buf).into_owned()
}

fn read_pid(dir: &Path) -> Option<u32> {
    std::fs::read_to_string(dir.join("pid"))
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|pid| *pid != 0)
}

/// MATLAB accepts forward slashes on every platform and they avoid the escaping
/// hazard of backslashes inside a single-quoted MATLAB string literal.
fn matlab_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Locate a MATLAB executable: explicit env override, then PATH, then the
/// standard `…/MATLAB/R<year><rel>/bin/matlab[.exe]` install layout (newest first).
fn matlab_executable() -> Option<PathBuf> {
    for var in ["ARIS_MATLAB", "MATLAB"] {
        if let Ok(value) = std::env::var(var) {
            let path = PathBuf::from(value);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    if let Some(found) = which_matlab() {
        return Some(found);
    }
    scan_matlab_installs()
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "matlab.exe"
    } else {
        "matlab"
    }
}

fn which_matlab() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe_name()))
        .find(|candidate| candidate.is_file())
}

/// Scan the standard MATLAB install roots and return the newest `bin/matlab`.
fn scan_matlab_installs() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Ok(value) = std::env::var(var) {
                roots.push(PathBuf::from(value).join("MATLAB"));
            }
        }
        // MATLAB is frequently installed off the system drive (e.g. E:\).
        for drive in ['C', 'D', 'E', 'F', 'G', 'H'] {
            roots.push(PathBuf::from(format!("{drive}:\\Program Files\\MATLAB")));
            roots.push(PathBuf::from(format!(
                "{drive}:\\Program Files (x86)\\MATLAB"
            )));
        }
    } else {
        roots.push(PathBuf::from("/usr/local/MATLAB"));
        roots.push(PathBuf::from("/opt/MATLAB"));
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home).join("MATLAB"));
        }
        // macOS application bundles.
        roots.push(PathBuf::from("/Applications"));
    }

    let mut releases: Vec<(String, PathBuf)> = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // `R2025b`, `MATLAB_R2024a.app`, etc.
            if !name.to_uppercase().contains('R') {
                continue;
            }
            let bin = if cfg!(target_os = "macos") {
                entry.path().join("bin").join("matlab")
            } else {
                entry.path().join("bin").join(exe_name())
            };
            if bin.is_file() {
                releases.push((name, bin));
            }
        }
    }
    // Lexicographic descending order ranks newer releases (R2025 > R2024) first.
    releases.sort_by(|a, b| b.0.cmp(&a.0));
    releases.into_iter().map(|(_, bin)| bin).next()
}

#[cfg(test)]
#[path = "tests/matlab.rs"]
mod tests;
