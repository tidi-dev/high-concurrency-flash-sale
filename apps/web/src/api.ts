import type { DemoConfig } from '@flash/shared';

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return { status: 0, data: { message: 'Network error: is the API running?' } as T };
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // e.g. the dev proxy's HTML error page while the API restarts
    data = { message: `HTTP ${res.status}: API unavailable` };
  }
  return { status: res.status, data: data as T };
}

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patchConfig = (patch: Partial<DemoConfig>) => api<DemoConfig>('/config', { method: 'PATCH', body: patch });
