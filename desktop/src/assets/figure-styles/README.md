# Discipline-specific scientific examples

Six original, complex domain scenes accompany SomniQ's scientific visual families:

- [Communications / OFDM transceiver](ofdm-v3.webp): technical schematic with transmitter/receiver routing, pilot-assisted equalization and a cyclic-prefix inset.
- [Probabilistic models / hidden Markov inference](hmm-v3.webp): latent/observed node geometry, state marginals and the best joint path as separate inference tasks.
- [Bioinformatics / single-cell multiome](multiome-v3.webp): paired RNA/ATAC panels, modality-specific processing, WNN integration and annotation evidence.
- [Deep learning / Transformer encoder](transformer-v3.webp): embedding/positional addition, two post-normalization residual routes, Q/K/V and multi-head attention detail.
- [Research agents / independent review](research_agents-v3.webp): planning, execution, tools, evidence, independent review, revision and local context.
- [Biochemistry / EGFR–MAPK signaling](mapk-v3.webp): cellular compartments, receptor recruitment, RAS nucleotide exchange, phosphorylation cascade and selected inhibitory feedback.

These are simplified conceptual illustrations with no experimental results, numerical parameters or atomic structures. Classical architecture sources identify the model illustrated; they are not presented as new research. Scenario sources and bilingual drawing requirements are in `desktop/src/figures/figureScenarios.ts`. Visual families remain usable across disciplines. Palette/layout/spacing/print controls affect future generated figures, not the static examples.

Created with the built-in `image_gen.imagegen` tool: six initial generations and four corrective edits. [generation-v3.json](generation-v3.json) records every exact prompt, original/corrective source and final output filename. Corrections fix token-to-embedding wiring, attention-head annotation, RNA QC terminology and independent-review provenance. Final assets preserve the generated 1536 × 1024 canvas as WebP, quality 92, total 831,138 bytes. No crop or resize is applied. All six are bundled locally; browsing and loading their descriptions submit no model requests.

The gallery supports detail viewing and original-size scrolling. Choosing a visual family preserves the user's description. Loading a scenario explicitly inserts its requirements; the button identifies replacement when a description exists. Both actions retain the independent visual options and are disabled while a reference image is imported.

The six v2 training-loop examples and [generation-v2.json](generation-v2.json), plus the four earlier Academic/Minimal/Soft panels/Print examples and [generation.json](generation.json), remain as historical provenance and are not imported by the current picker. Historical task prompt strings remain supported.

The catalog and versioned contracts are in `desktop/src/figures/figureStyles.ts`; research sources and persistence behavior are documented in [the style-system design](../../../../docs/development-logic/figure-style-system.md).
