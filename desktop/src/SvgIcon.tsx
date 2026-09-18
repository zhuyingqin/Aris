import { createElement, type SVGProps } from "react";

export type SvgIconName =
  | "attachment"
  | "branch"
  | "check"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "chevronUp"
  | "circle"
  | "claude"
  | "clock"
  | "close"
  | "code"
  | "collection"
  | "copy"
  | "credit"
  | "desktop"
  | "diagram"
  | "document"
  | "download"
  | "edit"
  | "error"
  | "excluded"
  | "externalLink"
  | "fit"
  | "folder"
  | "graph"
  | "helpCircle"
  | "image"
  | "inbox"
  | "info"
  | "library"
  | "lightning"
  | "memory"
  | "minus"
  | "modified"
  | "moon"
  | "moreHorizontal"
  | "notebook"
  | "openai"
  | "pending"
  | "phone"
  | "pin"
  | "play"
  | "playwright"
  | "plus"
  | "refresh"
  | "reset"
  | "search"
  | "send"
  | "shieldCheck"
  | "sparkle"
  | "spinner"
  | "star"
  | "stop"
  | "sun"
  | "target"
  | "trash"
  | "user"
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
    case "branch":
      return [
        node("circle", { cx: 4.2, cy: 3.4, r: 1.45 }),
        node("circle", { cx: 11.8, cy: 5.2, r: 1.45 }),
        node("circle", { cx: 4.2, cy: 12.6, r: 1.45 }),
        node("path", { d: "M4.2 4.9v6.25M10.35 5.2H8.9A4.7 4.7 0 0 0 4.2 9.9", strokeLinecap: "round", strokeLinejoin: "round" }),
      ];
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
    case "claude":
      return [
        node("path", {
          d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
          fill: "currentColor",
          stroke: "none",
        }),
      ];
    case "clock":
      return [node("circle", { cx: 8, cy: 8, r: 5.2 }), node("path", { d: "M8 5v3.3l2.3 1.5", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "close":
      return [node("path", { d: "m4 4 8 8m0-8-8 8", strokeLinecap: "round" })];
    case "code":
      return [node("path", { d: "m5.5 4-3.2 4 3.2 4M10.5 4l3.2 4-3.2 4M9.2 2.8 6.8 13.2", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "collection":
      return [node("path", { d: "M3 3.2h10v9.6H3zM5 6.2h6M5 8.8h4", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "copy":
      return [node("rect", { x: 5, y: 3, width: 8, height: 9, rx: 1.1 }), node("path", { d: "M3 5.2v7.5c0 .7.5 1.3 1.2 1.3h6.3", strokeLinecap: "round" })];
    case "credit":
      return [node("circle", { cx: 8, cy: 8, r: 5.3 }), node("path", { d: "M9.9 5.4H7.2c-.9 0-1.5.5-1.5 1.2 0 1.8 4.6.8 4.6 2.9 0 .7-.6 1.2-1.5 1.2H6M8 4v8", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "desktop":
      return [node("rect", { x: 2.3, y: 3, width: 11.4, height: 8, rx: 1.2 }), node("path", { d: "M5 13.5h6M8 11v2.5", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "diagram":
      return [node("path", { d: "M3 12.5 7.7 3l5.3 9.5zM5.4 10.7h5.3M7.7 5.8v4.9", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "document":
      return [node("path", { d: "M9 2.4H4.6v11.2h6.8V4.8zM9 2.4v2.4h2.4M6.4 8.4h3.2M6.4 10.8h3.2", strokeLinecap: "round", strokeLinejoin: "round" })];
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
    case "helpCircle":
      return [node("circle", { cx: 8, cy: 8, r: 5.3 }), node("path", { d: "M6.4 6.1c.2-1 1-1.6 2.1-1.6 1.2 0 2.1.7 2.1 1.8 0 1.6-2.1 1.7-2.1 3M8.5 11.6h.01", strokeLinecap: "round" })];
    case "image":
      return [node("rect", { x: 2.5, y: 3, width: 11, height: 10, rx: 1.2 }), node("circle", { cx: 5.5, cy: 6.1, r: 0.7, fill: "currentColor", stroke: "none" }), node("path", { d: "m3.7 11 3-3 2.1 2.1 1.4-1.4 2.1 2.3", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "inbox":
      return [node("path", { d: "M2.7 4.1h10.6v7.8H2.7zM2.9 4.5 8 8.3l5.1-3.8", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "info":
      return [node("circle", { cx: 8, cy: 8, r: 5.3 }), node("path", { d: "M8 7.1v4M8 4.8h.01", strokeLinecap: "round" })];
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
    case "moon":
      return [node("path", { d: "M13.2 10.2A5.8 5.8 0 1 1 5.8 2.8a5.2 5.2 0 0 0 7.4 7.4z", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "moreHorizontal":
      return [node("circle", { cx: 3.5, cy: 8, r: 1, fill: "currentColor", stroke: "none" }), node("circle", { cx: 8, cy: 8, r: 1, fill: "currentColor", stroke: "none" }), node("circle", { cx: 12.5, cy: 8, r: 1, fill: "currentColor", stroke: "none" })];
    case "notebook":
      return [node("rect", { x: 3.2, y: 2.3, width: 9.5, height: 11.4, rx: 1.2 }), node("path", { d: "M5.4 2.3v11.4M2 5h2.4M2 8h2.4M2 11h2.4M7.7 6h2.6M7.7 8.7h2.6", strokeLinecap: "round" })];
    case "openai":
      return [
        node("path", {
          d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
          fill: "currentColor",
          stroke: "none",
        }),
      ];
    case "pending":
      return [node("circle", { cx: 8, cy: 8, r: 5.2 }), node("path", { d: "M8 5.2v3.1m0 2.4h.01", strokeLinecap: "round" })];
    case "phone":
      return [node("rect", { x: 4.8, y: 1.8, width: 6.4, height: 12.4, rx: 1.25 }), node("path", { d: "M6.8 11.9h2.4", strokeLinecap: "round" })];
    case "pin":
      return [node("path", { d: "m5.2 3 5.6 5.6m-4.4-7 5.6 5.6-1.8 1.8.7 2.4-3.1-1.2-2.8 2.8m3-6.8L4.6 8.6", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "play":
      return [node("path", { d: "m5.2 3.7 6.2 4.3-6.2 4.3z", fill: "currentColor", stroke: "none" })];
    case "playwright":
      return [
        node("path", {
          d: "M23.996 7.462c-.056.837-.257 2.135-.716 3.85-.995 3.715-4.27 10.874-10.42 9.227-6.15-1.65-5.407-9.487-4.412-13.201.46-1.716.934-2.94 1.305-3.694.42-.853.846-.289 1.815.523.684.573 2.41 1.791 5.011 2.488 2.601.697 4.706.506 5.583.352 1.245-.219 1.897-.494 1.834.455Zm-9.807 3.863s-.127-1.819-1.773-2.286c-1.644-.467-2.613 1.04-2.613 1.04Zm4.058 4.539-7.769-2.172s.446 2.306 3.338 3.153c2.862.836 4.43-.98 4.43-.981Zm2.701-2.51s-.13-1.818-1.773-2.286c-1.644-.469-2.612 1.038-2.612 1.038ZM8.57 18.23c-4.749 1.279-7.261-4.224-8.021-7.08C.197 9.831.044 8.832.003 8.188c-.047-.73.455-.52 1.415-.354.677.118 2.3.261 4.308-.28a11.28 11.28 0 0 0 2.41-.956c-.058.197-.114.4-.17.61-.433 1.618-.827 4.055-.632 6.426-1.976.732-2.267 2.423-2.267 2.423l2.524-.715c.227 1.002.6 1.987 1.15 2.838a5.914 5.914 0 0 1-.171.049Zm-4.188-6.298c1.265-.333 1.363-1.631 1.363-1.631l-3.374.888s.745 1.076 2.01.743Z",
          fill: "currentColor",
          stroke: "none",
        }),
      ];
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
    case "shieldCheck":
      return [node("path", { d: "M8 2.1 12.8 4v3.7c0 2.9-1.9 5.1-4.8 6.3-2.9-1.2-4.8-3.4-4.8-6.3V4z", strokeLinejoin: "round" }), node("path", { d: "m5.8 7.8 1.5 1.5 3-3", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "sparkle":
      return [node("path", { d: "M8 1.8 9.5 6.5 14.2 8 9.5 9.5 8 14.2 6.5 9.5 1.8 8 6.5 6.5Z", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "spinner":
      return [node("circle", { cx: 8, cy: 8, r: 5.3, opacity: 0.28 }), node("path", { d: "M8 2.7a5.3 5.3 0 0 1 5.3 5.3", strokeLinecap: "round" })];
    case "star":
      return [node("path", { d: "m8 2.3 1.65 3.62 3.95.45-2.93 2.64.8 3.86L8 11.05 4.53 12.9l.8-3.86L2.4 6.4l3.95-.45z", strokeLinejoin: "round" })];
    case "stop":
      return [node("rect", { x: 4.2, y: 4.2, width: 7.6, height: 7.6, rx: 0.8, fill: "currentColor", stroke: "none" })];
    case "sun":
      return [
        node("circle", { cx: 8, cy: 8, r: 3.2 }),
        node("path", { d: "M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7l-1.3-1.3", strokeLinecap: "round" }),
      ];
    case "target":
      return [node("circle", { cx: 8, cy: 8, r: 4.8 }), node("circle", { cx: 8, cy: 8, r: 1.5 }), node("path", { d: "M11.4 4.6 13.2 2.8M11.2 2.8h2v2", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "trash":
      return [node("path", { d: "M3.3 4.5h9.4M6.1 2.6h3.8M4.4 4.5l.5 8.6h6.2l.5-8.6M6.5 6.4v4.7m3-4.7v4.7", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "user":
      return [node("circle", { cx: 8, cy: 5.4, r: 2.3 }), node("path", { d: "M3.7 13.3v-.9c0-2.2 1.7-3.7 4.3-3.7s4.3 1.5 4.3 3.7v.9", strokeLinecap: "round", strokeLinejoin: "round" })];
    case "warning":
      return [node("path", { d: "m8 2.6 5.3 9.4H2.7zM8 5.8v3M8 10.8h.01", strokeLinecap: "round", strokeLinejoin: "round" })];
  }
}

function isBrand24Icon(name: SvgIconName) {
  return name === "claude" || name === "openai" || name === "playwright";
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
  const brand24 = isBrand24Icon(name);
  return createElement(
    "svg",
    {
      className: ["svg-icon", className].filter(Boolean).join(" "),
      width: size,
      height: size,
      viewBox: brand24 ? "0 0 24 24" : "0 0 16 16",
      fill: brand24 ? "currentColor" : "none",
      stroke: brand24 ? "none" : "currentColor",
      strokeWidth: brand24 ? 0 : 1.45,
      "aria-hidden": true,
      "data-icon": name,
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
  const brand24 = isBrand24Icon(name);
  svg.setAttribute("class", ["svg-icon", className].filter(Boolean).join(" "));
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", brand24 ? "0 0 24 24" : "0 0 16 16");
  svg.setAttribute("fill", brand24 ? "currentColor" : "none");
  svg.setAttribute("stroke", brand24 ? "none" : "currentColor");
  if (!brand24) svg.setAttribute("stroke-width", "1.45");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-icon", name);
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
