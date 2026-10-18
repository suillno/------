import { Badge } from "../../common";
import { useApp } from "../../context";

export const calendarFeature = {
  id: "calendar",
  title: "일정",
} as const;

export function CalendarPage() {
  const { google } = useApp();
  return (
    <section>
      <h2>일정</h2>
      <div className="panel">
        <div className="row between">
          <h3>Google 캘린더 등록 방법</h3>
          <Badge tone={google?.connected ? "done" : "idle"}>{google?.connected ? "연결됨" : "연결 안 됨"}</Badge>
        </div>
        <ol>
          <li>설정에서 Google 캘린더를 연결합니다.</li>
          <li>회의록을 열고 ‘분석 실행’을 누릅니다.</li>
          <li>일정 후보의 날짜·시각을 확인·수정합니다.</li>
          <li>‘승인하고 캘린더 등록’을 누르고 내용을 확인한 뒤 ‘등록’을 누릅니다.</li>
        </ol>
        <p className="muted">후보를 수정하면 이전 승인은 무효가 되고 다시 승인해야 합니다. 실패한 등록은 ‘재시도’로만 다시 실행합니다.</p>
      </div>
    </section>
  );
}
