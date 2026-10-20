// Supabase REST(PostgREST)·Auth 호출. supabase-js 없이 fetch만 쓴다(Deno·Node 공통, 테스트 주입 가능).

export class RpcError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`RPC 실패 (HTTP ${status})`);
  }

  /** 서버 api_error의 code. 없으면 null */
  get code(): string | null {
    const b = this.body as { code?: unknown } | null;
    return b && typeof b.code === "string" ? b.code : null;
  }
}

export interface SupabaseEndpoint {
  url: string;
  /** apikey 헤더 값 (anon 또는 service role) */
  apiKey: string;
  /** Authorization Bearer 값. 사용자 호출은 사용자 JWT, 서버 호출은 service role 키 */
  bearer: string;
  fetch: typeof fetch;
}

export async function rpc<T>(ep: SupabaseEndpoint, fn: string, args: Record<string, unknown>): Promise<T> {
  if (!/^[a-z_]+$/.test(fn)) throw new Error("잘못된 RPC 이름입니다");
  const res = await ep.fetch(`${ep.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ep.apiKey,
      Authorization: `Bearer ${ep.bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new RpcError(res.status, body);
  return body as T;
}

/**
 * 테이블 읽기(GET /rest/v1/<table>?<query>). 사용자 JWT로 부르면 RLS가 소유권을 검사한다.
 * query는 호출하는 코드가 만든 고정 형식만 넘긴다(사용자 입력은 UUID 검사 후 eq 값으로만).
 */
export async function select<T>(ep: SupabaseEndpoint, table: string, query: string): Promise<T[]> {
  if (!/^[a-z_]+$/.test(table)) throw new Error("잘못된 테이블 이름입니다");
  const res = await ep.fetch(`${ep.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: ep.apiKey, Authorization: `Bearer ${ep.bearer}`, Accept: "application/json" },
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new RpcError(res.status, body);
  return (Array.isArray(body) ? body : []) as T[];
}

/** 사용자 JWT를 Auth 서버에 확인해 user id를 얻는다. 서명 검증을 직접 하지 않는다. */
export async function getUserId(ep: SupabaseEndpoint): Promise<string | null> {
  const res = await ep.fetch(`${ep.url}/auth/v1/user`, {
    headers: { apikey: ep.apiKey, Authorization: `Bearer ${ep.bearer}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { id?: unknown };
  return typeof body.id === "string" ? body.id : null;
}
