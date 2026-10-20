// 저장 충돌(다른 기기가 먼저 저장) 때 내 편집과 서버 최신 내용을 나란히 보여 준다. 자동 병합은 하지 않는다.
import type { ReactNode } from "react";

export function ConflictCompare({ mine, theirs, onUseLatest, onSaveMine, busy }: {
  mine: ReactNode;
  theirs: ReactNode;
  /** 내 편집을 버리고 최신 내용을 불러온다(확인 후) */
  onUseLatest: () => void;
  /** 최신 버전 기준으로 내 편집을 다시 저장한다 */
  onSaveMine: () => void;
  busy?: boolean;
}) {
  return (
    <div className="conflict" role="alert">
      <strong>다른 기기에서 먼저 저장했습니다.</strong>
      <p className="muted">내 편집은 그대로 두었습니다. 두 내용을 비교한 뒤 고르세요.</p>
      <div className="conflict-cols">
        <section aria-label="내 편집">
          <h5>내 편집 (저장 안 됨)</h5>
          <div className="conflict-body">{mine}</div>
        </section>
        <section aria-label="서버 최신 내용">
          <h5>서버 최신 내용</h5>
          <div className="conflict-body">{theirs}</div>
        </section>
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={onSaveMine}>내 편집으로 다시 저장</button>
        <button type="button" disabled={busy} onClick={() => {
          if (window.confirm("내 편집을 버리고 서버 최신 내용을 불러올까요?")) onUseLatest();
        }}>최신 내용 불러오기</button>
      </div>
    </div>
  );
}
