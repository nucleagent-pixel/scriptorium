import { describe, expect, it } from "vitest";
import { planSync } from "../src/sync";

describe("sincronizar productos", () => {
  it("crea, enlaza y archiva sin duplicar", () => {
    const offers = [
      { id: "o1", name: "Reto Pilates", archived: false },
      { id: "o2", name: "Nutre", archived: false },
      { id: "o3", name: "Viejo", archived: true },
      { id: "o4", name: "Nuevo", archived: false },
    ];
    const products = [
      { id: "p1", data: { name: "Mi reto", offer: "o1", status: "activo" } },
      { id: "p2", data: { name: "nutre ", status: "activo" } },
      { id: "p3", data: { name: "Viejo", offer: "o3", status: "activo" } },
    ];
    const { create, patch } = planSync(offers, products);
    expect(create.map((c) => c.name)).toEqual(["Nuevo"]);
    expect(create[0]).toMatchObject({ offer: "o4", status: "activo" });
    expect(patch).toEqual([
      { id: "p2", data: { offer: "o2" }, kind: "enlazado", name: "Nutre" },
      { id: "p3", data: { status: "archivado" }, kind: "archivado", name: "Viejo" },
    ]);
    // Segunda vez no hace nada.
    const again = planSync(offers, [...products.map((p) => p.id === "p3" ? { ...p, data: { ...p.data, status: "archivado" } } : p), { id: "p4", data: { name: "Nuevo", offer: "o4" } }]);
    expect(again).toEqual({ create: [], patch: [] });
  });
});
