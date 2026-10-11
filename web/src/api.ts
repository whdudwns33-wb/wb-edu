export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: string }).error) : `요청 실패 (${res.status})`;
    if (res.status === 401 && !url.includes('/auth/')) {
      window.dispatchEvent(new CustomEvent('wb:unauthorized'));
    }
    throw new ApiError(res.status, msg, typeof data === 'object' && data ? (data as { details?: unknown }).details : undefined);
  }
  return data as T;
}

export const get = <T,>(url: string) => api<T>('GET', url);
export const post = <T,>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T,>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T,>(url: string) => api<T>('DELETE', url);

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const d = Array.isArray(e.details) ? `\n${e.details.join('\n')}` : '';
    return e.message + d;
  }
  return e instanceof Error ? e.message : String(e);
}
