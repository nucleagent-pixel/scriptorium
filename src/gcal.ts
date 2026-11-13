import type { Env } from "./env";
import { db } from "./supabase";

// Google Calendar: un admin conecta una cuenta de Google una sola vez y elige un calendario.
// - Scriptorium → Google: al guardar o borrar una reunión o fecha, se crea, cambia o borra en
//   Google (con Meet automático e invitación por correo al equipo).
// - Google → Scriptorium: cada 15 minutos y al abrir Calendario se traen los eventos de ese
//   calendario (30 días atrás, 120 adelante). Agenda y actas quedan solo en Scriptorium.
// El permiso de Google (refresh token) se guarda cifrado en sc_config, fila 'google'.

const SCOPES = "openid email https://www.googleapis.com/auth/calendar";
const API = "https://www.googleapis.com/calendar/v3";
export const CALLBACK_PATH = "/oauth/google/callback";
const PAST_DAYS = 30;
const FUTURE_DAYS = 120;

type Json = Record<string, unknown>;

export interface GcalRef { id: string; cal: string; link?: string; updated?: string; google?: boolean }
export interface ScEvent {
  title?: string; date?: string; time?: string; end?: string; kind?: string; repeat?: string;
  meet?: string; guests?: string[]; agenda?: string; notes?: string; actas?: Record<string, string>;
  gcal?: GcalRef | null;
}
interface Item { id: string; data: ScEvent & Json }

export interface GoogleState {
  enc?: string; email?: string; calendarId?: string; calendarName?: string;
  connectedAt?: string; lastPull?: string; error?: string;
}

interface GEventTime { date?: string; dateTime?: string; timeZone?: string }
export interface GEvent {
  id: string; status?: string; summary?: string; description?: string; htmlLink?: string; updated?: string;
  start?: GEventTime; end?: GEventTime; hangoutLink?: string; recurringEventId?: string;
  attendees?: { email?: string }[];
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  extendedProperties?: { private?: Record<string, string> };
}

export class GcalError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const tzOf = (env: Env) => env.GCAL_TZ || "America/Bogota";

// ---------------------------------------------------------------------------
// Cifrado del permiso y firma del "state" de OAuth (llaves derivadas de la service_role,
// que solo conoce el Worker).
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function keyBytes(env: Env, label: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(`scriptorium:${label}:${env.SUPABASE_SERVICE_ROLE_KEY}`));
}

export async function seal(env: Env, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", await keyBytes(env, "gcal-token"), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return `${b64u(iv)}.${b64u(ct)}`;
}

export async function unseal(env: Env, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  const key = await crypto.subtle.importKey("raw", await keyBytes(env, "gcal-token"), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, key, unb64u(ct));
  return new TextDecoder().decode(pt);
}

async function hmac(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", await keyBytes(env, "gcal-state"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signState(env: Env, uid: string, now = Date.now()): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify({ u: uid, e: now + 10 * 60 * 1000 })));
  return `${body}.${await hmac(env, body)}`;
}

export async function checkState(env: Env, state: string, now = Date.now()): Promise<string | null> {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig || sig !== (await hmac(env, body))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(body))) as { u?: string; e?: number };
    return p.u && p.e && p.e > now ? p.u : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Estado guardado (sc_config, fila 'google')
// ---------------------------------------------------------------------------
export async function loadState(env: Env): Promise<GoogleState> {
  const r = await db<{ data: GoogleState }[]>(env, "sc_config?id=eq.google&select=data");
  return r.data?.[0]?.data || {};
}

async function saveState(env: Env, state: GoogleState): Promise<void> {
  const r = await db(env, "sc_config", {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: JSON.stringify({ id: "google", data: state, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new GcalError("No se pudo guardar la conexión con Google", 500);
}

async function patchState(env: Env, patch: GoogleState): Promise<GoogleState> {
  const next = { ...(await loadState(env)), ...patch };
  await saveState(env, next);
  return next;
}

/** Lo que puede ver cualquier persona del equipo (sin el permiso cifrado). */
export function publicStatus(env: Env, s: GoogleState) {
  return {
    configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    connected: !!s.enc,
    email: s.email || null,
    calendarId: s.calendarId || null,
    calendarName: s.calendarName || null,
    lastPull: s.lastPull || null,
    error: s.error || null,
    timeZone: tzOf(env),
  };
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------
function requireClient(env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GcalError("Falta poner GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Cloudflare.");
  }
}

export async function authUrl(env: Env, origin: string, uid: string): Promise<string> {
  requireClient(env);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID as string,
    redirect_uri: origin + CALLBACK_PATH,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: await signState(env, uid),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string }

async function tokenCall(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as TokenResponse;
}

function emailFromIdToken(idToken?: string): string {
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(String(idToken).split(".")[1]))) as { email?: string };
    return p.email || "";
  } catch { return ""; }
}

/** Vuelta de Google después de que el admin da permiso. */
export async function finishOAuth(env: Env, origin: string, code: string): Promise<void> {
  requireClient(env);
  const t = await tokenCall({
    code,
    client_id: env.GOOGLE_CLIENT_ID as string,
    client_secret: env.GOOGLE_CLIENT_SECRET as string,
    redirect_uri: origin + CALLBACK_PATH,
    grant_type: "authorization_code",
  });
  if (!t.refresh_token) throw new GcalError(t.error_description || t.error || "Google no entregó el permiso. Intenta de nuevo.");
  const email = emailFromIdToken(t.id_token);
  const prev = await loadState(env);
  // Si se reconecta la misma cuenta, se mantiene el calendario elegido.
  const sameAccount = prev.email && prev.email === email;
  await saveState(env, {
    enc: await seal(env, t.refresh_token),
    email,
    calendarId: sameAccount ? prev.calendarId || "primary" : "primary",
    calendarName: sameAccount ? prev.calendarName || email : email,
    connectedAt: new Date().toISOString(),
    lastPull: undefined,
    error: undefined,
  });
  tokenCache = null;
}

let tokenCache: { sealed: string; token: string; exp: number } | null = null;

async function accessToken(env: Env, s: GoogleState): Promise<string> {
  if (!s.enc) throw new GcalError("Google Calendar no está conectado.", 409);
  if (tokenCache && tokenCache.sealed === s.enc && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  requireClient(env);
  const t = await tokenCall({
    refresh_token: await unseal(env, s.enc),
    client_id: env.GOOGLE_CLIENT_ID as string,
    client_secret: env.GOOGLE_CLIENT_SECRET as string,
    grant_type: "refresh_token",
  });
  if (!t.access_token) {
    const msg = t.error === "invalid_grant"
      ? "Google quitó el permiso (se venció o lo revocaron). Un admin debe volver a conectar Google Calendar."
      : `Google no respondió: ${t.error_description || t.error || "error"}`;
    await patchState(env, { error: msg }).catch(() => {});
    throw new GcalError(msg, 502);
  }
  tokenCache = { sealed: s.enc, token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
  return t.access_token;
}

export async function disconnect(env: Env): Promise<void> {
  const s = await loadState(env);
  if (s.enc) {
    const rt = await unseal(env, s.enc).catch(() => "");
    if (rt) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rt)}`, { method: "POST" }).catch(() => {});
  }
  await saveState(env, { calendarId: s.calendarId, calendarName: s.calendarName });
  tokenCache = null;
}

async function gapi<T = Json>(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; data: T | null; error: string }> {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: T | null = null;
  try { data = text ? (JSON.parse(text) as T) : null; } catch { /* sin JSON */ }
  const err = res.ok ? "" : ((data as { error?: { message?: string } } | null)?.error?.message || `HTTP ${res.status}`);
  return { status: res.status, data, error: err };
}

// ---------------------------------------------------------------------------
// Calendarios de la cuenta
// ---------------------------------------------------------------------------
export async function listCalendars(env: Env) {
  const s = await loadState(env);
  const token = await accessToken(env, s);
  const r = await gapi<{ items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string }[] }>(
    token, "/users/me/calendarList?minAccessRole=writer&maxResults=250",
  );
  if (!r.data) throw new GcalError(`No se pudo leer la lista de calendarios: ${r.error}`, 502);
  return (r.data.items || []).map((c) => ({
    id: c.primary ? "primary" : c.id,
    name: c.summaryOverride || c.summary || c.id,
    primary: !!c.primary,
    selected: (c.primary ? "primary" : c.id) === (s.calendarId || "primary"),
  }));
}

export async function chooseCalendar(env: Env, id: string, name: string): Promise<void> {
  if (!id) throw new GcalError("Elige un calendario");
  await patchState(env, { calendarId: id, calendarName: name || id, lastPull: undefined, error: undefined });
}

// ---------------------------------------------------------------------------
// Conversión Scriptorium ↔ Google
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, "0");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMinutes(time: string, n: number): string {
  const [h, m] = time.split(":").map(Number);
  const t = Math.min(23 * 60 + 59, h * 60 + m + n);
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

/** Fecha y hora locales (en la zona del equipo) de un dateTime de Google. */
export function localParts(dateTime: string, tz: string): { date: string; time: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(dateTime))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function todayIn(tz: string, now = new Date()): string {
  return localParts(now.toISOString(), tz).date;
}

/** Cuerpo del evento de Google para una reunión o fecha creada en Scriptorium. */
export function toGoogle(id: string, ev: ScEvent, tz: string, emailOf: Map<string, string>, appUrl: string): Json {
  const date = DATE.test(String(ev.date)) ? (ev.date as string) : todayIn(tz);
  const body: Json = { summary: (ev.title || "Sin título").slice(0, 300) };
  const meeting = ev.kind === "reunion";
  if (meeting) {
    const start = TIME.test(String(ev.time)) ? (ev.time as string) : "09:00";
    let end = TIME.test(String(ev.end)) ? (ev.end as string) : addMinutes(start, 45);
    if (end <= start) end = addMinutes(start, 45);
    body.start = { dateTime: `${date}T${start}:00`, timeZone: tz };
    body.end = { dateTime: `${date}T${end}:00`, timeZone: tz };
  } else {
    body.start = { date };
    body.end = { date: addDays(date, 1) };
  }
  // Las importadas de Google conservan su descripción e invitados de allá.
  if (ev.gcal?.google) return body;

  const lines: string[] = [];
  if (meeting) {
    const agenda = String(ev.agenda || "").split("\n").map((x) => x.trim()).filter(Boolean);
    if (agenda.length) lines.push("Agenda:", ...agenda.map((x, i) => `${i + 1}. ${x}`), "");
  } else if (ev.notes) lines.push(String(ev.notes), "");
  if (ev.meet && !/meet\.google\.com/.test(ev.meet)) lines.push(`Enlace: ${ev.meet}`, "");
  lines.push(`Agenda y acta en Scriptorium: ${appUrl}/#calendario`);
  body.description = lines.join("\n");
  body.extendedProperties = { private: { scId: id } };
  body.recurrence = ev.repeat === "semanal" ? ["RRULE:FREQ=WEEKLY"] : ev.repeat === "mensual" ? ["RRULE:FREQ=MONTHLY"] : [];
  if (ev.meet && !/meet\.google\.com/.test(ev.meet)) body.location = ev.meet;
  if (meeting) {
    const emails = [...new Set((ev.guests || []).map((g) => emailOf.get(g.trim().toLowerCase())).filter(Boolean))] as string[];
    body.attendees = emails.map((email) => ({ email }));
  }
  return body;
}

const meetOf = (g: GEvent) =>
  g.hangoutLink || g.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri || "";

/** Campos de Scriptorium que vienen de un evento de Google. */
export function fromGoogle(g: GEvent, tz: string, nameOf: Map<string, string>): ScEvent {
  const out: ScEvent = { title: g.summary || "(Sin título)" };
  if (g.start?.date) {
    out.kind = "fecha";
    out.date = g.start.date;
  } else if (g.start?.dateTime) {
    const s = localParts(g.start.dateTime, tz);
    out.kind = "reunion";
    out.date = s.date;
    out.time = s.time;
    if (g.end?.dateTime) {
      const e = localParts(g.end.dateTime, tz);
      out.end = e.date === s.date ? e.time : "23:59";
    }
  }
  const meet = meetOf(g);
  if (meet) out.meet = meet;
  if (out.kind === "reunion") {
    out.guests = (g.attendees || []).map((a) => nameOf.get(String(a.email || "").toLowerCase())).filter(Boolean) as string[];
  }
  return out;
}

const SAME_KEYS: (keyof ScEvent)[] = ["title", "date", "time", "end", "kind", "meet", "guests"];
function differs(a: ScEvent, b: ScEvent): boolean {
  return SAME_KEYS.some((k) => b[k] !== undefined && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}

const hasActas = (ev: ScEvent) => Object.values(ev.actas || {}).some((x) => String(x || "").trim());

export interface PullPlan {
  create: ScEvent[];
  patch: { id: string; data: ScEvent }[];
  remove: string[];
  /** Creados en Scriptorium que ya no aparecen en Google: se confirman uno por uno antes de borrar. */
  ownGone: string[];
}

/**
 * Qué cambiar en Scriptorium según lo que hay en Google.
 * - Eventos creados en Google: se crean, cambian o borran (si no tienen acta) en Scriptorium.
 * - Eventos creados en Scriptorium (no repetidos): si alguien los movió en Google, se actualiza
 *   la fecha, hora y título; si los borraron en Google, se borran aquí (o se sueltan si tienen acta).
 */
export function planPull(gEvents: GEvent[], items: Item[], cal: string, tz: string, nameOf: Map<string, string>, from: string, to: string): PullPlan {
  const plan: PullPlan = { create: [], patch: [], remove: [], ownGone: [] };
  const live = gEvents.filter((g) => g.status !== "cancelled");
  const seen = new Set<string>();
  for (const g of live) { seen.add(g.id); if (g.recurringEventId) seen.add(g.recurringEventId); }

  const byGid = new Map<string, Item>();
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const it of items) {
    const ref = it.data.gcal;
    if (!ref?.id) continue;
    if (ref.google && byGid.has(ref.id)) { plan.remove.push(it.id); continue; } // duplicado
    if (ref.google) byGid.set(ref.id, it);
  }

  for (const g of live) {
    const scId = g.extendedProperties?.private?.scId;
    if (scId) {
      // Creado en Scriptorium. Solo se siguen cambios de eventos no repetidos.
      const it = byId.get(scId);
      if (!it || g.recurringEventId || it.data.gcal?.id !== g.id || (it.data.repeat && it.data.repeat !== "no")) continue;
      if (g.updated && it.data.gcal?.updated && g.updated <= it.data.gcal.updated) continue;
      const f = fromGoogle(g, tz, nameOf);
      const data: ScEvent = { title: f.title, date: f.date, ...(f.kind === "reunion" ? { time: f.time, end: f.end } : {}) };
      const ref: GcalRef = { ...(it.data.gcal as GcalRef), updated: g.updated, link: g.htmlLink };
      plan.patch.push({ id: it.id, data: differs(it.data, data) ? { ...data, gcal: ref } : { gcal: ref } });
      continue;
    }
    const f = fromGoogle(g, tz, nameOf);
    const ref: GcalRef = { id: g.id, cal, link: g.htmlLink, updated: g.updated, google: true };
    const it = byGid.get(g.id);
    if (!it) {
      plan.create.push({ ...f, repeat: "no", actas: {}, gcal: ref });
    } else if (it.data.gcal?.updated !== g.updated || it.data.gcal?.cal !== cal) {
      plan.patch.push({ id: it.id, data: differs(it.data, f) ? { ...f, gcal: ref } : { gcal: ref } });
    }
  }

  for (const it of items) {
    const ref = it.data.gcal;
    if (!ref?.id || plan.remove.includes(it.id)) continue;
    const inWindow = !!it.data.date && it.data.date >= from && it.data.date <= to;
    if (ref.google) {
      const gone = ref.cal !== cal || (inWindow && !seen.has(ref.id));
      if (gone && !hasActas(it.data)) plan.remove.push(it.id);
      else if (gone) plan.patch.push({ id: it.id, data: { gcal: null } });
    } else if (ref.cal === cal && (!it.data.repeat || it.data.repeat === "no") && inWindow && !seen.has(ref.id)) {
      plan.ownGone.push(it.id); // ¿lo borraron en Google o solo lo movieron fuera de la ventana?
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Operaciones
// ---------------------------------------------------------------------------
async function members(env: Env): Promise<{ name: string; email: string | null }[]> {
  const r = await db<{ name: string; email: string | null }[]>(env, "sc_members?select=name,email&role=neq.pendiente");
  return r.data || [];
}

async function eventItems(env: Env): Promise<Item[]> {
  const r = await db<Item[]>(env, "sc_items?col=eq.events&select=id,data&limit=5000");
  if (!r.data) throw new GcalError("No se pudieron leer los eventos de Scriptorium", 500);
  return r.data;
}

async function patchItem(env: Env, id: string, data: ScEvent, current: Json): Promise<void> {
  await db(env, `sc_items?id=eq.${id}&col=eq.events`, { method: "PATCH", body: JSON.stringify({ data: { ...current, ...data } }) });
}

const calPath = (cal: string) => `/calendars/${encodeURIComponent(cal)}/events`;

/**
 * Crea o actualiza en Google un evento de Scriptorium. Devuelve los campos que hay que
 * guardar en el evento (gcal y, si Google creó un Meet, el enlace).
 */
export async function pushEvent(env: Env, id: string, appUrl: string): Promise<ScEvent> {
  const s = await loadState(env);
  if (!s.enc) return {};
  const cal = s.calendarId || "primary";
  const r = await db<Item[]>(env, `sc_items?id=eq.${id}&col=eq.events&select=id,data`);
  const it = r.data?.[0];
  if (!it) throw new GcalError("Evento no encontrado", 404);
  const ev = it.data;
  const token = await accessToken(env, s);
  const emailOf = new Map((await members(env)).filter((m) => m.email).map((m) => [m.name.trim().toLowerCase(), m.email as string]));
  const body = toGoogle(id, ev, tzOf(env), emailOf, appUrl);
  const own = !ev.gcal?.google;
  const wantsMeet = own && ev.kind === "reunion" && !ev.meet;

  let res: { status: number; data: GEvent | null; error: string } | null = null;
  if (ev.gcal?.id && ev.gcal.cal === cal) {
    if (wantsMeet) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    res = await gapi<GEvent>(token, `${calPath(cal)}/${encodeURIComponent(ev.gcal.id)}?sendUpdates=all&conferenceDataVersion=1`, { method: "PATCH", body: JSON.stringify(body) });
    if (res.status === 404 || res.status === 410) res = null; // lo borraron en Google: se vuelve a crear
  }
  if (!res) {
    if (!own) return { gcal: null }; // era de Google y ya no existe allá
    if (wantsMeet) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    res = await gapi<GEvent>(token, `${calPath(cal)}?sendUpdates=all&conferenceDataVersion=1`, { method: "POST", body: JSON.stringify(body) });
  }
  if (!res.data?.id) throw new GcalError(`Google no guardó el evento: ${res.error}`, 502);
  const g = res.data;
  const out: ScEvent = { gcal: { id: g.id, cal, link: g.htmlLink, updated: g.updated, ...(own ? {} : { google: true }) } };
  const meet = meetOf(g);
  if (!ev.meet && meet) out.meet = meet;
  return out;
}

export async function deleteEvent(env: Env, gid: string, cal?: string): Promise<void> {
  const s = await loadState(env);
  if (!s.enc || !gid) return;
  const target = cal || s.calendarId || "primary";
  if (target !== (s.calendarId || "primary")) return; // era de otro calendario: no se toca
  const token = await accessToken(env, s);
  const r = await gapi(token, `${calPath(target)}/${encodeURIComponent(gid)}?sendUpdates=all`, { method: "DELETE" });
  if (r.status >= 400 && r.status !== 404 && r.status !== 410) throw new GcalError(`Google no borró el evento: ${r.error}`, 502);
}

/** Trae los cambios de Google. Con minGapMs evita repetir si se hizo hace poco. */
export async function pullEvents(env: Env, minGapMs = 0): Promise<{ skipped?: boolean; created: number; updated: number; removed: number }> {
  const s = await loadState(env);
  if (!s.enc) return { skipped: true, created: 0, updated: 0, removed: 0 };
  if (minGapMs && s.lastPull && Date.now() - Date.parse(s.lastPull) < minGapMs) return { skipped: true, created: 0, updated: 0, removed: 0 };
  const cal = s.calendarId || "primary";
  const tz = tzOf(env);
  const today = todayIn(tz);
  const from = addDays(today, -PAST_DAYS);
  const to = addDays(today, FUTURE_DAYS);
  const token = await accessToken(env, s);

  const gEvents: GEvent[] = [];
  let pageToken = "";
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({
      singleEvents: "true", showDeleted: "false", maxResults: "2500", orderBy: "startTime",
      timeMin: `${from}T00:00:00Z`, timeMax: `${addDays(to, 1)}T00:00:00Z`, timeZone: tz,
    });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await gapi<{ items?: GEvent[]; nextPageToken?: string }>(token, `${calPath(cal)}?${q}`);
    if (!r.data) {
      const msg = `No se pudo leer el calendario de Google: ${r.error}`;
      await patchState(env, { error: msg });
      throw new GcalError(msg, 502);
    }
    gEvents.push(...(r.data.items || []));
    pageToken = r.data.nextPageToken || "";
    if (!pageToken) break;
  }

  const items = await eventItems(env);
  const nameOf = new Map((await members(env)).filter((m) => m.email).map((m) => [String(m.email).toLowerCase(), m.name]));
  const plan = planPull(gEvents, items, cal, tz, nameOf, from, to);
  const current = new Map(items.map((i) => [i.id, i.data as Json]));

  for (const id of plan.ownGone) {
    const ev = current.get(id) as ScEvent | undefined;
    if (!ev?.gcal?.id) continue;
    const r = await gapi<GEvent>(token, `${calPath(cal)}/${encodeURIComponent(ev.gcal.id)}`);
    const gone = r.status === 404 || r.status === 410 || r.data?.status === "cancelled";
    if (!gone) continue;
    if (hasActas(ev)) plan.patch.push({ id, data: { gcal: null } });
    else plan.remove.push(id);
  }

  if (plan.create.length) {
    const now = new Date().toISOString();
    await db(env, "sc_items", {
      method: "POST",
      body: JSON.stringify(plan.create.map((data) => ({ col: "events", data: { ...data, createdAt: now }, created_by: null, updated_by: null }))),
    });
  }
  for (const p of plan.patch) await patchItem(env, p.id, p.data, current.get(p.id) || {});
  if (plan.remove.length) await db(env, `sc_items?col=eq.events&id=in.(${plan.remove.join(",")})`, { method: "DELETE" });

  await patchState(env, { lastPull: new Date().toISOString(), error: undefined });
  return { created: plan.create.length, updated: plan.patch.length, removed: plan.remove.length };
}
