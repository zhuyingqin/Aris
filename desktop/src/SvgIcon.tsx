import { createElement, type SVGProps } from "react";

export type SvgIconName =
  | "attachment"
  | "check"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "chevronUp"
  | "circle"
  | "clock"
  | "close"
  | "collection"
  | "diagram"
  | "download"
  | "edit"
  | "error"
  | "excluded"
  | "externalLink"
  | "fit"
  | "folder"
  | "graph"
  | "image"
  | "inbox"
  | "library"
  | "lightning"
  | "memory"
  | "minus"
  | "modified"
  | "pending"
  | "pin"
  | "play"
  | "plus"
  | "refresh"
  | "reset"
  | "search"
  | "send"
  | "sparkle"
  | "spinner"
  | "star"
  | "stop"
  | "target"
  | "warning";

type IconElement = "circle" | "path" | "rect";

interface IconNode {
  element: IconElement;
  props: SVGProps<SVGCircleElement | SVGPathElement | SVGRectElement>;
}

const node = (
  element: IconElement,
  props: SVGProps<SVGCircleElement | SVGPathElement | SVGRectElement>,
): IconNode => ({ element, props });

function iconNodes(name: SvgIconName): IconNode[] {
  switch (name) {
    case "attachment":
      return [node("path", { d: "m11.7 6-4.8 4.8a2.4 2.4 0 1 1-3.4-3.4l5-5a3.45 3.45 0 0 1 4.9 4.9l-5.2 5.2", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "check":
      return [node("path", { d: "m3.3 8.1 2.8 2.8 6.6-6.6", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "chevronDown":
      return [node("path", { d: "m3.5 6 4.5 4.5L12.5 6", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "chevronLeft":
      return [node("path", { d: "m10 3.5L5.5 8l4.5 4.5", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "chevronRight":
      return [node("path", { d: "m6 3.5 4.5 4.5L6 12.5", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "chevronUp":
      return [node("path", { d: "m3.5 10 4.5-4.5 4.5 4.5", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "circle":
      return [node("circle", { cx: 8, cy: 8, r: 5.2, fill: "currentColor", stroke: "none" })];
    case "clock":
      return [node("circle", { cx: 8, cy: 8, r: 5.2 }), node("path", { d: "M8 5v3.3l2.3 1.5", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "close":
      return [node("path", { d: "m4 4 8 8m0-8-8 8", strokeLinecap: "round" })];
    case "collection":
      return [node("path", { d: "M3 3.2h10v9.6H3zM5 6.2h6M5 8.8h4", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "diagram":
      return [node("path", { d: "M3 12.5 7.7 3l5.3 9.5zM5.4 10.7h5.3M7.7 5.8v4.9", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "download":
      return [node("path", { d: "M8 2.7v6.7m-2.7-2.7L8 9.4l2.7-2.7M3 12.8h10", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "edit":
      return [node("path", { d: "m3.2 11.9.8-3.1 6.8-6.8 2.2 2.2-6.8 6.8zM9.6 3.2l2.2 2.2M3.2 11.9 6 12.8", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "error":
      return [node("circle", { cx: 8, cy: 8, r: 5.25 }), node("path", { d: "M8 5.1v3.2M8 10.8h.01", strokeLinecap: "round" })];
    case "excluded":
      return [node("circle", { cx: 8, cy: 8, r: 5.25 }), node("path", { d: "m4.5 4.5 7 7", strokeLinecap: "round" })];
    case "externalLink":
      return [node("path", { d: "M6.2 3H3.8A1.3 1.3 0 0 0 2.5 4.3v7.9a1.3 1.3 0 0 0 1.3 1.3h7.9a1.3 1.3 0 0 0 1.3-1.3V9.8M8.2 2.8H13v4.8M7.4 8.6 13 3", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "fit":
      return [node("path", { d: "M6.3 2.8H2.8v3.5M9.7 2.8h3.5v3.5M13.2 9.7v3.5H9.7M2.8 9.7v3.5h3.5", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "folder":
      return [node("path", { d: "M2.4 4.2h4l1.1 1.4h6.1v6.2a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "graph":
      return [node("circle", { cx: 4, cy: 5, r: 1.25 }), node("circle", { cx: 12, cy: 4, r: 1.25 }), node("circle", { cx: 9.5, cy: 12, r: 1.25 }), node("path", { d: "m5.1 5.4 5.7-1M4.8 6l4 4.9m2.1-5.8-1 5.6", strokeLinecap: "round" })];
    case "image":
      return [node("rect", { x: 2.5, y: 3, width: 11, height: 10, rx: 1.2 }), node("circle", { cx: 5.5, cy: 6.1, r: 0.7, fill: "currentColor", stroke: "none" }), node("path", { d: "m3.7 11 3-3 2.1 2.1 1.4-1.4 2.1 2.3", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "inbox":
      return [node("path", { d: "M2.7 4.1h10.6v7.8H2.7zM2.9 4.5 8 8.3l5.1-3.8", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "library":
      return [node("path", { d: "M3 3h3v10H3zM7 3h2.5v10H7zM10.5 3H13v10h-2.5z", strokeLinejoin: "round" })];
    case "lightning":
      return [node("path", { d: "m9.1 2.3-5 6h3.7l-.9 5.4 5-6H8.2z", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "memory":
      return [node("path", { d: "m8 2.7 5.3 5.3L8 13.3 2.7 8z", strokeLinejoin: "round" }), node("circle", { cx: 8, cy: 8, r: 1.05, fill: "currentColor", stroke: "none" })];
    case "minus":
      return [node("path", { d: "M3.5 8h9", strokeLinecap: "round" })];
    case "modified":
      return [node("path", { d: "M5 3.2v9.6M11 3.2v9.6M2.8 5.5h4.4m3.6 5h2.4", strokeLinecap: "round" })];
    case "pending":
      return [node("circle", { cx: 8, cy: 8, r: 5.2 }), node("path", { d: "M8 5.2v3.1m0 2.4h.01", strokeLinecap: "round" })];
    case "pin":
      return [node("path", { d: "m5.2 3 5.6 5.6m-4.4-7 5.6 5.6-1.8 1.8.7 2.4-3.1-1.2-2.8 2.8m3-6.8L4.6 8.6", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "play":
      return [node("path", { d: "m5.2 3.7 6.2 4.3-6.2 4.3z", fill: "currentColor", stroke: "none" })];
    case "plus":
      return [node("path", { d: "M8 3.5v9M3.5 8h9", strokeLinecap: "round" })];
    case "refresh":
      return [node("path", { d: "M12.5 5.4A5 5 0 1 0 13 8M12.5 2.8v2.6H9.9", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "reset":
      return [node("path", { d: "M4.3 5.1A5 5 0 1 1 3 8M4.3 5.1H2.5V3.3", strokeLinecap: "round", strokeLinejoin: "round" }), node("path", { d: "M8 5.2v3l2.1 1.3", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "search":
      return [node("circle", { cx: 7, cy: 7, r: 3.8 }), node("path", { d: "m9.9 9.9 3 3", strokeLinecap: "round" })];
    case "send":
      return [node("path", { d: "m2.7 3.2 10.6 4.7-10.6 4.9 1.7-4.1zM4.4 8h5.7", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "sparkle":
      return [node("path", { d: "m8 2.2.9 4.9 4.9.9-4.9.9L8 13.8l-.9-4.9-4.9-.9 4.9-.9z", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "spinner":
      return [node("circle", { cx: 8, cy: 8, r: 5.3, opacity: 0.28 }), node("path", { d: "M8 2.7a5.3 5.3 0 0 1 5.3 5.3", strokeLinecap: "round" })];
    case "star":
      return [node("path", { d: "m8 2.3 1.65 3.62 3.95.45-2.93 2.64.8 3.86L8 11.05 4.53 12.9l.8-3.86L2.4 6.4l3.95-.45z", strokeLinejoin: "round" })];
    case "stop":
      return [node("rect", { x: 4.2, y: 4.2, width: 7.6, height: 7.6, rx: 0.8, fill: "currentColor", stroke: "none" })];
    case "target":
      return [node("circle", { cx: 8, cy: 8, r: 4.8 }), node("circle", { cx: 8, cy: 8, r: 1.5 }), node("path", { d: "M11.4 4.6 13.2 2.8M11.2 2.8h2v2", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "warning":
      return [node("path", { d: "m8 2.6 5.3 9.4H2.7zM8 5.8v3M8 10.8h.01", strokeLinecap: "round", strokeLinejoin: "round" })];
  }
}

export function SvgIcon({
  name,
  size = 16,
  className,
}: {
  name: SvgIconName;
  size?: number;
  className?: string;
}) {
  return createElement(
    "svg",
    {
      className: ["svg-icon", className].filter(Boolean).join(" "),
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.45,
      "aria-hidden": true,
      focusable: false,
    },
    iconNodes(name).map((entry, index) => createElement(entry.element, { ...entry.props, key: index })),
  );
}

function svgAttributeName(name: string) {
  if (name === "viewBox") return name;
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

/** Build the same SVG icon for imperative DOM code (for example CodeMirror widgets). */
export function createSvgIcon(name: SvgIconName, size = 16, className?: string) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", ["svg-icon", className].filter(Boolean).join(" "));
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.45");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const entry of iconNodes(name)) {
    const element = document.createElementNS(namespace, entry.element);
    for (const [key, value] of Object.entries(entry.props)) {
      if (value != null) element.setAttribute(svgAttributeName(key), String(value));
    }
    svg.append(element);
  }
  return svg;
}
