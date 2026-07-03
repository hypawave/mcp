import { API_BASE, getPrivKey } from "./config.js";
import { signRequest } from "./signer.js";

export class HypawaveApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "HypawaveApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown> | null;
  query?: Record<string, string | number | undefined>;
  /** Sign with the pubkey identity (seller routes under /api/offers). */
  signed?: boolean;
}

export async function hw<T = Record<string, unknown>>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  let headers: Record<string, string> = { "Content-Type": "application/json" };
  let bodyStr: string | undefined;

  if (opts.signed) {
    // Signed bytes MUST equal sent bytes — signRequest serializes the body.
    const signed = signRequest({ body: opts.body ?? null, privKey: getPrivKey() });
    headers = signed.headers;
    bodyStr = signed.body;
  } else if (opts.body !== undefined && opts.body !== null) {
    bodyStr = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { method, headers, body: bodyStr });

  // Parse text first — error bodies are not guaranteed to be JSON.
  const text = await res.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const code = (json?.error as string) || `http_${res.status}`;
    const message = (json?.message as string) || text.slice(0, 300) || res.statusText;
    throw new HypawaveApiError(res.status, code, message);
  }
  return (json ?? {}) as T;
}

export function isApiError(e: unknown, code?: string): e is HypawaveApiError {
  return e instanceof HypawaveApiError && (code === undefined || e.code === code);
}
