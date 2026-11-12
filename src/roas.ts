import type { Env } from "./env";
import { db, dashTarget } from "./supabase";

/** Fila que devuelve la función rendimiento() del NUCLEA Dashboard. */
export interface RendimientoRow {
  offer_id: string | null;
  producto: string | null;
  archivado: boolean;
  country: string | null;
  ventas: number;
  neto_cop: number | string;
  pauta_cop: number | string;
}

export interface RoasRow { offer_id: string; country: string; ventas: number; neto: number; pauta: number; roas: number | null }
export interface RoasPayload {
  from: string;
  to: string;
  updatedAt: string;
  offers: { id: string; name: string; archived: boolean }[];
  rows: RoasRow[];
  error?: string;
}

/** Fecha YYYY-MM-DD en hora de Colombia, desplazada `offsetDays`. */
export function bogotaDate(now: Date, offsetDays = 0): string {
  const d = new Date(now.getTime() + offsetDays * 864e5);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Ventana del semáforo: hoy y los 2 días anteriores (hora de Colombia), pero nunca
 * antes de ROAS_START (YYYY-MM-DD), la fecha desde la que el equipo quiere contar.
 */
export function roasWindow(now: Date, start?: string): { from: string; to: string } {
  const to = bogotaDate(now, 0);
  let from = bogotaDate(now, -2);
  if (start && /^\d{4}-\d{2}-\d{2}$/.test(start) && start > from) from = start > to ? to : start;
  return { from, to };
}

/** ROAS = facturación neta ÷ pauta, por oferta y país. Sin pauta no hay ROAS. */
export function toRoasRows(rows: RendimientoRow[]): RoasRow[] {
  return rows
    .filter((r) => r.offer_id && r.country)
    .map((r) => {
      const neto = Number(r.neto_cop) || 0;
      const pauta = Number(r.pauta_cop) || 0;
      return {
        offer_id: r.offer_id as string,
        country: String(r.country).toUpperCase(),
        ventas: Number(r.ventas) || 0,
        neto,
        pauta,
        roas: pauta > 0 ? Math.round((neto / pauta) * 100) / 100 : null,
      };
    });
}

/** ROAS de los últimos 3 días (hoy y los 2 anteriores, hora de Colombia) por producto y país. */
export async function loadRoas(env: Env, now = new Date()): Promise<RoasPayload> {
  const { from, to } = roasWindow(now, env.ROAS_START);
  const target = dashTarget(env);
  const [perf, offers] = await Promise.all([
    db<RendimientoRow[]>(env, "rpc/rendimiento", { method: "POST", body: JSON.stringify({ p_from: from, p_to: to }) }, target),
    db<{ id: string; name: string; archived: boolean }[]>(env, "offers?select=id,name,archived&order=name", {}, target),
  ]);
  const out: RoasPayload = {
    from,
    to,
    updatedAt: now.toISOString(),
    offers: offers.data ?? [],
    rows: perf.data ? toRoasRows(perf.data) : [],
  };
  if (!perf.ok || !offers.ok) out.error = "No se pudo leer el NUCLEA Dashboard. Revisa DASH_SUPABASE_URL y DASH_SUPABASE_KEY.";
  return out;
}

/** Igual que loadRoas pero guardado 10 minutos en la caché del Worker. */
export async function cachedRoas(env: Env, ctx: ExecutionContext): Promise<RoasPayload> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request("https://scriptorium.cache/roas");
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as RoasPayload;
  const data = await loadRoas(env);
  if (!data.error) {
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" },
    })));
  }
  return data;
}

/** Ventas y facturación neta de todo el equipo entre dos fechas (para las metas). */
export interface TotalsPayload { from: string; to: string; ventas: number; neto: number; updatedAt: string; error?: string }

/** Suma todas las filas de rendimiento(): todas las ofertas y países, incluidas las archivadas. */
export function sumTotals(rows: RendimientoRow[]): { ventas: number; neto: number } {
  let ventas = 0;
  let neto = 0;
  for (const r of rows) {
    ventas += Number(r.ventas) || 0;
    neto += Number(r.neto_cop) || 0;
  }
  return { ventas, neto: Math.round(neto) };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const validRange = (from: string | null, to: string | null): boolean =>
  !!from && !!to && DAY.test(from) && DAY.test(to) && from <= to;

export async function loadTotals(env: Env, from: string, to: string, now = new Date()): Promise<TotalsPayload> {
  const perf = await db<RendimientoRow[]>(env, "rpc/rendimiento", { method: "POST", body: JSON.stringify({ p_from: from, p_to: to }) }, dashTarget(env));
  const out: TotalsPayload = { from, to, updatedAt: now.toISOString(), ...sumTotals(perf.data ?? []) };
  if (!perf.ok) out.error = "No se pudo leer el NUCLEA Dashboard.";
  return out;
}

/** Igual que loadTotals pero guardado 10 minutos en la caché del Worker. */
export async function cachedTotals(env: Env, ctx: ExecutionContext, from: string, to: string): Promise<TotalsPayload> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`https://scriptorium.cache/totales/${from}/${to}`);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as TotalsPayload;
  const data = await loadTotals(env, from, to);
  if (!data.error) {
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" },
    })));
  }
  return data;
}
