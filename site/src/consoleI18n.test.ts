import { describe, expect, it } from "vitest";
import { CONSOLE_COPY, consoleZh, consoleEn, consoleEs, type ConsoleCopy } from "./consoleI18n";
import type { Lang } from "./i18n";

describe("Console i18n (src/consoleI18n.ts)", () => {
  const languages: Lang[] = ["zh", "en", "es"];

  it("exports copy for all 3 supported languages", () => {
    languages.forEach((lang) => {
      expect(CONSOLE_COPY[lang]).toBeDefined();
    });
  });

  it("contains valid and non-empty document titles in all languages", () => {
    expect(consoleZh.docTitle).toContain("控制台");
    expect(consoleEn.docTitle).toContain("Console");
    expect(consoleEs.docTitle).toContain("Consola");
  });

  it("has exactly matching keys across zh, en, and es dictionaries", () => {
    function compareObjectKeys(base: Record<string, any>, target: Record<string, any>, path = "") {
      for (const key of Object.keys(base)) {
        const fullPath = path ? `${path}.${key}` : key;
        expect(target[key], `Missing key "${fullPath}" in target translation`).toBeDefined();
        if (typeof base[key] === "object" && base[key] !== null && !Array.isArray(base[key])) {
          compareObjectKeys(base[key], target[key], fullPath);
        }
      }
    }

    compareObjectKeys(consoleZh, consoleEn, "en");
    compareObjectKeys(consoleZh, consoleEs, "es");
  });

  it("provides 13 localized month labels for heatmap in each language", () => {
    expect(consoleZh.activity.months).toHaveLength(13);
    expect(consoleZh.activity.months[0]).toBe("8月");

    expect(consoleEn.activity.months).toHaveLength(13);
    expect(consoleEn.activity.months[0]).toBe("Aug");

    expect(consoleEs.activity.months).toHaveLength(13);
    expect(consoleEs.activity.months[0]).toBe("Ago");
    expect(consoleEs.activity.months[1]).toBe("Sep");
    expect(consoleEs.activity.months[4]).toBe("Dic");
    expect(consoleEs.activity.months[5]).toBe("Ene");
  });

  it("formats dynamic string helpers correctly in Spanish", () => {
    expect(consoleEs.nav.onlineCount(2)).toBe("2 en línea");
    expect(consoleEs.remote.pairingSuccessNotice("PC-Lab")).toContain("¡Vinculación exitosa! “PC-Lab” está en línea");
    expect(consoleEs.activity.greetingSub(15)).toContain("Este es tu día 15 investigando");
    expect(consoleEs.activity.dailyCallsPeak(120)).toBe("Pico: 120/día");
    expect(consoleEs.activity.activeDaysTooltip(45)).toContain("45 días");
    expect(consoleEs.activity.heatmapCellCalls("2026-08-20", "98")).toBe("2026-08-20: 98 llamadas");
    expect(consoleEs.activity.heatmapCellZero("2026-08-19")).toBe("2026-08-19: 0 llamadas");
    expect(consoleEs.activity.topPartnerCooperated("500")).toBe("Colaboración reciente: 500 veces");
    expect(consoleEs.activity.secondPartnerInvocations("300")).toBe("Ejecutado 300 veces");
    expect(consoleEs.usage.pageSizeOption(20)).toBe("20 / pág");
    expect(consoleEs.usage.paginationInfo(1, 5, "48")).toBe("Página 1 de 5 · Total de 48 registros en los últimos 30 días");
    expect(consoleEs.plan.tagClusterGroup("Lab")).toBe("Grupo del Clúster: Lab");
    expect(consoleEs.plan.remainingPercent("65.2")).toBe("65.2% restante");
  });

  it("verifies Spanish navigation and tab titles", () => {
    expect(consoleEs.nav.activityFull).toBe("Panel de Actividad");
    expect(consoleEs.nav.usageFull).toBe("Uso de Cómputo");
    expect(consoleEs.nav.remoteFull).toBe("Espacio Remoto");
    expect(consoleEs.nav.planFull).toBe("Planes y Suscripción");
    expect(consoleEs.header.consoleBadge).toBe("Consola");
    expect(consoleEs.header.returnHome).toBe("Inicio");
    expect(consoleEs.header.logout).toBe("Cerrar sesión");
  });
});
