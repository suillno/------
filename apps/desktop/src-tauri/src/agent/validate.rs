//! AI 출력 검증 (docs/design.md 9장 6단계). 기준 schema: packages/contracts/src/analysis.ts.
//! 서버(validate_analysis_payload)도 같은 검사를 다시 한다. AI 출력은 신뢰하지 않는 데이터다.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ActionItem {
    pub text: String,
    pub assignee: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EventCandidate {
    pub title: String,
    pub start_local: Option<String>,
    pub end_local: Option<String>,
    pub time_zone: String,
    pub all_day: bool,
    pub evidence: String,
    pub needs_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AnalysisResultV1 {
    pub schema_version: u32,
    pub summary: String,
    pub decisions: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub event_candidates: Vec<EventCandidate>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Invalid(pub String);

fn check_len(field: &str, s: &str, min: usize, max: usize) -> Result<(), Invalid> {
    let n = s.chars().count();
    if n < min || n > max {
        return Err(Invalid(format!("{field} 길이 {n}")));
    }
    Ok(())
}

fn days_in_month(y: u32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// YYYY-MM-DD 이고 실제로 있는 날짜인지
fn parse_date(s: &str) -> Option<(u32, u32, u32)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: u32 = s[0..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    (y >= 1900 && (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)).then_some((y, m, d))
}

/// YYYY-MM-DDTHH:MM[:SS]
fn parse_local_datetime(s: &str) -> Option<()> {
    if s.len() != 16 && s.len() != 19 {
        return None;
    }
    parse_date(s.get(0..10)?)?;
    let t = s.get(10..)?;
    let b = t.as_bytes();
    if b[0] != b'T' || b[3] != b':' {
        return None;
    }
    let h: u32 = t.get(1..3)?.parse().ok()?;
    let min: u32 = t.get(4..6)?.parse().ok()?;
    let sec: u32 = if t.len() == 9 {
        if b[6] != b':' {
            return None;
        }
        t.get(7..9)?.parse().ok()?
    } else {
        0
    };
    (h < 24 && min < 60 && sec < 60).then_some(())
}

fn normalize_seconds(s: &str) -> String {
    if s.len() == 16 { format!("{s}:00") } else { s.to_string() }
}

fn looks_like_time_zone(tz: &str) -> bool {
    !tz.is_empty()
        && tz.len() <= 64
        && tz.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && tz.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '+' | '-'))
}

/// 검증하고 일부 값을 정규화한다. 날짜·시각이 비면 needs_confirmation을 true로 바꾼다.
pub fn validate(value: &Value) -> Result<AnalysisResultV1, Invalid> {
    let mut r: AnalysisResultV1 = serde_json::from_value(value.clone()).map_err(|e| Invalid(e.to_string()))?;
    if r.schema_version != 1 {
        return Err(Invalid("schema_version".into()));
    }
    check_len("summary", &r.summary, 0, 4000)?;
    if r.decisions.len() > 50 || r.action_items.len() > 100 || r.event_candidates.len() > 30 {
        return Err(Invalid("배열 길이".into()));
    }
    for d in &r.decisions {
        check_len("decisions[]", d, 0, 1000)?;
    }
    for a in &r.action_items {
        check_len("action_items[].text", &a.text, 1, 1000)?;
        if let Some(who) = &a.assignee {
            check_len("action_items[].assignee", who, 0, 200)?;
        }
        if let Some(due) = &a.due_date {
            parse_date(due).ok_or_else(|| Invalid("action_items[].due_date".into()))?;
        }
    }
    for c in &mut r.event_candidates {
        check_len("event_candidates[].title", &c.title, 1, 300)?;
        check_len("event_candidates[].evidence", &c.evidence, 0, 2000)?;
        if !looks_like_time_zone(&c.time_zone) {
            return Err(Invalid("event_candidates[].time_zone".into()));
        }
        for v in [&c.start_local, &c.end_local].into_iter().flatten() {
            let ok = if c.all_day { parse_date(v).is_some() } else { parse_local_datetime(v).is_some() };
            if !ok {
                return Err(Invalid(format!("event_candidates[] 날짜 형식: {v}")));
            }
        }
        if let (Some(s), Some(e)) = (&c.start_local, &c.end_local) {
            // 같은 형식의 현지 시각은 문자열 비교가 시간 순서와 같다(시간대 전환 검사는 서버가 승인 시 한다).
            let (s, e) = if c.all_day { (s.clone(), e.clone()) } else { (normalize_seconds(s), normalize_seconds(e)) };
            if (c.all_day && e < s) || (!c.all_day && e <= s) {
                return Err(Invalid("event_candidates[] 종료가 시작보다 앞섬".into()));
            }
        }
        if c.start_local.is_none() || c.end_local.is_none() {
            c.needs_confirmation = true;
        }
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        json!({
            "schema_version": 1, "summary": "요약", "decisions": ["결정"],
            "action_items": [{"text": "자료 공유", "assignee": "이영희", "due_date": "2026-10-23"}],
            "event_candidates": [{"title": "리뷰", "start_local": "2026-10-20T15:00", "end_local": "2026-10-20T16:00",
              "time_zone": "Asia/Seoul", "all_day": false, "evidence": "화요일 3시", "needs_confirmation": false}]
        })
    }

    #[test]
    fn 정상_결과를_통과시킨다() {
        assert_eq!(validate(&base()).unwrap().event_candidates.len(), 1);
    }

    #[test]
    fn a04_잘못된_날짜와_종료시각을_거절한다() {
        let mut v = base();
        v["action_items"][0]["due_date"] = json!("2026-02-30");
        assert!(validate(&v).is_err());

        let mut v = base();
        v["event_candidates"][0]["end_local"] = json!("2026-10-20T14:00");
        assert!(validate(&v).is_err(), "종료가 시작보다 앞섬");

        let mut v = base();
        v["event_candidates"][0]["start_local"] = json!("2026-10-20 15:00");
        assert!(validate(&v).is_err(), "형식");

        let mut v = base();
        v["event_candidates"][0]["all_day"] = json!(true);
        assert!(validate(&v).is_err(), "종일 일정에 시각");
    }

    #[test]
    fn 알_수_없는_필드와_schema_version을_거절한다() {
        let mut v = base();
        v["extra"] = json!(1);
        assert!(validate(&v).is_err());
        let mut v = base();
        v["schema_version"] = json!(2);
        assert!(validate(&v).is_err());
    }

    #[test]
    fn 날짜가_비면_확인_필요로_바꾼다() {
        let mut v = base();
        v["event_candidates"][0]["end_local"] = json!(null);
        assert!(validate(&v).unwrap().event_candidates[0].needs_confirmation);
    }

    #[test]
    fn 윤년과_시간대_이름을_확인한다() {
        let mut v = base();
        v["event_candidates"][0] = json!({"title": "종일", "start_local": "2028-02-29", "end_local": "2028-02-29",
            "time_zone": "America/New_York", "all_day": true, "evidence": "", "needs_confirmation": false});
        assert!(validate(&v).is_ok());
        v["event_candidates"][0]["time_zone"] = json!("; rm -rf");
        assert!(validate(&v).is_err());
    }
}
