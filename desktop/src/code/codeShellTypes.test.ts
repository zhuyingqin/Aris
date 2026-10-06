import { execFileSync } from "node:child_process";
import path from "node:path";
import { it } from "vitest";

it("keeps the editor shell TypeScript DTOs generated from the Rust protocol", () => {
  execFileSync(process.execPath, [path.resolve(__dirname, "../../scripts/generate-code-shell-types.cjs"), "--check"]);
});
