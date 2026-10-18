//! Claude Code CLI 실행 (docs/adr/0002-claude-cli-invocation.md).
//!
//! - 셸·cmd.exe를 거치지 않고 실행 파일을 인자 배열로 실행한다. `.cmd` 래퍼는 실행하지 않는다.
//! - 회의 원문은 stdin으로만 넘긴다. 인자에는 고정 지시문과 schema만 들어간다.
//! - `--bare`, 권한 우회 플래그를 쓰지 않는다.
//! - 유료 API로 넘어가지 않도록 API 키 계열 환경변수를 자식 프로세스에서 지운다.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

pub const PROMPT: &str = include_str!("../../../../../prompts/meeting-analysis/v1/prompt.md");
pub const PROMPT_VERSION: &str = "meeting-analysis/v1";
/// `npm run gen:contracts`로 packages/contracts에서 생성한다. 직접 수정하지 않는다.
pub const CLI_SCHEMA: &str = include_str!("../../generated/analysis-result-v1.cli-schema.json");

/// 안전 실행에 필요한 플래그. `claude --help`에 하나라도 없으면 자동 실행하지 않는다(CLI_UNSUPPORTED).
pub const REQUIRED_FLAGS: [&str; 8] = [
    "--output-format",
    "--json-schema",
    "--tools",
    "--restricted",
    "--safe-mode",
    "--strict-mcp-config",
    "--permission-prompts",
    "--no-session-persistence",
];

/// 자식 프로세스에서 제거하는 환경변수. 구독 로그인 대신 유료 API·다른 공급자가 선택되는 것을 막는다.
pub const REMOVED_ENV: [&str; 9] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
];

/// 실행 실패 사유. 서버 analysis_jobs.error_code로 그대로 올라간다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureCode {
    CliNotFound,
    CliUnsupported,
    AuthRequired,
    RateLimited,
    Timeout,
    InvalidOutput,
    ToolAttempted,
    CliError,
}

impl FailureCode {
    pub fn as_str(self) -> &'static str {
        match self {
            FailureCode::CliNotFound => "CLI_NOT_FOUND",
            FailureCode::CliUnsupported => "CLI_UNSUPPORTED",
            FailureCode::AuthRequired => "AUTH_REQUIRED",
            FailureCode::RateLimited => "RATE_LIMITED",
            FailureCode::Timeout => "TIMEOUT",
            FailureCode::InvalidOutput => "INVALID_OUTPUT",
            FailureCode::ToolAttempted => "TOOL_ATTEMPTED",
            FailureCode::CliError => "CLI_ERROR",
        }
    }
}

/// 분석 호출 인자. 회의 원문은 들어가지 않는다.
pub fn analysis_args() -> Vec<String> {
    [
        "-p",
        PROMPT,
        "--output-format",
        "json",
        "--json-schema",
        CLI_SCHEMA.trim(),
        "--tools",
        "",
        "--restricted",
        "--safe-mode",
        "--strict-mcp-config",
        "--permission-prompts",
        "none",
        "--no-session-persistence",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

pub fn supports_required_flags(help: &str) -> bool {
    REQUIRED_FLAGS.iter().all(|f| help.contains(f))
}

/// CLI 실행 파일을 찾는다. PATH의 `claude.exe`, npm 전역 설치 래퍼(`claude.cmd`) 옆의 패키지 실행 파일,
/// 네이티브 설치 위치(`%USERPROFILE%\.local\bin`) 순서다. 경로는 실행 시점 환경에서만 계산한다.
pub fn find_cli() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for dir in &path_dirs {
        let direct = dir.join(exe);
        if direct.is_file() {
            return Some(direct);
        }
        let npm_pkg = dir.join("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join(exe);
        if dir.join("claude.cmd").is_file() && npm_pkg.is_file() {
            return Some(npm_pkg);
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let native = PathBuf::from(home).join(".local").join("bin").join(exe);
    native.is_file().then_some(native)
}

pub struct ExecOutput {
    pub status_ok: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExecError {
    NotFound,
    Timeout,
    Io,
}

/// 실제 프로세스 실행을 추상화한다(테스트에서 가짜 CLI 사용).
pub trait CliExecutor: Send + Sync {
    fn run(&self, args: &[String], stdin: &str, cwd: &Path, timeout: Duration) -> Result<ExecOutput, ExecError>;
}

pub struct SystemCli {
    pub program: PathBuf,
}

impl CliExecutor for SystemCli {
    fn run(&self, args: &[String], stdin: &str, cwd: &Path, timeout: Duration) -> Result<ExecOutput, ExecError> {
        let mut cmd = Command::new(&self.program);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for name in REMOVED_ENV {
            cmd.env_remove(name);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { ExecError::NotFound } else { ExecError::Io }
        })?;

        let mut child_stdin = child.stdin.take().ok_or(ExecError::Io)?;
        let input = stdin.to_owned();
        let writer = thread::spawn(move || {
            let _ = child_stdin.write_all(input.as_bytes());
            // drop으로 stdin을 닫아 CLI가 입력 끝을 알게 한다
        });
        let mut out = child.stdout.take().ok_or(ExecError::Io)?;
        let mut err = child.stderr.take().ok_or(ExecError::Io)?;
        let out_reader = thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            s
        });
        let err_reader = thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        });

        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() >= timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ExecError::Timeout);
                }
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(_) => return Err(ExecError::Io),
            }
        };
        let _ = writer.join();
        Ok(ExecOutput {
            status_ok: status.success(),
            stdout: out_reader.join().unwrap_or_default(),
            stderr: err_reader.join().unwrap_or_default(),
        })
    }
}

fn mentions(text: &str, needles: &[&str]) -> bool {
    let lower = text.to_lowercase();
    needles.iter().any(|n| lower.contains(n))
}

fn classify_error_text(text: &str) -> FailureCode {
    if mentions(text, &["rate limit", "usage limit", "429", "limit reached", "quota"]) {
        FailureCode::RateLimited
    } else if mentions(text, &["login", "log in", "authenticat", "401", "unauthorized", "/login"]) {
        FailureCode::AuthRequired
    } else {
        FailureCode::CliError
    }
}

/// `--output-format json` envelope에서 structured_output을 꺼낸다.
/// CLI 종료 코드·`subtype`만으로 성공을 판정하지 않는다(ADR 0002: 빈 schema도 success였다).
pub fn parse_envelope(out: &ExecOutput) -> Result<Value, FailureCode> {
    let envelope: Value = match serde_json::from_str(out.stdout.trim()) {
        Ok(v) => v,
        Err(_) => {
            return Err(if out.status_ok { FailureCode::InvalidOutput } else { classify_error_text(&out.stderr) });
        }
    };
    let is_error = envelope.get("is_error").and_then(Value::as_bool).unwrap_or(true);
    let subtype = envelope.get("subtype").and_then(Value::as_str).unwrap_or("");
    if is_error || subtype != "success" {
        let mut text = envelope.get("result").map(|v| v.to_string()).unwrap_or_default();
        if let Some(s) = envelope.get("api_error_status") {
            text.push(' ');
            text.push_str(&s.to_string());
        }
        text.push(' ');
        text.push_str(&out.stderr);
        return Err(classify_error_text(&text));
    }
    let denials = envelope.get("permission_denials").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    if denials > 0 {
        // 도구가 차단됐더라도 회의 본문의 지시로 도구를 쓰려 했다는 뜻이므로 결과를 쓰지 않는다(A07).
        return Err(FailureCode::ToolAttempted);
    }
    match envelope.get("structured_output") {
        Some(v) if v.is_object() => Ok(v.clone()),
        _ => Err(FailureCode::InvalidOutput),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(stdout: &str) -> ExecOutput {
        ExecOutput { status_ok: true, stdout: stdout.into(), stderr: String::new() }
    }

    #[test]
    fn 고정_인자만_쓰고_위험한_플래그가_없다() {
        let args = analysis_args();
        for banned in ["--bare", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--settings", "--mcp-config", "--add-dir"] {
            assert!(!args.iter().any(|a| a == banned), "{banned}");
        }
        for flag in REQUIRED_FLAGS {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        let tools = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[tools + 1], "", "모든 도구를 끈다");
        assert!(!CLI_SCHEMA.contains("$schema"), "CLI가 거부하는 $schema가 없어야 한다");
    }

    #[test]
    fn 지원_플래그를_확인한다() {
        assert!(supports_required_flags(&REQUIRED_FLAGS.join(" ")));
        assert!(!supports_required_flags("--output-format --tools"));
    }

    #[test]
    fn 유료_api_환경변수를_지운다() {
        assert!(REMOVED_ENV.contains(&"ANTHROPIC_API_KEY"));
        assert!(REMOVED_ENV.contains(&"ANTHROPIC_AUTH_TOKEN"));
    }

    #[test]
    fn 정상_envelope에서_structured_output을_꺼낸다() {
        let v = parse_envelope(&out(r#"{"type":"result","subtype":"success","is_error":false,"permission_denials":[],"structured_output":{"schema_version":1}}"#)).unwrap();
        assert_eq!(v["schema_version"], 1);
    }

    #[test]
    fn 성공_표시여도_structured_output이_없으면_실패다() {
        let e = parse_envelope(&out(r#"{"type":"result","subtype":"success","is_error":false,"result":"free text"}"#));
        assert_eq!(e, Err(FailureCode::InvalidOutput));
    }

    #[test]
    fn 도구_사용_시도는_결과를_버린다() {
        let e = parse_envelope(&out(r#"{"subtype":"success","is_error":false,"permission_denials":[{"tool_name":"Bash"}],"structured_output":{}}"#));
        assert_eq!(e, Err(FailureCode::ToolAttempted));
    }

    #[test]
    fn 오류_종류를_구분한다() {
        assert_eq!(parse_envelope(&out(r#"{"subtype":"error","is_error":true,"result":"Claude usage limit reached"}"#)), Err(FailureCode::RateLimited));
        assert_eq!(parse_envelope(&out(r#"{"subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"#)), Err(FailureCode::AuthRequired));
        let crashed = ExecOutput { status_ok: false, stdout: String::new(), stderr: "boom".into() };
        assert_eq!(parse_envelope(&crashed), Err(FailureCode::CliError));
        assert_eq!(parse_envelope(&out("not json")), Err(FailureCode::InvalidOutput));
    }
}
