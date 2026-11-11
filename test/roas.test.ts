import { describe, expect, it } from "vitest";
import { bogotaDate, toRoasRows } from "../src/roas";

describe("ROAS", () => {
  it("calcula neto ÷ pauta por oferta y país", () => {
    const rows = toRoasRows([
      { offer_id: "a", producto: "Reto", archivado: false, country: "co", ventas: 10, neto_cop: "360000", pauta_cop: "200000" },
      { offer_id: "a", producto: "Reto", archivado: false, country: "VE", ventas: 2, neto_cop: 50000, pauta_cop: 0 },
      { offer_id: null, producto: null, archivado: false, country: "CL", ventas: 1, neto_cop: 1, pauta_cop: 1 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ country: "CO", roas: 1.8 });
    expect(rows[1].roas).toBeNull();
  });

  it("usa la fecha de Colombia", () => {
    // 03:00 UTC del 12 es todavía el 11 en Bogotá (UTC-5).
    const now = new Date("2026-11-12T03:00:00Z");
    expect(bogotaDate(now)).toBe("2026-11-11");
    expect(bogotaDate(now, -2)).toBe("2026-11-09");
  });
});
