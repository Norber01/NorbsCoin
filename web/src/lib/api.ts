export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, string>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, admin = false): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (admin) headers['x-requested-with'] = 'norbscoin';
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.');
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
};

export const adminApi = {
  get: <T>(url: string) => request<T>('GET', `/api/admin${url}`, undefined, true),
  post: <T>(url: string, body?: unknown) => request<T>('POST', `/api/admin${url}`, body ?? {}, true),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', `/api/admin${url}`, body ?? {}, true),
  del: <T>(url: string) => request<T>('DELETE', `/api/admin${url}`, undefined, true),
};
