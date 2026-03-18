export interface HttpError extends Error {
  status?: number;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err: HttpError = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export const http = {
  get: <T>(url: string) => fetch(url).then((res) => handleResponse<T>(res)),
  post: <T>(url: string, body?: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then((res) => handleResponse<T>(res)),
  delete: <T>(url: string) =>
    fetch(url, {
      method: 'DELETE'
    }).then((res) => handleResponse<T>(res))
};

