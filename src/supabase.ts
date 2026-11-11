import type { Env } from "./env";

export interface DbResult<T> { ok: boolean; status: number; data: T | null; error: string | null }

/** Cliente mínimo de PostgREST con la llave de servicio (solo del lado del servidor). */
export async function db<T = unknown>(
  env: Env,
  path: string,
  init: RequestInit & { prefer?: string } = {},
  target: { url: string; key: string } = { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY },
): Promise<DbResult<T>> {
  const headers: Record<string, string> = {
    apikey: target.key,
    Authorization: `Bearer ${target.key}`,
    "Content-Type": "application/json",
  };
  if (init.prefer) headers.Prefer = init.prefer;
  const res = await fetch(`${target.url.replace(/\/+$/, "")}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data: T | null = null;
  try { data = text ? (JSON.parse(text) as T) : null; } catch { /* sin cuerpo JSON */ }
  return { ok: res.ok, status: res.status, data, error: res.ok ? null : text };
}

/** Supabase del Dashboard (o el mismo de Scriptorium si comparten proyecto). */
export function dashTarget(env: Env): { url: string; key: string } {
  return {
    url: env.DASH_SUPABASE_URL || env.SUPABASE_URL,
    key: env.DASH_SUPABASE_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
  };
}
