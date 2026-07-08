import type { MathfieldElement } from "mathlive";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "math-field": React.DetailedHTMLProps<
        React.HTMLAttributes<MathfieldElement> & {
          "read-only"?: string;
          class?: string;
        },
        MathfieldElement
      >;
    }
  }
}

export {};
