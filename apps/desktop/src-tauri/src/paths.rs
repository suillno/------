//! 중앙 경로 resolver (docs/design.md 20.4~20.5).
//!
//! 모든 로컬 데이터 경로는 이 모듈을 통해서만 만든다. 사용자 텍스트를 파일명으로 쓰지 않고,
//! UUID는 정규 형식으로 검증하며, 생성한 디렉터리는 정규화 후 data_root 안에 있는지 확인한다.

use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

pub const PRODUCT_DIR: &str = "MeetingAssistant";
/// 개발/테스트 빌드에서만 인정하는 데이터 루트 재정의 변수.
pub const DATA_ROOT_OVERRIDE_VAR: &str = "MEETING_ASSISTANT_DATA_ROOT_OVERRIDE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppEnv {
    Development,
    Test,
    Production,
}

impl AppEnv {
    /// 디버그 빌드는 development, 릴리스 빌드는 production.
    pub fn current() -> Self {
        if cfg!(test) {
            AppEnv::Test
        } else if cfg!(debug_assertions) {
            AppEnv::Development
        } else {
            AppEnv::Production
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AppEnv::Development => "development",
            AppEnv::Test => "test",
            AppEnv::Production => "production",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("LocalAppData 경로를 찾을 수 없습니다")]
    NoLocalAppData,
    #[error("잘못된 식별자 형식입니다")]
    InvalidId,
    #[error("허용된 데이터 폴더 밖의 경로입니다")]
    OutsideRoot,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub struct PathResolver {
    data_root: PathBuf,
}

impl PathResolver {
    /// OS의 LocalAppData 아래 `MeetingAssistant/<environment>`를 사용한다.
    /// 운영 환경에서는 재정의 변수를 무시한다.
    pub fn from_os(env: AppEnv) -> Result<Self, PathError> {
        if env != AppEnv::Production {
            if let Some(root) = std::env::var_os(DATA_ROOT_OVERRIDE_VAR).filter(|v| !v.is_empty()) {
                return Ok(Self::with_root(PathBuf::from(root).join(env.as_str())));
            }
        }
        let base = dirs::data_local_dir().ok_or(PathError::NoLocalAppData)?;
        Ok(Self::with_root(base.join(PRODUCT_DIR).join(env.as_str())))
    }

    pub fn with_root(data_root: PathBuf) -> Self {
        Self { data_root }
    }

    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub fn settings_path(&self) -> PathBuf {
        self.data_root.join("settings.json")
    }

    pub fn global_log_dir(&self) -> PathBuf {
        self.data_root.join("logs")
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.data_root.join("tmp")
    }

    pub fn account_root(&self, user_id: &str) -> Result<PathBuf, PathError> {
        Ok(self.data_root.join("accounts").join(canonical_uuid(user_id)?))
    }

    pub fn db_path(&self, user_id: &str) -> Result<PathBuf, PathError> {
        Ok(self.account_root(user_id)?.join("db").join("cache.sqlite3"))
    }

    pub fn backup_dir(&self, user_id: &str) -> Result<PathBuf, PathError> {
        Ok(self.account_root(user_id)?.join("backups"))
    }

    pub fn log_dir(&self, user_id: &str) -> Result<PathBuf, PathError> {
        Ok(self.account_root(user_id)?.join("logs"))
    }

    pub fn exports_dir(&self, user_id: &str) -> Result<PathBuf, PathError> {
        Ok(self.account_root(user_id)?.join("exports"))
    }

    pub fn analysis_job_dir(&self, user_id: &str, job_id: &str) -> Result<PathBuf, PathError> {
        Ok(self
            .account_root(user_id)?
            .join("analysis")
            .join("jobs")
            .join(canonical_uuid(job_id)?))
    }

    /// 디렉터리를 만들고, 정규화한 실제 경로가 data_root 안에 있는지 확인한다.
    /// junction·심볼릭 링크로 밖을 가리키면 OutsideRoot를 반환한다.
    pub fn ensure_dir(&self, dir: &Path) -> Result<PathBuf, PathError> {
        fs::create_dir_all(&self.data_root)?;
        fs::create_dir_all(dir)?;
        let root = fs::canonicalize(&self.data_root)?;
        let real = fs::canonicalize(dir)?;
        if real.starts_with(&root) {
            Ok(real)
        } else {
            Err(PathError::OutsideRoot)
        }
    }
}

/// 하이픈 포함 소문자 UUID만 허용한다. 다른 표기는 같은 계정이 다른 폴더로 갈 수 있어 거부한다.
fn canonical_uuid(id: &str) -> Result<String, PathError> {
    let parsed = Uuid::try_parse(id).map_err(|_| PathError::InvalidId)?;
    let canonical = parsed.hyphenated().to_string();
    if canonical == id {
        Ok(canonical)
    } else {
        Err(PathError::InvalidId)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b";
    const JOB: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn 계정별_경로를_root_아래에_만든다() {
        let r = PathResolver::with_root(PathBuf::from("root"));
        assert_eq!(
            r.db_path(USER).unwrap(),
            Path::new("root").join("accounts").join(USER).join("db").join("cache.sqlite3")
        );
        assert!(r.analysis_job_dir(USER, JOB).unwrap().ends_with(JOB));
    }

    #[test]
    fn 잘못된_식별자를_거부한다() {
        let r = PathResolver::with_root(PathBuf::from("root"));
        for bad in ["..", "../x", "a/b", "", "3F2B8C1E-9D4A-4B7E-8F1A-2C3D4E5F6A7B", "3f2b8c1e9d4a4b7e8f1a2c3d4e5f6a7b"] {
            assert!(matches!(r.account_root(bad), Err(PathError::InvalidId)), "{bad}");
        }
        assert!(r.analysis_job_dir(USER, "../../etc").is_err());
    }

    #[test]
    fn 한글_공백_경로에서도_동작한다() {
        let tmp = tempfile::tempdir().unwrap();
        let r = PathResolver::with_root(tmp.path().join("회의 데이터").join("test"));
        let dir = r.ensure_dir(&r.backup_dir(USER).unwrap()).unwrap();
        assert!(dir.is_dir());
    }

    #[test]
    fn root_밖의_경로를_거부한다() {
        let tmp = tempfile::tempdir().unwrap();
        let r = PathResolver::with_root(tmp.path().join("root"));
        let outside = tmp.path().join("outside");
        assert!(matches!(r.ensure_dir(&outside), Err(PathError::OutsideRoot)));
        assert!(matches!(
            r.ensure_dir(&r.data_root().join("..").join("escape")),
            Err(PathError::OutsideRoot)
        ));
    }
}
