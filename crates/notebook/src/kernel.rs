//! A long-lived Jupyter kernel session driven over `ZeroMQ`.
//!
//! The kernel protocol is async (tokio + `zeromq`), but Aris's tool layer is
//! synchronous. Each [`KernelSession`] therefore owns a dedicated OS thread
//! running a multi-thread tokio runtime; that thread is the *only* owner of the
//! ZMQ sockets and the kernel child process. The synchronous world talks to it
//! through an actor mailbox:
//!   - commands in  : `tokio::mpsc::unbounded` (sync `send`, async `recv` — never
//!     panics regardless of caller context, unlike `blocking_send`)
//!   - replies out  : `std::mpsc` (plain blocking `recv` on the caller thread)
//!
//! Startup is resilient to the Windows port-bind race: `peek_ports` reserves
//! ports with listeners we then release, but a kernel can still hit "address in
//! use" on the just-freed port and exit. We detect that fast and respawn with a
//! fresh port set ([`SPAWN_ATTEMPTS`]).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jupyter_protocol::{
    ConnectionInfo, ExecuteRequest, ExecutionState, InterruptRequest, JupyterMessage,
    JupyterMessageContent, KernelInfoRequest, ReplyStatus, Stdio as JupyterStdio,
};
use jupyter_zmq_client::{
    ClientControlConnection, ClientIoPubConnection, ClientShellConnection, KernelspecDir,
};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::NotebookError;

const SPAWN_ATTEMPTS: u32 = 4;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(6);
const KERNEL_WARMUP: Duration = Duration::from_millis(150);
const REPLY_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const STDERR_CAP: usize = 8192;

/// Raises a `KeyboardInterrupt` in the running kernel. Two transports cover the
/// two platforms, and we fire both unconditionally because each is inert on the
/// other OS:
///   - POSIX: ipykernel's control-channel `interrupt_request` handler does
///     `os.kill(pid, SIGINT)` itself, so sending the message is enough.
///   - Windows: ipykernel logs "Interrupt message not supported on Windows" and
///     ignores the message; the only working path is signalling the
///     `JPY_INTERRUPT_EVENT` the kernel inherited (watched by
///     `ipykernel.parentpoller.ParentPollerWindows`). This handle owns that event.
#[cfg(windows)]
#[allow(unsafe_code)] // Audited Win32 FFI: mirrors jupyter_client/win_interrupt.py.
mod win_interrupt {
    use std::os::raw::c_void;
    use std::os::windows::io::{FromRawHandle, OwnedHandle, RawHandle};
    use std::ptr;

    const DUPLICATE_SAME_ACCESS: u32 = 0x0000_0002;

    #[repr(C)]
    struct SecurityAttributes {
        n_length: u32,
        security_descriptor: *mut c_void,
        inherit_handle: i32,
    }

    extern "system" {
        fn CreateEventW(
            attrs: *mut c_void,
            manual_reset: i32,
            initial_state: i32,
            name: *const u16,
        ) -> *mut c_void;
        fn SetEvent(handle: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetCurrentProcess() -> *mut c_void;
        fn DuplicateHandle(
            src_process: *mut c_void,
            src_handle: *mut c_void,
            tgt_process: *mut c_void,
            tgt_handle: *mut *mut c_void,
            desired_access: u32,
            inherit: i32,
            options: u32,
        ) -> i32;
    }

    /// Owns the parent-side, **non-inheritable** auto-reset event we signal to
    /// interrupt the kernel. The kernel receives the inheritable child handle as
    /// `JPY_INTERRUPT_EVENT`; the parent signals a duplicate that names the same
    /// event object.
    pub struct InterruptHandle {
        signal: *mut c_void,
        child_event: Option<*mut c_void>,
    }

    // SAFETY: a Windows event HANDLE is an opaque kernel handle with no thread
    // affinity; moving it to the control task and signalling from any thread is
    // sound (Set/CloseHandle are thread-safe).
    unsafe impl Send for InterruptHandle {}
    unsafe impl Sync for InterruptHandle {}

    impl InterruptHandle {
        /// Create an inheritable auto-reset, initially-unset event, mirroring
        /// `jupyter_client.win_interrupt.create_interrupt_event`.
        pub fn create() -> Self {
            let mut attrs = SecurityAttributes {
                n_length: std::mem::size_of::<SecurityAttributes>() as u32,
                security_descriptor: ptr::null_mut(),
                inherit_handle: 1,
            };
            let child_event = unsafe {
                CreateEventW(
                    (&mut attrs as *mut SecurityAttributes).cast::<c_void>(),
                    0,
                    0,
                    ptr::null(),
                )
            };
            if child_event.is_null() {
                return Self {
                    signal: ptr::null_mut(),
                    child_event: None,
                };
            }

            let mut signal: *mut c_void = ptr::null_mut();
            let ok = unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    child_event,
                    GetCurrentProcess(),
                    &mut signal,
                    0,
                    0, // parent-side copy does not need to be inheritable
                    DUPLICATE_SAME_ACCESS,
                )
            };
            if ok == 0 || signal.is_null() {
                unsafe {
                    CloseHandle(child_event);
                }
                return Self {
                    signal: ptr::null_mut(),
                    child_event: None,
                };
            }

            Self {
                signal,
                child_event: Some(child_event),
            }
        }

        /// Hand the inheritable event handle to the child's stdin (so Rust's
        /// spawner adds it to the inherited handle set) and pass `raw` via
        /// `JPY_INTERRUPT_EVENT` — that is the value valid inside the child.
        pub fn inheritable_dup(&mut self) -> Option<(usize, OwnedHandle)> {
            let child_event = self.child_event.take()?;
            let raw = child_event as usize;
            // SAFETY: `child_event` is a fresh, owned handle from CreateEventW.
            // Ownership is transferred to `Stdio`, which closes the parent copy
            // after spawn; the child inherits its own copy.
            let owned = unsafe { OwnedHandle::from_raw_handle(child_event as RawHandle) };
            Some((raw, owned))
        }

        pub fn bind_child_handle(&mut self, _pid: u32) {}

        /// Signal the event → raises `KeyboardInterrupt` in the kernel.
        pub fn signal(&self) {
            if !self.signal.is_null() {
                unsafe {
                    SetEvent(self.signal);
                }
            }
        }
    }

    impl Drop for InterruptHandle {
        fn drop(&mut self) {
            if !self.signal.is_null() {
                unsafe {
                    CloseHandle(self.signal);
                }
            }
            if let Some(child_event) = self.child_event {
                unsafe {
                    CloseHandle(child_event);
                }
            }
        }
    }
}

#[cfg(windows)]
use win_interrupt::InterruptHandle;

/// Build the interrupt transport for a kernel about to spawn. Windows wires the
/// inheritable `JPY_INTERRUPT_EVENT`; elsewhere the control message suffices, so
/// the handle is inert.
#[cfg(windows)]
fn prepare_interrupt(cmd: &mut tokio::process::Command) -> InterruptHandle {
    let mut handle = InterruptHandle::create();
    if let Some((raw, owned)) = handle.inheritable_dup() {
        cmd.env("JPY_INTERRUPT_EVENT", raw.to_string());
        // Rust's spawner inherits ONLY the child's stdio handles, so we smuggle
        // the interrupt event in as stdin. ipykernel reads input over the ZMQ
        // stdin channel, not OS stdin, so this slot is otherwise unused.
        cmd.stdin(Stdio::from(owned));
    }
    handle
}

#[cfg(not(windows))]
fn prepare_interrupt(_cmd: &mut tokio::process::Command) -> InterruptHandle {
    InterruptHandle
}

/// Non-Windows interrupt is carried entirely by the control-channel message, so
/// this is an inert placeholder that keeps [`Connected`] platform-uniform.
#[cfg(not(windows))]
struct InterruptHandle;

#[cfg(not(windows))]
impl InterruptHandle {
    fn bind_child_handle(&mut self, _pid: u32) {}

    fn signal(&self) {}
}

/// A single output produced by executing a cell, mapped from the Jupyter
/// `IOPub` stream into a shape that serializes cleanly to nbformat + the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CellOutput {
    Stream {
        name: String,
        text: String,
    },
    ExecuteResult {
        execution_count: Option<i64>,
        data: Value,
    },
    DisplayData {
        data: Value,
    },
    Error {
        ename: String,
        evalue: String,
        traceback: Vec<String>,
    },
}

impl CellOutput {
    /// Render as an nbformat v4 output object for writing into a `.ipynb`.
    pub fn to_nbformat_json(&self) -> Value {
        match self {
            CellOutput::Stream { name, text } => {
                json!({ "output_type": "stream", "name": name, "text": text })
            }
            CellOutput::ExecuteResult {
                execution_count,
                data,
            } => json!({
                "output_type": "execute_result",
                "execution_count": execution_count,
                "data": data,
                "metadata": {}
            }),
            CellOutput::DisplayData { data } => {
                json!({ "output_type": "display_data", "data": data, "metadata": {} })
            }
            CellOutput::Error {
                ename,
                evalue,
                traceback,
            } => json!({
                "output_type": "error",
                "ename": ename,
                "evalue": evalue,
                "traceback": traceback
            }),
        }
    }
}

/// Terminal status of a single execute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecStatus {
    Ok,
    Error,
    Timeout,
}

/// The full result of executing one cell's source.
#[derive(Debug, Clone, Serialize)]
pub struct ExecuteOutcome {
    pub status: ExecStatus,
    pub execution_count: Option<i64>,
    pub outputs: Vec<CellOutput>,
}

pub type OutputCallback = Box<dyn Fn(CellOutput) + Send + 'static>;

enum Command {
    Execute {
        code: String,
        timeout: Duration,
        on_output: Option<OutputCallback>,
        reply: std::sync::mpsc::Sender<Result<ExecuteOutcome, NotebookError>>,
    },
    Shutdown {
        reply: std::sync::mpsc::Sender<()>,
    },
}

/// A handle to a running kernel. Lifetime is managed by [`crate::KernelManager`].
pub struct KernelSession {
    cmd_tx: tokio::sync::mpsc::UnboundedSender<Command>,
    /// Out-of-band interrupt channel: never blocked by an in-flight execute, so a
    /// runaway cell can be stopped while the execute mailbox is busy.
    int_tx: tokio::sync::mpsc::UnboundedSender<()>,
    pid: u32,
    kernel_name: String,
}

impl KernelSession {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn kernel_name(&self) -> &str {
        &self.kernel_name
    }

    /// Launch a kernel and block until it has completed a `kernel_info` handshake
    /// (or failed). `kernel_name` selects a kernelspec; `None` auto-picks Python.
    pub fn start(kernel_name: Option<&str>, workdir: &Path) -> Result<Self, NotebookError> {
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<Command>();
        let (int_tx, int_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let (ready_tx, ready_rx) =
            std::sync::mpsc::channel::<Result<(u32, String), NotebookError>>();
        let kernel_name = kernel_name.map(str::to_string);
        let workdir = workdir.to_path_buf();

        std::thread::Builder::new()
            .name("aris-kernel".into())
            .spawn(move || {
                // Multi-thread runtime: the async `zeromq` backend tasks must make
                // progress concurrently with the connect/handshake futures.
                let rt = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = ready_tx.send(Err(NotebookError::Kernel(format!(
                            "build kernel runtime: {e}"
                        ))));
                        return;
                    }
                };
                rt.block_on(kernel_main(kernel_name, workdir, ready_tx, cmd_rx, int_rx));
            })
            .map_err(|e| NotebookError::Kernel(format!("spawn kernel thread: {e}")))?;

        match ready_rx.recv() {
            Ok(Ok((pid, name))) => Ok(Self {
                cmd_tx,
                int_tx,
                pid,
                kernel_name: name,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(NotebookError::Kernel(
                "kernel thread exited during startup".into(),
            )),
        }
    }

    /// Execute a snippet, blocking until the kernel goes idle (or `timeout`).
    pub fn execute(&self, code: &str, timeout: Duration) -> Result<ExecuteOutcome, NotebookError> {
        self.execute_inner(code, timeout, None)
    }

    /// Execute a snippet and call `on_output` as each IOPub output arrives.
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
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.cmd_tx
            .send(Command::Execute {
                code: code.to_string(),
                timeout,
                on_output,
                reply: reply_tx,
            })
            .map_err(|_| NotebookError::Kernel("kernel session has stopped".into()))?;
        reply_rx
            .recv()
            .map_err(|_| NotebookError::Kernel("kernel dropped the reply channel".into()))?
    }

    /// Raise `KeyboardInterrupt` in the kernel, stopping the current execute.
    /// Non-blocking and safe to call while an execute is in flight — the running
    /// `execute` returns with `status = Error` once the kernel reports back idle.
    pub fn interrupt(&self) -> Result<(), NotebookError> {
        self.int_tx
            .send(())
            .map_err(|_| NotebookError::Kernel("kernel session has stopped".into()))
    }

    /// Ask the kernel to stop. Idempotent.
    pub fn shutdown(&self) -> Result<(), NotebookError> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        if self
            .cmd_tx
            .send(Command::Shutdown { reply: reply_tx })
            .is_err()
        {
            return Ok(());
        }
        let _ = reply_rx.recv();
        Ok(())
    }
}

/// A started + handshaked kernel, owned by the actor thread.
struct Connected {
    child: tokio::process::Child,
    iopub: ClientIoPubConnection,
    shell: ClientShellConnection,
    /// Control channel (DEALER): carries `interrupt_request` / `shutdown_request`.
    control: ClientControlConnection,
    /// Windows interrupt event the kernel inherited (inert elsewhere).
    interrupt: InterruptHandle,
    pid: u32,
    kernel_name: String,
    guard: runtime::ManagedProcessGuard,
    conn_path: PathBuf,
}

/// Actor body: owns the kernel child + sockets, services the mailbox.
async fn kernel_main(
    kernel_name: Option<String>,
    workdir: PathBuf,
    ready_tx: std::sync::mpsc::Sender<Result<(u32, String), NotebookError>>,
    mut cmd_rx: tokio::sync::mpsc::UnboundedReceiver<Command>,
    mut int_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    let connected = match start_kernel(kernel_name, &workdir).await {
        Ok(connected) => connected,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };
    let Connected {
        mut child,
        mut iopub,
        mut shell,
        mut control,
        interrupt,
        pid,
        kernel_name,
        guard,
        conn_path,
    } = connected;
    let _guard = guard; // unregisters the pid when this scope ends
    let _ = ready_tx.send(Ok((pid, kernel_name)));

    // Interrupt runs on its own task so it is never blocked behind an in-flight
    // execute on the main mailbox. It owns the control socket + the Windows event.
    let control_task = tokio::spawn(async move {
        while int_rx.recv().await.is_some() {
            interrupt.signal(); // Windows: SetEvent on JPY_INTERRUPT_EVENT
            let request: JupyterMessage = InterruptRequest {}.into();
            let _ = control.send(request).await; // POSIX: kernel does os.kill(SIGINT)
        }
    });

    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            Command::Execute {
                code,
                timeout,
                on_output,
                reply,
            } => {
                let result = execute_one(&mut shell, &mut iopub, code, timeout, on_output).await;
                let _ = reply.send(result);
            }
            Command::Shutdown { reply } => {
                let _ = child.start_kill();
                let _ = reply.send(());
                break;
            }
        }
    }

    control_task.abort();
    let _ = child.start_kill();
    let _ = tokio::fs::remove_file(&conn_path).await;
}

/// Resolve a kernelspec, then spawn + connect with retry over the port race.
async fn start_kernel(
    kernel_name: Option<String>,
    workdir: &Path,
) -> Result<Connected, NotebookError> {
    let spec = resolve_spec(kernel_name).await?;
    let mut last_err = NotebookError::Kernel("kernel did not start".into());
    for attempt in 0..SPAWN_ATTEMPTS {
        match spawn_and_connect(&spec, workdir).await {
            Ok(connected) => return Ok(connected),
            Err(e) => {
                last_err = e;
                tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt + 1))).await;
            }
        }
    }
    Err(last_err)
}

/// Pick the kernelspec. Windows discovery needs the `*_with_jupyter_paths`
/// variants — bare `list_kernelspecs` misses prefix-installed kernels.
async fn resolve_spec(kernel_name: Option<String>) -> Result<KernelspecDir, NotebookError> {
    if let Some(name) = kernel_name {
        jupyter_zmq_client::find_kernelspec_with_jupyter_paths(&name)
            .await
            .map_err(|e| NotebookError::Kernel(format!("kernelspec '{name}' not found: {e}")))
    } else {
        let specs = jupyter_zmq_client::list_kernelspecs_with_jupyter_paths().await;
        specs
            .iter()
            .find(|k| k.kernel_name == "python3")
            .or_else(|| {
                specs
                    .iter()
                    .find(|k| k.kernel_name.to_lowercase().contains("python"))
            })
            .or_else(|| specs.first())
            .cloned()
            .ok_or_else(|| {
                NotebookError::Kernel("no Jupyter kernelspec installed (need ipykernel)".into())
            })
    }
}

/// Build the kernel launch command.
///
/// On Windows, `prepare_interrupt` later installs the `JPY_INTERRUPT_EVENT`
/// handle as the child's stdin handle so Rust's spawn handle list definitely
/// includes it. We leave stdout/stderr inherited because interrupt diagnostics
/// there are less important than keeping the Windows event path reliable.
/// Elsewhere interrupt rides the control message, so we keep piping stderr for
/// start-failure diagnostics.
#[cfg(windows)]
fn build_kernel_command(
    spec: &KernelspecDir,
    conn_path: &Path,
) -> Result<tokio::process::Command, NotebookError> {
    let argv = &spec.kernelspec.argv;
    let program = argv.first().ok_or_else(|| {
        NotebookError::Kernel(format!("kernelspec '{}' has empty argv", spec.kernel_name))
    })?;
    let mut cmd = tokio::process::Command::new(program);
    for arg in &argv[1..] {
        if arg == "{connection_file}" {
            cmd.arg(conn_path);
        } else {
            cmd.arg(arg);
        }
    }
    if let Some(env) = &spec.kernelspec.env {
        cmd.envs(env);
    }
    Ok(cmd) // stdio left inherited on purpose (see doc comment)
}

#[cfg(not(windows))]
fn build_kernel_command(
    spec: &KernelspecDir,
    conn_path: &Path,
) -> Result<tokio::process::Command, NotebookError> {
    spec.clone()
        .command(conn_path, Some(Stdio::piped()), Some(Stdio::null()))
        .map_err(|e| NotebookError::Kernel(format!("build kernel command: {e}")))
}

/// One spawn attempt: fresh ports, spawn the kernel, connect `IOPub` + Shell, and
/// complete a `kernel_info` handshake. On any failure the kernel is killed so the
/// caller can retry cleanly with a new port set.
async fn spawn_and_connect(
    spec: &KernelspecDir,
    workdir: &Path,
) -> Result<Connected, NotebookError> {
    let kernel_name = spec.kernel_name.clone();

    // Reserve ports + write the connection file. We bind our own std TcpListeners
    // rather than the crate's `peek_ports_with_listeners`, which uses async-std
    // listeners: with no async-std reactor running under our tokio runtime, their
    // drop is deferred, so a fast-booting kernel binds the port while our reservation
    // still holds it ("address in use"). std listeners close synchronously on drop.
    let ip = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    let (ports, listeners) = reserve_ports(5)?;
    let connection_info = ConnectionInfo {
        transport: jupyter_protocol::connection_info::Transport::TCP,
        ip: ip.to_string(),
        stdin_port: ports[0],
        control_port: ports[1],
        hb_port: ports[2],
        shell_port: ports[3],
        iopub_port: ports[4],
        signature_scheme: "hmac-sha256".to_string(),
        key: Uuid::new_v4().to_string(),
        kernel_name: Some(kernel_name.clone()),
    };
    let runtime_dir = jupyter_zmq_client::dirs::runtime_dir();
    tokio::fs::create_dir_all(&runtime_dir).await?;
    let conn_path = runtime_dir.join(format!("aris-kernel-{}.json", Uuid::new_v4()));
    tokio::fs::write(&conn_path, serde_json::to_string(&connection_info)?).await?;

    // Spawn the kernel under Aris's managed-process registry.
    let mut cmd = build_kernel_command(spec, &conn_path)?;
    runtime::configure_managed_tokio_command(&mut cmd);
    cmd.current_dir(workdir).kill_on_drop(true);
    // Set up interrupt transport (Windows event) before spawn so the child can
    // inherit the handle named by `JPY_INTERRUPT_EVENT`.
    let mut interrupt = prepare_interrupt(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| NotebookError::Kernel(format!("spawn kernel: {e}")))?;
    drop(listeners); // release reserved ports so the kernel can bind them
    let pid = if let Some(pid) = child.id() {
        pid
    } else {
        let _ = tokio::fs::remove_file(&conn_path).await;
        return Err(NotebookError::Kernel(
            "kernel exited before reporting a pid".into(),
        ));
    };
    interrupt.bind_child_handle(pid);
    let guard = runtime::register_managed_process(
        pid,
        format!("jupyter-kernel:{kernel_name}"),
        runtime::ManagedProcessKind::Mcp,
    );

    // Drain kernel stderr into a capped buffer for diagnostics.
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(mut es) = child.stderr.take() {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut chunk = [0u8; 2048];
            while let Ok(n) = es.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                if let Ok(mut g) = buf.lock() {
                    if g.len() < STDERR_CAP {
                        g.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    }
                }
            }
        });
    }

    // Give the kernel a moment to bind, then bail fast if it already died
    // (the "address in use" path) so the caller retries with new ports.
    tokio::time::sleep(KERNEL_WARMUP).await;
    if let Ok(Some(status)) = child.try_wait() {
        return Err(fail(
            &mut child,
            &stderr_buf,
            &conn_path,
            format!("kernel exited during startup ({status})"),
        )
        .await);
    }

    // Connect IOPub (outputs) + Shell (requests).
    let session_id = Uuid::new_v4().to_string();
    let iopub =
        match jupyter_zmq_client::create_client_iopub_connection(&connection_info, "", &session_id)
            .await
        {
            Ok(socket) => socket,
            Err(e) => {
                return Err(fail(
                    &mut child,
                    &stderr_buf,
                    &conn_path,
                    format!("connect iopub: {e}"),
                )
                .await)
            }
        };
    let identity = match jupyter_zmq_client::peer_identity_for_session(&session_id) {
        Ok(identity) => identity,
        Err(e) => {
            return Err(fail(
                &mut child,
                &stderr_buf,
                &conn_path,
                format!("derive identity: {e}"),
            )
            .await)
        }
    };
    let mut shell = match jupyter_zmq_client::create_client_shell_connection_with_identity(
        &connection_info,
        &session_id,
        identity,
    )
    .await
    {
        Ok(socket) => socket,
        Err(e) => {
            return Err(fail(
                &mut child,
                &stderr_buf,
                &conn_path,
                format!("connect shell: {e}"),
            )
            .await)
        }
    };

    // Control channel: out-of-band interrupt / shutdown, independent of shell.
    let control =
        match jupyter_zmq_client::create_client_control_connection(&connection_info, &session_id)
            .await
        {
            Ok(socket) => socket,
            Err(e) => {
                return Err(fail(
                    &mut child,
                    &stderr_buf,
                    &conn_path,
                    format!("connect control: {e}"),
                )
                .await)
            }
        };

    // kernel_info handshake: confirms liveness and lets the IOPub SUB socket
    // subscribe before the first execute. Race it against kernel death + a timeout.
    let info_req: JupyterMessage = KernelInfoRequest {}.into();
    if let Err(e) = shell.send(info_req).await {
        return Err(fail(
            &mut child,
            &stderr_buf,
            &conn_path,
            format!("send kernel_info: {e}"),
        )
        .await);
    }
    let handshake = async {
        loop {
            let msg = shell
                .read()
                .await
                .map_err(|e| NotebookError::Kernel(format!("read kernel_info: {e}")))?;
            if matches!(msg.content, JupyterMessageContent::KernelInfoReply(_)) {
                return Ok::<(), NotebookError>(());
            }
        }
    };
    let outcome = tokio::select! {
        result = handshake => result,
        () = wait_for_exit(&mut child) => Err(NotebookError::Kernel("kernel exited during handshake".into())),
        () = tokio::time::sleep(HANDSHAKE_TIMEOUT) => Err(NotebookError::Kernel("kernel_info handshake timed out".into())),
    };
    if let Err(e) = outcome {
        return Err(fail(&mut child, &stderr_buf, &conn_path, e.to_string()).await);
    }

    Ok(Connected {
        child,
        iopub,
        shell,
        control,
        interrupt,
        pid,
        kernel_name,
        guard,
        conn_path,
    })
}

/// Kill a half-started kernel and build a diagnostic error carrying its stderr.
async fn fail(
    child: &mut tokio::process::Child,
    stderr_buf: &Arc<Mutex<String>>,
    conn_path: &Path,
    message: String,
) -> NotebookError {
    let _ = child.start_kill();
    let _ = tokio::fs::remove_file(conn_path).await;
    let tail = stderr_buf
        .lock()
        .map(|g| g.trim().to_string())
        .unwrap_or_default();
    if tail.is_empty() {
        NotebookError::Kernel(message)
    } else {
        NotebookError::Kernel(format!("{message}; kernel stderr: {tail}"))
    }
}

/// Reserve `num` free localhost ports, holding them with synchronous std
/// listeners. Dropping the returned listeners releases the ports immediately
/// (unlike async-std listeners under a tokio runtime).
fn reserve_ports(num: usize) -> Result<(Vec<u16>, Vec<std::net::TcpListener>), NotebookError> {
    let mut ports = Vec::with_capacity(num);
    let mut listeners = Vec::with_capacity(num);
    for _ in 0..num {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|e| NotebookError::Kernel(format!("reserve port: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| NotebookError::Kernel(format!("read reserved port: {e}")))?
            .port();
        ports.push(port);
        listeners.push(listener);
    }
    Ok((ports, listeners))
}

/// Resolve once the child process has exited.
async fn wait_for_exit(child: &mut tokio::process::Child) {
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => tokio::time::sleep(Duration::from_millis(80)).await,
        }
    }
}

/// Run one snippet: send on Shell, collect `IOPub` until our request goes Idle.
async fn execute_one(
    shell: &mut ClientShellConnection,
    iopub: &mut ClientIoPubConnection,
    code: String,
    timeout: Duration,
    on_output: Option<OutputCallback>,
) -> Result<ExecuteOutcome, NotebookError> {
    let request: JupyterMessage = ExecuteRequest::new(code).into();
    let request_id = request.header.msg_id.clone();
    shell
        .send(request)
        .await
        .map_err(|e| NotebookError::Kernel(format!("send execute: {e}")))?;

    let mut outputs: Vec<CellOutput> = Vec::new();
    let mut execution_count: Option<i64> = None;
    let mut had_error = false;

    let collect = async {
        loop {
            let msg = iopub
                .read()
                .await
                .map_err(|e| NotebookError::Kernel(format!("read iopub: {e}")))?;
            let ours =
                msg.parent_header.as_ref().map(|h| h.msg_id.as_str()) == Some(request_id.as_str());
            if !ours {
                continue;
            }
            match msg.content {
                JupyterMessageContent::StreamContent(s) => push_output(
                    &mut outputs,
                    CellOutput::Stream {
                        name: stdio_name(&s.name),
                        text: s.text,
                    },
                    on_output.as_deref(),
                ),
                JupyterMessageContent::ExecuteResult(r) => {
                    execution_count = to_i64(&r.execution_count);
                    push_output(
                        &mut outputs,
                        CellOutput::ExecuteResult {
                            execution_count,
                            data: to_value(&r.data),
                        },
                        on_output.as_deref(),
                    );
                }
                JupyterMessageContent::DisplayData(d) => {
                    push_output(
                        &mut outputs,
                        CellOutput::DisplayData {
                            data: to_value(&d.data),
                        },
                        on_output.as_deref(),
                    );
                }
                JupyterMessageContent::ErrorOutput(er) => {
                    had_error = true;
                    push_output(
                        &mut outputs,
                        CellOutput::Error {
                            ename: er.ename,
                            evalue: er.evalue,
                            traceback: er.traceback,
                        },
                        on_output.as_deref(),
                    );
                }
                JupyterMessageContent::ExecuteInput(i) => {
                    execution_count = to_i64(&i.execution_count);
                }
                JupyterMessageContent::Status(st) if st.execution_state == ExecutionState::Idle => {
                    break;
                }
                _ => {}
            }
        }
        Ok::<(), NotebookError>(())
    };

    let timed_out = tokio::time::timeout(timeout, collect).await.is_err();

    // Drain the authoritative shell execute_reply (count + status).
    if let Ok(Ok(reply_msg)) = tokio::time::timeout(REPLY_DRAIN_TIMEOUT, shell.read()).await {
        if let JupyterMessageContent::ExecuteReply(er) = reply_msg.content {
            execution_count = to_i64(&er.execution_count).or(execution_count);
            if matches!(er.status, ReplyStatus::Error) {
                had_error = true;
            }
        }
    }

    let status = if timed_out {
        ExecStatus::Timeout
    } else if had_error {
        ExecStatus::Error
    } else {
        ExecStatus::Ok
    };
    Ok(ExecuteOutcome {
        status,
        execution_count,
        outputs,
    })
}

fn push_output(
    outputs: &mut Vec<CellOutput>,
    output: CellOutput,
    on_output: Option<&(dyn Fn(CellOutput) + Send + 'static)>,
) {
    if let Some(on_output) = on_output {
        on_output(output.clone());
    }
    outputs.push(output);
}

fn stdio_name(stream: &JupyterStdio) -> String {
    match stream {
        JupyterStdio::Stderr => "stderr".to_string(),
        JupyterStdio::Stdout => "stdout".to_string(),
    }
}

/// `ExecutionCount` serializes to a JSON number; pull it out as `i64`.
fn to_i64<T: Serialize>(value: &T) -> Option<i64> {
    serde_json::to_value(value).ok().and_then(|v| v.as_i64())
}

/// `Media` (mime bundle) serializes to a JSON object; keep it as a `Value`.
fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}
