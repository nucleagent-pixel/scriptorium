import { describe, expect, it } from "vitest";
import { addDays, checkState, fromGoogle, localParts, planPull, seal, signState, toGoogle, unseal, type GEvent } from "../src/gcal";
import type { Env } from "../src/env";

const env = { SUPABASE_SERVICE_ROLE_KEY: "service-role-de-prueba" } as Env;
const TZ = "America/Bogota";
const emails = new Map([["ana", "ana@x.co"], ["luis", "luis@x.co"]]);
const names = new Map([["ana@x.co", "Ana"], ["luis@x.co", "Luis"]]);

describe("Google Calendar: permiso y state", () => {
  it("cifra y descifra el permiso", async () => {
    const s = await seal(env, "1//refresh");
    expect(s).not.toContain("refresh");
    expect(await unseal(env, s)).toBe("1//refresh");
  });
  it("el state solo vale firmado y sin vencer", async () => {
    const st = await signState(env, "uid-1", 1000);
    expect(await checkState(env, st, 2000)).toBe("uid-1");
    expect(await checkState(env, st, 1000 + 11 * 60 * 1000)).toBeNull();
    expect(await checkState(env, st.slice(0, -2) + "xx", 2000)).toBeNull();
  });
});

describe("Google Calendar: conversión", () => {
  it("reunión semanal con invitados del equipo", () => {
    const b = toGoogle("sc1", { title: "Semanal", kind: "reunion", date: "2026-11-16", time: "09:00", end: "09:45", repeat: "semanal", guests: ["Ana", "Luis", "Externo"], agenda: "ROAS\nLíneas" }, TZ, emails, "https://s.dev");
    expect(b.start).toEqual({ dateTime: "2026-11-16T09:00:00", timeZone: TZ });
    expect(b.end).toEqual({ dateTime: "2026-11-16T09:45:00", timeZone: TZ });
    expect(b.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(b.attendees).toEqual([{ email: "ana@x.co" }, { email: "luis@x.co" }]);
    expect(b.description).toContain("1. ROAS");
    expect(b.extendedProperties).toEqual({ private: { scId: "sc1" } });
  });
  it("fecha importante = día completo", () => {
    const b = toGoogle("sc2", { title: "Lanzamiento", kind: "fecha", date: "2026-11-30" }, TZ, emails, "https://s.dev");
    expect(b.start).toEqual({ date: "2026-11-30" });
    expect(b.end).toEqual({ date: "2026-12-01" });
    expect(b.attendees).toBeUndefined();
  });
  it("evento de Google a hora de Colombia", () => {
    expect(localParts("2026-11-16T14:00:00Z", TZ)).toEqual({ date: "2026-11-16", time: "09:00" });
    const f = fromGoogle({ id: "g1", summary: "Con Ana", start: { dateTime: "2026-11-16T10:00:00-05:00" }, end: { dateTime: "2026-11-16T11:00:00-05:00" }, hangoutLink: "https://meet.google.com/abc", attendees: [{ email: "ANA@x.co" }, { email: "otro@y.com" }] }, TZ, names);
    expect(f).toEqual({ title: "Con Ana", kind: "reunion", date: "2026-11-16", time: "10:00", end: "11:00", meet: "https://meet.google.com/abc", guests: ["Ana"] });
  });
  it("suma días", () => expect(addDays("2026-12-31", 1)).toBe("2027-01-01"));
});

describe("Google Calendar: traer cambios", () => {
  const g = (id: string, extra: Partial<GEvent> = {}): GEvent => ({ id, summary: id, updated: "2026-11-13T10:00:00Z", start: { date: "2026-11-20" }, end: { date: "2026-11-21" }, ...extra });
  const run = (gs: GEvent[], items: { id: string; data: Record<string, unknown> }[]) => planPull(gs, items as never, "primary", TZ, names, "2026-10-14", "2027-03-13");

  it("crea lo nuevo de Google y no repite", () => {
    const p = run([g("a")], []);
    expect(p.create).toHaveLength(1);
    expect(p.create[0]).toMatchObject({ title: "a", kind: "fecha", date: "2026-11-20", gcal: { id: "a", google: true } });
    const again = run([g("a")], [{ id: "s1", data: p.create[0] as Record<string, unknown> }]);
    expect(again).toEqual({ create: [], patch: [], remove: [], ownGone: [] });
  });
  it("actualiza lo que cambió en Google y borra lo que ya no está (si no tiene acta)", () => {
    const items = [
      { id: "s1", data: { title: "viejo", kind: "fecha", date: "2026-11-20", gcal: { id: "a", cal: "primary", updated: "2026-11-01T00:00:00Z", google: true } } },
      { id: "s2", data: { title: "b", kind: "fecha", date: "2026-11-21", gcal: { id: "b", cal: "primary", google: true } } },
      { id: "s3", data: { title: "c", kind: "reunion", date: "2026-11-22", actas: { "2026-11-22": "notas" }, gcal: { id: "c", cal: "primary", google: true } } },
    ];
    const p = run([g("a", { summary: "nuevo" })], items);
    expect(p.patch[0]).toMatchObject({ id: "s1", data: { title: "nuevo" } });
    expect(p.remove).toEqual(["s2"]);
    expect(p.patch[1]).toEqual({ id: "s3", data: { gcal: null } });
  });
  it("no importa eventos creados en Scriptorium y sigue si los movieron en Google", () => {
    const items = [
      { id: "own", data: { title: "Semanal", kind: "reunion", date: "2026-11-16", time: "09:00", end: "09:45", repeat: "no", gcal: { id: "x", cal: "primary", updated: "2026-11-10T00:00:00Z" } } },
      { id: "gone", data: { title: "Otra", kind: "fecha", date: "2026-11-18", gcal: { id: "y", cal: "primary" } } },
    ];
    const moved = g("x", { extendedProperties: { private: { scId: "own" } }, start: { dateTime: "2026-11-16T15:00:00Z" }, end: { dateTime: "2026-11-16T16:00:00Z" } });
    const p = run([moved], items);
    expect(p.create).toEqual([]);
    expect(p.patch[0]).toMatchObject({ id: "own", data: { time: "10:00", end: "11:00" } });
    expect(p.ownGone).toEqual(["gone"]);
  });
});
