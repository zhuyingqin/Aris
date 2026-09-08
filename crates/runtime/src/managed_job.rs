//! Whole-tree ownership for the processes we spawn.
//!
//! `taskkill /T` (and a `pgrep -P` walk) only sees a process tree that is still
//! intact: the moment a shell backgrounds a service with `&` or `start /b` and
//! exits, the survivor is re-parented and becomes invisible to both. It then
//! outlives the app with nothing tracking it.
//!
//! Windows solves this with a Job Object: every descendant joins the job
//! automatically, `TerminateJobObject` kills all of them regardless of
//! re-parenting, and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kills them when the
//! last handle closes — including the implicit close when our process dies, so
//! a crash cannot leak a dev server. Unix gets the same guarantees from the
//! process group the spawner already puts each child in (`process_group(0)`).

use std::process::Child;

/// Owns every process spawned under one managed command.
pub(crate) struct ManagedJob {
    #[cfg(windows)]
    handle: platform::JobHandle,
    /// The direct child. Its descendants are what we are really tracking, so it
    /// is filtered out of [`ManagedJob::live_pids`].
    leader: u32,
}

impl ManagedJob {
    /// Create a job and put `child` in it. Returns `None` when the platform
    /// refuses (older Windows in a locked-down job, missing permissions); the
    /// caller then falls back to the best-effort tree walk.
    pub(crate) fn adopt(child: &Child) -> Option<Self> {
        let leader = child.id();
        #[cfg(windows)]
        {
            let handle = platform::create_job()?;
            if !platform::assign(&handle, child) {
                return None;
            }
            Some(Self { handle, leader })
        }
        #[cfg(not(windows))]
        {
            // `configure_managed_command` already made the child a process-group
            // leader, so the group *is* the job.
            Some(Self { leader })
        }
    }

    /// Processes still alive in the job, excluding the direct child. A non-empty
    /// result after the command returned means the shell left a service running.
    pub(crate) fn live_pids(&self) -> Vec<u32> {
        #[cfg(windows)]
        let pids = platform::live_pids(&self.handle);
        #[cfg(not(windows))]
        let pids = platform::process_group_pids(self.leader);
        pids.into_iter()
            .filter(|pid| *pid != self.leader && *pid > 1)
            .collect()
    }

    /// Kill every process in the job, re-parented descendants included.
    pub(crate) fn terminate(&self) {
        #[cfg(windows)]
        platform::terminate(&self.handle);
        #[cfg(not(windows))]
        platform::terminate_process_group(self.leader);
    }
}

#[cfg(windows)]
#[allow(unsafe_code)] // Audited Win32 FFI: Job Objects, per MSDN CreateJobObjectW.
mod platform {
    use std::os::raw::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr;

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_BASIC_PROCESS_ID_LIST: i32 = 3;
    /// Enough for any plausible dev-server tree; a longer list is truncated
    /// rather than retried, and truncation only costs us reporting detail.
    const MAX_REPORTED_PIDS: usize = 256;

    #[repr(C)]
    // Field names mirror IO_COUNTERS in MSDN; renaming them for the lint would
    // make the ABI mapping harder to check.
    #[allow(clippy::struct_field_names)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[repr(C)]
    struct BasicProcessIdList {
        number_of_assigned_processes: u32,
        number_of_process_ids_in_list: u32,
        process_id_list: [usize; 1],
    }

    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn QueryInformationJobObject(
            job: *mut c_void,
            class: i32,
            information: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        fn TerminateJobObject(job: *mut c_void, exit_code: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// Owns the job handle. Closing the last handle is what kills the job's
    /// processes, so dropping this is the app-exit safety net.
    pub(super) struct JobHandle(*mut c_void);

    // SAFETY: a job HANDLE is an opaque kernel handle with no thread affinity;
    // Assign/Query/Terminate/CloseHandle are all thread-safe.
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl Drop for JobHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    pub(super) fn create_job() -> Option<JobHandle> {
        let handle = unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) };
        if handle.is_null() {
            return None;
        }
        let job = JobHandle(handle);
        // SAFETY: a zeroed ExtendedLimitInformation is a valid all-defaults
        // limit block; only the kill-on-close flag is turned on.
        let mut limits: ExtendedLimitInformation = unsafe { std::mem::zeroed() };
        limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let applied = unsafe {
            SetInformationJobObject(
                job.0,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                ptr::from_ref(&limits).cast::<c_void>(),
                u32::try_from(std::mem::size_of::<ExtendedLimitInformation>()).unwrap_or(0),
            )
        };
        (applied != 0).then_some(job)
    }

    pub(super) fn assign(job: &JobHandle, child: &Child) -> bool {
        unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle().cast::<c_void>()) != 0 }
    }

    pub(super) fn live_pids(job: &JobHandle) -> Vec<u32> {
        // usize-aligned storage: the list is an array of usize behind a header.
        let words = std::mem::size_of::<BasicProcessIdList>() / std::mem::size_of::<usize>()
            + MAX_REPORTED_PIDS;
        let mut buffer = vec![0_usize; words];
        let length = u32::try_from(std::mem::size_of_val(buffer.as_slice())).unwrap_or(0);
        let mut returned = 0_u32;
        let queried = unsafe {
            QueryInformationJobObject(
                job.0,
                JOB_OBJECT_BASIC_PROCESS_ID_LIST,
                buffer.as_mut_ptr().cast::<c_void>(),
                length,
                &raw mut returned,
            )
        };
        // A truncated list still reports the entries that fit, so a partial
        // answer is kept rather than discarded.
        if queried == 0 && returned == 0 {
            return Vec::new();
        }
        // SAFETY: the buffer is usize-aligned and at least as large as the
        // header the kernel just filled in.
        let header = unsafe { &*buffer.as_ptr().cast::<BasicProcessIdList>() };
        let count = (header.number_of_process_ids_in_list as usize).min(MAX_REPORTED_PIDS);
        // SAFETY: the kernel wrote `count` ids contiguously from the list field.
        let ids = unsafe {
            std::slice::from_raw_parts(
                ptr::from_ref(&header.process_id_list).cast::<usize>(),
                count,
            )
        };
        ids.iter()
            .filter_map(|pid| u32::try_from(*pid).ok())
            .collect()
    }

    pub(super) fn terminate(job: &JobHandle) {
        unsafe {
            TerminateJobObject(job.0, 1);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::Duration;

    /// Every process in the child's process group, `&`-forked jobs included.
    pub(super) fn process_group_pids(leader: u32) -> Vec<u32> {
        let Ok(output) = Command::new("pgrep")
            .args(["-g", &leader.to_string()])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .collect()
    }

    pub(super) fn terminate_process_group(leader: u32) {
        if leader <= 1 {
            return;
        }
        signal_process_group("-TERM", leader);
        thread::sleep(Duration::from_millis(100));
        signal_process_group("-KILL", leader);
    }

    fn signal_process_group(signal: &str, leader: u32) {
        let _ = Command::new("kill")
            .args([signal, &format!("-{leader}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
#[path = "tests/managed_job.rs"]
mod tests;
