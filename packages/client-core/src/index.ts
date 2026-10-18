export * from "./retry";
export * from "./rpcError";
export * from "./api";
export * from "./actions";
export * from "./agent";
export * from "./time";

// 동기화 엔진 표시 상태. 로컬 저장과 클라우드 저장 성공을 구분한다 (docs/design.md 5장).
export interface SyncSummary {
  pendingCount: number;
  lastSuccessAt: string | null;
  conflictCount: number;
  lastError: string | null;
}
