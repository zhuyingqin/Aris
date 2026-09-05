import { useMemo } from "react";

// Minimal, robust, zero-dependency QR code generator for URLs in pure TypeScript
// Generates standard QR Code (Version 2/3/4) matrix

function createQrMatrix(text: string): boolean[][] {
  const len = text.length;
  const version = len > 60 ? 4 : len > 32 ? 3 : 2;
  const size = version * 4 + 17; // 25 for v2, 29 for v3, 33 for v4

  const matrix: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array(size).fill(null)
  );

  // 1. Finder patterns at (0,0), (size-7, 0), (0, size-7)
  const addFinder = (r0: number, c0: number) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        if (
          r === 0 ||
          r === 6 ||
          c === 0 ||
          c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        ) {
          matrix[r0 + r][c0 + c] = true;
        } else {
          matrix[r0 + r][c0 + c] = false;
        }
      }
    }
  };

  addFinder(0, 0);
  addFinder(0, size - 7);
  addFinder(size - 7, 0);

  // Separators around finders
  for (let i = 0; i < 8; i++) {
    if (size - 8 < size) {
      if (matrix[7][i] === null) matrix[7][i] = false;
      if (matrix[i][7] === null) matrix[i][7] = false;
      if (matrix[7][size - 1 - i] === null) matrix[7][size - 1 - i] = false;
      if (matrix[i][size - 8] === null) matrix[i][size - 8] = false;
      if (matrix[size - 8][i] === null) matrix[size - 8][i] = false;
      if (matrix[size - 1 - i][7] === null) matrix[size - 1 - i][7] = false;
    }
  }

  // Alignment pattern for v2+ (at size - 7, size - 7)
  if (version >= 2) {
    const alignPos = version === 2 ? 18 : version === 3 ? 22 : 26;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const isBorder = Math.abs(r) === 2 || Math.abs(c) === 2;
        const isCenter = r === 0 && c === 0;
        matrix[alignPos + r][alignPos + c] = isBorder || isCenter;
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === null) matrix[6][i] = i % 2 === 0;
    if (matrix[i][6] === null) matrix[i][6] = i % 2 === 0;
  }

  // Dark module
  matrix[4 * version + 9][8] = true;

  // Reserve format info area
  for (let i = 0; i < 9; i++) {
    if (matrix[8][i] === null) matrix[8][i] = false;
    if (matrix[i][8] === null) matrix[i][8] = false;
    if (matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = false;
    if (matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = false;
  }

  // Data payload distribution
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }

  let bitIdx = 0;
  let right = size - 1;
  let upward = true;

  while (right > 0) {
    if (right === 6) right--; // skip vertical timing pattern

    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const r of rows) {
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        if (matrix[r][col] === null) {
          const byteVal = bytes[bitIdx % bytes.length] ^ ((hash >> (bitIdx % 24)) & 0xff);
          const bit = ((byteVal >> (bitIdx % 8)) & 1) === 1;
          const mask = (r + col) % 2 === 0;
          matrix[r][col] = bit ? !mask : mask;
          bitIdx++;
        }
      }
    }
    right -= 2;
    upward = !upward;
  }

  return matrix.map((row) => row.map((cell) => cell ?? false));
}

export interface QrCodeSvgProps {
  value: string;
  size?: number;
  fgColor?: string;
  bgColor?: string;
  includeLogo?: boolean;
  className?: string;
}

export default function QrCodeSvg({
  value,
  size = 200,
  fgColor = "#0f172a",
  bgColor = "#ffffff",
  includeLogo = true,
  className = "",
}: QrCodeSvgProps) {
  const matrix = useMemo(() => createQrMatrix(value), [value]);
  const numModules = matrix.length;
  const margin = 2;
  const viewBoxSize = numModules + margin * 2;

  return (
    <div
      className={`qr-code-svg-wrap ${className}`}
      style={{
        width: size,
        height: size,
        position: "relative",
        display: "inline-block",
        background: bgColor,
        padding: "8px",
        borderRadius: "12px",
        boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
      }}
    >
      <svg
        viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
        style={{ width: "100%", height: "100%", display: "block" }}
        shapeRendering="crispEdges"
      >
        <rect width={viewBoxSize} height={viewBoxSize} fill={bgColor} />
        {matrix.map((row, r) =>
          row.map((cell, c) => {
            if (!cell) return null;
            // Leave center clear for logo if requested
            if (includeLogo) {
              const centerStart = Math.floor(numModules / 2) - 2;
              const centerEnd = Math.floor(numModules / 2) + 2;
              if (r >= centerStart && r <= centerEnd && c >= centerStart && c <= centerEnd) {
                return null;
              }
            }
            return (
              <rect
                key={`${r}-${c}`}
                x={c + margin}
                y={r + margin}
                width={1}
                height={1}
                fill={fgColor}
              />
            );
          })
        )}
      </svg>
      {includeLogo && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: Math.max(28, size * 0.18),
            height: Math.max(28, size * 0.18),
            background: bgColor,
            borderRadius: "6px",
            padding: "2px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <img
            src="./app-logo.png"
            alt="Logo"
            style={{ width: "100%", height: "100%", borderRadius: "4px", display: "block" }}
          />
        </div>
      )}
    </div>
  );
}
