//! Native approval grants never originate from a webview boolean.
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub struct Grant {
    scope: String,
    operation: String,
    expires: Instant,
    used: AtomicBool,
}
impl Grant {
    pub fn validate(&self, scope: &str, operation: &str) -> Result<(), String> {
        if self.scope != scope
            || self.operation != digest(operation.as_bytes())
            || Instant::now() > self.expires
        {
            return Err("승인이 만료되었거나 프로젝트/작업 내용이 변경되었습니다".into());
        }
        if self.used.swap(true, Ordering::SeqCst) {
            return Err("이미 사용한 승인입니다".into());
        }
        Ok(())
    }
}
pub async fn confirm(scope: &str, operation: &str, detail: &str) -> Result<Grant, String> {
    let accepted = rfd::AsyncMessageDialog::new()
        .set_title("Namu — 작업 승인")
        .set_description(detail)
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await;
    if accepted != rfd::MessageDialogResult::Yes {
        return Err("사용자가 작업을 거부했습니다".into());
    }
    Ok(Grant {
        scope: scope.into(),
        operation: digest(operation.as_bytes()),
        expires: Instant::now() + Duration::from_secs(60),
        used: AtomicBool::new(false),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grant_is_bound_and_expires() {
        let grant = Grant {
            scope: "project-a".into(),
            operation: digest(b"write:a:body"),
            expires: Instant::now() + Duration::from_secs(1),
            used: AtomicBool::new(false),
        };
        assert!(grant.validate("project-a", "write:a:body").is_ok());
        assert!(grant.validate("project-a", "write:a:body").is_err());
        assert!(grant.validate("project-b", "write:a:body").is_err());
        assert!(grant.validate("project-a", "write:a:changed").is_err());
        let expired = Grant {
            expires: Instant::now() - Duration::from_secs(1),
            ..grant
        };
        assert!(expired.validate("project-a", "write:a:body").is_err());
    }
}
