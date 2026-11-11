import type { Env } from "./env";
import { db, dashTarget } from "./supabase";
import { bogotaDate, type RendimientoRow } from "./roas";

interface Offer { id: string; name: string; archived: boolean }
interface Item { id: string; data: Record<string, unknown> }
/** Un país donde se vende una oferta. `weight` ordena (más pauta primero). */
export interface OfferCountry { offer_id: string; country: string; weight?: number }
export interface SyncResult { creados: string[]; enlazados: string[]; separados: string[]; archivados: string[] }

type Patch = { id: string; data: Record<string, unknown>; kind: "enlazado" | "separado" | "archivado"; name: string };

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Nombre de un producto por país: "PILATES · CO". */
export const countryName = (offer: string, country: string) => `${offer} · ${country}`;

/**
 * Decide qué cambiar para que cada oferta del Dashboard tenga un producto por país en Scriptorium.
 * - Cada país de la oferta (sus fuentes y donde tuvo ventas o pauta) es un producto aparte, con su propio ROAS.
 * - Un producto viejo de la oferta sin país se queda con el país de más pauta (conserva sus tareas y entregas)
 *   y, si tenía el mismo nombre de la oferta, pasa a llamarse "OFERTA · PAÍS". Los demás países se crean.
 * - Oferta sin países todavía: un solo producto sin país, como antes.
 * - Un producto sin oferta con el mismo nombre de la oferta se enlaza en vez de crear otro.
 * - Oferta archivada en el Dashboard: sus productos activos pasan a archivado.
 * No toca etapas, enlaces ni nombres que el equipo haya cambiado.
 */
export function planSync(offers: Offer[], products: Item[], offerCountries: OfferCountry[] = []) {
  const create: Record<string, unknown>[] = [];
  const patch: Patch[] = [];
  const now = new Date().toISOString();

  const countriesOf = new Map<string, string[]>();
  const weights = new Map<string, number>();
  for (const oc of offerCountries) {
    const c = String(oc.country || "").trim().toUpperCase();
    if (!oc.offer_id || !c || c === "*") continue;
    const k = `${oc.offer_id}|${c}`;
    weights.set(k, (weights.get(k) || 0) + (Number(oc.weight) || 0));
    const list = countriesOf.get(oc.offer_id) || [];
    if (!list.includes(c)) list.push(c);
    countriesOf.set(oc.offer_id, list);
  }

  const queue = (id: string, data: Record<string, unknown>, kind: Patch["kind"], name: string) => {
    const prev = patch.find((x) => x.id === id);
    if (prev) { Object.assign(prev.data, data); if (kind !== "enlazado") prev.kind = kind; prev.name = name; }
    else patch.push({ id, data: { ...data }, kind, name });
  };

  for (const o of offers) {
    let mine = products.filter((p) => String(p.data.offer || "") === o.id);

    if (!mine.length) {
      const twin = products.find((x) => !x.data.offer && norm(x.data.name) === norm(o.name));
      if (twin) {
        twin.data.offer = o.id;
        queue(twin.id, { offer: o.id }, "enlazado", o.name);
        mine = [twin];
      }
    }

    if (o.archived) {
      for (const p of mine) {
        if ((p.data.status || "activo") === "activo") { p.data.status = "archivado"; queue(p.id, { status: "archivado" }, "archivado", String(p.data.name || o.name)); }
      }
      continue;
    }

    const countries = (countriesOf.get(o.id) || [])
      .slice()
      .sort((a, b) => (weights.get(`${o.id}|${b}`) || 0) - (weights.get(`${o.id}|${a}`) || 0) || a.localeCompare(b));

    if (!countries.length) {
      if (!mine.length) create.push({ name: o.name, status: "activo", offer: o.id, countries: [], stages: {}, links: {}, from: "dashboard", createdAt: now });
      continue;
    }

    const have = new Set(mine.map((p) => String(p.data.country || "").toUpperCase()).filter(Boolean));
    const legacy = mine.filter((p) => !p.data.country);
    const base = legacy[0] || mine[0];
    for (const c of countries) {
      if (have.has(c)) continue;
      const old = legacy.shift();
      if (old) {
        const data: Record<string, unknown> = { country: c };
        if (norm(old.data.name) === norm(o.name)) data.name = countryName(o.name, c);
        Object.assign(old.data, data);
        queue(old.id, data, "separado", String(old.data.name));
      } else {
        create.push({
          name: countryName(o.name, c), status: "activo", offer: o.id, country: c,
          line: base?.data.line || "", avatar: base?.data.avatar || "",
          countries: [], stages: {}, links: {}, from: "dashboard", createdAt: now,
        });
      }
      have.add(c);
    }
  }
  return { create, patch };
}

/** Países de cada oferta: sus fuentes en el Dashboard y donde tuvo ventas o pauta en los últimos 30 días. */
async function loadOfferCountries(env: Env): Promise<OfferCountry[]> {
  const target = dashTarget(env);
  const now = new Date();
  const [sources, perf] = await Promise.all([
    db<{ offer_id: string; country: string }[]>(env, "sources?select=offer_id,country&active=eq.true", {}, target),
    db<RendimientoRow[]>(env, "rpc/rendimiento", { method: "POST", body: JSON.stringify({ p_from: bogotaDate(now, -29), p_to: bogotaDate(now, 0) }) }, target),
  ]);
  if (!sources.ok && !perf.ok) throw new Error("No se pudieron leer los países de las ofertas del Dashboard");
  const out: OfferCountry[] = [];
  for (const s of sources.data || []) out.push({ offer_id: s.offer_id, country: s.country });
  for (const r of perf.data || []) {
    if (r.offer_id && r.country) out.push({ offer_id: r.offer_id, country: r.country, weight: (Number(r.pauta_cop) || 0) + (Number(r.neto_cop) || 0) / 1000 });
  }
  return out;
}

export async function syncProducts(env: Env): Promise<SyncResult> {
  const [offers, products, offerCountries] = await Promise.all([
    db<Offer[]>(env, "offers?select=id,name,archived&order=created_at", {}, dashTarget(env)),
    db<Item[]>(env, "sc_items?col=eq.products&select=id,data&limit=5000"),
    loadOfferCountries(env),
  ]);
  if (!offers.ok || !offers.data) throw new Error("No se pudieron leer las ofertas del Dashboard");
  if (!products.ok || !products.data) throw new Error("No se pudieron leer los productos de Scriptorium");
  const original = new Map(products.data.map((p) => [p.id, { ...p.data }]));
  const { create, patch } = planSync(offers.data, products.data, offerCountries);
  const out: SyncResult = { creados: [], enlazados: [], separados: [], archivados: [] };
  if (create.length) {
    const r = await db(env, "sc_items", { method: "POST", body: JSON.stringify(create.map((data) => ({ col: "products", data }))) });
    if (!r.ok) throw new Error("No se pudieron crear los productos");
    out.creados = create.map((c) => String(c.name));
  }
  for (const p of patch) {
    const r = await db(env, `sc_items?id=eq.${p.id}`, { method: "PATCH", body: JSON.stringify({ data: { ...(original.get(p.id) || {}), ...p.data } }) });
    if (r.ok) (p.kind === "enlazado" ? out.enlazados : p.kind === "separado" ? out.separados : out.archivados).push(p.name);
  }
  return out;
}
