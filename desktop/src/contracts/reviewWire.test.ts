// The Rust structs behind these types are written by hand on both sides. The
// shared sample (reviewWire.json) is what Rust serializes, checked by
// `review_wire_types_match_the_shared_sample` in the desktop crate; here the
// TS types are held to the same field names. `satisfies` makes `npm run
// typecheck` fail when a field is added to or removed from a TS type without
// updating the list, and the runtime check fails when the sample disagrees.
import { describe, expect, it } from "vitest";
import type { ReviewRubricRecord } from "../api/tauri";
import type { WorkTaskOrigin } from "../types";
import sample from "./reviewWire.json";

type Check = NonNullable<ReviewRubricRecord["checks"]>[number];

const RECORD_FIELDS = { delivered: 1, omitted: 1, checks: 1, unknownCriteria: 1, verdictCorrected: 1 } satisfies Record<keyof ReviewRubricRecord, 1>;
const CHECK_FIELDS = { criterion: 1, severity: 1, result: 1, note: 1 } satisfies Record<keyof Check, 1>;
const ORIGIN_FIELDS = { pluginName: 1, panelId: 1, reportPanel: 1, reportWidget: 1 } satisfies Record<keyof WorkTaskOrigin, 1>;

const keys = (value: object) => Object.keys(value).sort();

describe("review wire types", () => {
  it("name the same fields as the Rust structs", () => {
    expect(keys(sample.reviewRubricRecord)).toEqual(keys(RECORD_FIELDS));
    expect(keys(sample.reviewRubricRecord.checks[0])).toEqual(keys(CHECK_FIELDS));
    expect(keys(sample.workTaskOrigin)).toEqual(keys(ORIGIN_FIELDS));
  });

  it("use the result values the Rust enum serializes", () => {
    const result: Check["result"] = sample.reviewRubricRecord.checks[0].result as Check["result"];
    expect(["met", "violated", "not_applicable", "unverified", "unreported"]).toContain(result);
  });
});
