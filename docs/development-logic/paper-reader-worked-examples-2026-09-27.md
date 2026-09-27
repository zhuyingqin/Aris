# Required worked examples

New teaching lessons require a nonempty example (up to 8000 characters). The generation prompt requests a small self-contained problem with givens, a question, intermediate solution steps, an answer, and an explicit connection to the paper. Conceptual and visual topics use a concrete input traced through the mechanism; numeric problems show substitutions and intermediate values. Constructed inputs are teaching data, not reported paper experiments. A separate understanding question does not replace the worked solution.

The existing structured-output correction path receives an actionable error when the example is missing, null, blank, or too long. The string-based schema is retained to avoid introducing a new object/string compatibility problem. Structural validation enforces presence and size; it does not prove arithmetic correctness or teaching quality. The model is instructed to recompute arithmetic, and live teaching quality still needs model acceptance testing.

Saved lessons remain deserializable without examples, and cached completed results are not rewritten or silently regenerated. The requirement applies to newly generated lessons. The reader labels the section “简单例题：一步步算明白” and retains the teaching-example disclaimer.
