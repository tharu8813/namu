//! Child trees are owned by a Windows Job with kill-on-close.
#[cfg(windows)]
use std::os::windows::{io::AsRawHandle, process::CommandExt};
use std::{
    process::{Child, Command},
    sync::Arc,
};

#[cfg(windows)]
pub struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(windows)]
impl ProcessTree {
    pub fn kill(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(not(windows))]
pub struct ProcessTree(u32);
#[cfg(not(windows))]
impl ProcessTree {
    pub fn kill(&self) {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", self.0)])
            .status();
    }
}
pub fn spawn(command: &mut Command) -> Result<(Child, Arc<ProcessTree>), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::JobObjects::*;
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
        }
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("명령 격리용 Job 생성 실패".into());
            }
            let tree = Arc::new(ProcessTree(job));
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
            {
                return Err("프로세스 트리 보호 설정 실패".into());
            }
            command.creation_flags(0x0800_0000 | 0x0000_0004); // hidden + suspended until attached
            let mut child = command.spawn().map_err(|e| e.to_string())?;
            let handle = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
            if AssignProcessToJobObject(job, handle) == 0 || NtResumeProcess(handle) < 0 {
                let _ = child.kill();
                let _ = child.wait();
                return Err("프로세스 트리 보호 연결 실패 — 실행을 거부했습니다".into());
            }
            Ok((child, tree))
        }
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let child = command.spawn().map_err(|e| e.to_string())?;
        let tree = Arc::new(ProcessTree(child.id()));
        Ok((child, tree))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        process::Stdio,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::System::JobObjects::*;
    fn command() -> Command {
        let mut c = Command::new("cmd.exe");
        c.args(["/D", "/C", "ping.exe -n 30 127.0.0.1 >NUL"]);
        c.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        c
    }
    fn active(tree: &ProcessTree) -> u32 {
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            assert_ne!(
                QueryInformationJobObject(
                    tree.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut()
                ),
                0
            );
            info.ActiveProcesses
        }
    }
    #[test]
    fn stop_owns_and_terminates_child_tree_without_killing_other_job() {
        let (mut parent, tree) = spawn(&mut command()).unwrap();
        let (mut independent, other) = spawn(&mut command()).unwrap();
        let start = Instant::now();
        while active(&tree) < 2 && start.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        let has_child = active(&tree) >= 2;
        tree.kill();
        let _ = parent.wait();
        let independent_alive = independent.try_wait().unwrap().is_none();
        other.kill();
        let _ = independent.wait();
        assert!(has_child, "child never joined parent's job");
        let start = Instant::now();
        while active(&tree) > 0 && start.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(active(&tree), 0);
        assert!(independent_alive);
    }
}
