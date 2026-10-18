// 테스트 전용 가짜 fetch. 실제 Google·Supabase에 요청하지 않는다.

export interface RecordedCall {
  method: string;
  url: string;
  body: string | null;
  headers: Record<string, string>;
}

export type Route = (call: RecordedCall) => Response | Promise<Response> | "network" | undefined;

export function fakeFetch(routes: Route[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body == null ? null : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    const call = { method: init?.method ?? "GET", url, body, headers };
    calls.push(call);
    for (const route of routes) {
      const res = await route(call);
      if (res === "network") throw new TypeError("network error");
      if (res) return res;
    }
    throw new Error(`처리하지 않은 요청: ${call.method} ${url}`);
  };
  return { fetch: impl as typeof fetch, calls };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
