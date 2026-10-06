import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isChatCompanionMode } from "./ChatCompanion";

const appStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const colorStyles = readFileSync(new URL("../uiColors.css", import.meta.url), "utf8");

const declarations = (body: string) => Object.fromEntries(
  [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
);

function colorChannels(value: string, palette: Record<string, string>): number[] {
  const variable = value.match(/^var\((--[\w-]+)\)$/);
  if (variable) return colorChannels(palette[variable[1]], palette);
  const mix = value.match(/^color-mix\(in srgb,\s*(var\(--[\w-]+\))\s*(\d+)%,\s*(var\(--[\w-]+\))\)$/);
  if (mix) {
    const first = colorChannels(mix[1], palette);
    const second = colorChannels(mix[3], palette);
    const weight = Number(mix[2]) / 100;
    return first.map((channel, i) => channel * weight + second[i] * (1 - weight));
  }
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) throw new Error(`Unsupported theme color: ${value}`);
  const hex = value.length === 4 ? value.slice(1).split("").map((digit) => digit + digit).join("") : value.slice(1);
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function luminance(channels: number[]): number {
  return channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
}

describe("isChatCompanionMode", () => {
  it("recognizes the dedicated Chat companion query", () => {
    expect(isChatCompanionMode("?companion=chat")).toBe(true);
    expect(isChatCompanionMode("?theme=dark&companion=chat")).toBe(true);
  });

  it("recognizes the native companion window by label without a query", () => {
    expect(isChatCompanionMode("", "chat-companion")).toBe(true);
  });

  it("leaves normal and unrelated windows on the main app route", () => {
    expect(isChatCompanionMode("")).toBe(false);
    expect(isChatCompanionMode("?companion=typeset")).toBe(false);
  });
});

describe("Chat companion theme contract", () => {
  it("defines the sidebar palette on the shared Chat root instead of requiring the main app shell", () => {
    expect(appStyles).toMatch(
      /\.chat-root\s*{[^}]*--chat-sidebar-bg:\s*#101720;/s,
    );
    expect(appStyles).toMatch(
      /:root\[data-theme="light"\] \.chat-root\s*{[^}]*--chat-sidebar-bg:\s*#f8fafc;/s,
    );
  });

  it("keeps send-button text readable on hover with every light-theme accent", () => {
    const light = [...appStyles.matchAll(/:root\[data-theme="light"\]\s*{([^}]+)}/g)]
      .reduce((palette, match) => ({ ...palette, ...declarations(match[1]) }), {} as Record<string, string>);
    const button = declarations(appStyles.match(/(?:^|\n)\.chat-send-btn\s*{([^}]+)}/)![1]);
    const hover = declarations(appStyles.match(/\.chat-send-btn:not\(\.chat-stop-btn\):hover:not\(:disabled\)\s*{([^}]+)}/)![1]);
    const accents = [...colorStyles.matchAll(/--ui-color-light:\s*(#[\da-f]+);/gi)].map(([, color]) => color);
    expect(accents.length).toBeGreaterThan(1);
    for (const accent of [light["--accent"], ...accents]) {
      const palette = { ...light, "--accent": accent };
      const foreground = luminance(colorChannels(hover.color ?? button.color, palette));
      const background = luminance(colorChannels(hover.background ?? button.background, palette));
      expect((Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05), accent)
        .toBeGreaterThanOrEqual(4.5);
    }
  });
});
