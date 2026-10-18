import { describe, expect, it } from "vitest";
import { toApiError } from "./rpcError";

describe("toApiError", () => {
  it("서버 계약 code와 details의 현재 version을 읽는다", () => {
    // 2026-10-17 로컬 PostgREST 16.4에서 받은 실제 409 응답 본문
    const body = {
      code: "VERSION_CONFLICT",
      details: '{"current_version": 1, "current_revision_id": "4937e641-a533-4055-953a-576f41f6c33f"}',
      hint: null,
      message: "다른 기기에서 수정되었습니다.",
    };
    expect(toApiError(409, body, "req-1")).toEqual({
      error: {
        code: "VERSION_CONFLICT",
        message: "다른 기기에서 수정되었습니다.",
        request_id: "req-1",
        current_version: 1,
        current_revision_id: "4937e641-a533-4055-953a-576f41f6c33f",
      },
    });
  });

  it("계약 code가 아니면 HTTP 상태로 분류하고 서버 메시지를 버린다", () => {
    const body = { code: "42501", message: "permission denied for table meetings", details: null };
    expect(toApiError(403, body, "req-2").error).toEqual({
      code: "FORBIDDEN",
      message: "",
      request_id: "req-2",
    });
    expect(toApiError(502, "<html>", "req-3").error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("잘못된 details는 무시한다", () => {
    const body = { code: "ENTITY_DELETED", message: "삭제됨", details: '{"current_version":"9"}' };
    expect(toApiError(409, body, "r").error).not.toHaveProperty("current_version");
    expect(toApiError(409, { ...body, details: "not json" }, "r").error.code).toBe("ENTITY_DELETED");
  });
});
