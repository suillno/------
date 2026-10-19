//! 업로드 전 분석 결과 로컬 저장 (docs/design.md 9장 7단계).
//! 결과를 먼저 원자 저장한 뒤 업로드하므로, 통신이 끊겨도 분석을 다시 하지 않고 업로드만 재시도한다.
//! 위치: accounts/<user>/analysis/jobs/<job>/upload.json (PathResolver로만 만든다).

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::agent::validate::AnalysisResult;
use crate::paths::{PathError, PathResolver};

const UPLOAD_FILE: &str = "upload.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalysisMetadata {
    pub engine_version: String,
    pub prompt_version: String,
    pub input_hash: String,
}

/// 리스 토큰은 120초 동안만 유효한 작업 토큰이며 계정 자격증명이 아니다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavedAnalysis {
    pub job_id: String,
    pub lease_token: String,
    pub source_revision_id: String,
    pub payload: AnalysisResult,
    pub metadata: AnalysisMetadata,
}

fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, dir.join(name))
}

pub fn save(paths: &PathResolver, user_id: &str, saved: &SavedAnalysis) -> Result<(), PathError> {
    let dir = paths.ensure_dir(&paths.analysis_job_dir(user_id, &saved.job_id)?)?;
    let json = serde_json::to_vec_pretty(saved).map_err(|e| PathError::Io(std::io::Error::other(e)))?;
    write_atomic(&dir, UPLOAD_FILE, &json)?;
    Ok(())
}

/// 업로드하지 못한 결과 목록. 읽을 수 없는 파일은 건너뛴다.
pub fn pending(paths: &PathResolver, user_id: &str) -> Result<Vec<SavedAnalysis>, PathError> {
    let jobs = paths.account_root(user_id)?.join("analysis").join("jobs");
    let Ok(entries) = fs::read_dir(&jobs) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 폴더 이름도 resolver 규칙(정규 UUID)을 통과해야 한다
        let Ok(dir) = paths.analysis_job_dir(user_id, &name) else { continue };
        if let Ok(bytes) = fs::read(dir.join(UPLOAD_FILE)) {
            if let Ok(saved) = serde_json::from_slice::<SavedAnalysis>(&bytes) {
                if saved.job_id == name {
                    out.push(saved);
                }
            }
        }
    }
    Ok(out)
}

/// 업로드 완료 또는 서버가 받을 수 없는 결과를 지운다. 작업 폴더 전체를 지운다.
pub fn clear(paths: &PathResolver, user_id: &str, job_id: &str) -> Result<(), PathError> {
    let dir = paths.analysis_job_dir(user_id, job_id)?;
    if dir.exists() {
        let real = paths.ensure_dir(&dir)?;
        fs::remove_dir_all(real)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::validate::AnalysisResult;

    const USER: &str = "3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b";
    const JOB: &str = "00000000-0000-4000-8000-000000000001";

    fn sample() -> SavedAnalysis {
        SavedAnalysis {
            job_id: JOB.into(),
            lease_token: "lease".into(),
            source_revision_id: "rev".into(),
            payload: AnalysisResult { schema_version: 2, summary: "요약".into(), decisions: vec![], action_items: vec![], event_candidates: vec![] },
            metadata: AnalysisMetadata { engine_version: "e".into(), prompt_version: "p".into(), input_hash: "h".into() },
        }
    }

    #[test]
    fn a06_저장한_결과를_다시_읽고_지운다() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = PathResolver::with_root(tmp.path().join("회의 데이터"));
        save(&paths, USER, &sample()).unwrap();
        assert_eq!(pending(&paths, USER).unwrap(), vec![sample()]);
        clear(&paths, USER, JOB).unwrap();
        assert!(pending(&paths, USER).unwrap().is_empty());
    }

    #[test]
    fn 잘못된_작업_id는_저장하지_않는다() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = PathResolver::with_root(tmp.path().to_path_buf());
        let mut bad = sample();
        bad.job_id = "../escape".into();
        assert!(save(&paths, USER, &bad).is_err());
        assert!(clear(&paths, USER, "../../x").is_err());
    }
}
