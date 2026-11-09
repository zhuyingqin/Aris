# SomniQ scientific figure styles

SomniQ separates scientific content from visual representation. A family changes geometry, connector routing, hierarchy and icon/detail vocabulary. Layout, palette, spacing and print adaptation remain independent settings. Selecting a family preserves those settings and the user's description.

## Research basis

The families below are SomniQ design choices, not paper authors' preset names or official venue standards. The research informs the dimensions of control and the separation of appearance from scientific meaning.

- [AutoFigure-Edit, ACL 2026](https://aclanthology.org/2026.acl-demo.6/) and its [author repository](https://github.com/ResearAI/AutoFigure-Edit): reference-guided appearance beyond palette, including typography, icon aesthetics, density and hierarchy, while preserving semantics.
- [PaperDraw, available online 5 June 2026](https://doi.org/10.1016/j.visinf.2026.100333): visual candidates informed by structure and controllable layout. SomniQ currently supplies a curated catalog; it does not implement the paper's retrieval or optimization algorithm.
- [FigTree / Figures as Programs, 1 September 2026 preprint](https://arxiv.org/abs/2609.01006): separate grounded content from a shared global style specification covering fonts, palette, strokes, arrows and spacing. SomniQ adopts a saved global contract, not FigTree's recursive generation pipeline.
- [PaperBanana-Interact, 31 August 2026 preprint](https://arxiv.org/abs/2608.30241): multi-turn figure refinement motivates retaining accepted choices during subsequent changes. SomniQ's current document and confirmed raster take precedence over restyling unrelated content.
- [PaperBanana's author-authored diagram guide](https://github.com/dwzhu-pku/PaperBanana/blob/main/style_guides/neurips2025_diagram_style_guide.md): semantic shapes, matrix stacks, grouped panels and diagram-specific visual vocabularies. The guide is not an official NeurIPS style specification.

## Visual families

| Family | Geometry and hierarchy | Typical use |
| --- | --- | --- |
| Technical schematic | Data sheets, process blocks and ports, justified comparison diamonds, orthogonal arrows | Algorithm and system architecture |
| Abstract graph | Open vertices/operators and direct edges, sparse annotations | Theory, state transitions and relationships |
| Modular panels | Parent groups and aligned child modules, explicit two-level hierarchy | Multi-stage methods and complex systems |
| Tensor & spatial | Matrix stacks, planes, cutaways and a consistent shallow projection; horizontal labels | Feature maps and spatial processing |
| Pictogram narrative | Matching semantic icons and directed reading paths | Agent, document and tool workflows |
| Scientific illustration | Contour objects with internal detail and leader labels | Mechanisms and graphical abstracts |

Every family must respect supplied labels, relationships, arrow directions and evidence. Choosing a tensor style does not authorize invented tensor dimensions; choosing an illustration style does not authorize invented physical or biological mechanisms. Color is never the sole carrier of meaning. Explicit content/layout requests take precedence over aesthetic defaults.

## Persistence and generation

`desktop/src/figures/figureStyles.ts` owns the catalog, versioned contract compiler, parser and legacy mappings. Each contract starts with `SomniQ style v1:` and contains enumerated family/layout/palette/density/print choices followed by the full human-readable drawing rules. All 324 combinations fit the native 2,000-byte UTF-8 style limit.

The existing `style: string` field remains the transport and persistence boundary. `FigureStudio` forwards it unchanged to `figurePrepare`; the manifest freezes it; the native image prompt planner, raster edits and SVG reconstruction already consume that stored field. There are no new paid calls, remote style fetches or changes to the Executor → independent Reviewer loop.

Opening historical runs never recompiles their text. Four old preset strings retain their old display names and map to controls only when reused in the composer. Unknown custom text, invalid metadata and future contract versions remain unmodified until the user explicitly selects a family. Future incompatible rule changes should bump the contract version, not reinterpret stored prompts.

An uploaded image remains an import/reconstruction source, not a style exemplar. While it is attached, controls and gallery selection are disabled, browsing remains available, and the original draft style is retained for use if the image is removed. Confirmed raster/current SVG appearance takes precedence during reconstruction and localized edits.

## Examples and validation

The current examples are discipline-specific professional scenarios, rather than six renderings of one generic training loop. `figureScenarios.ts` keeps their scientific requirements and references separate from appearance contracts. Locally bundled 1536 × 1024 WebP images show the domain's branches, feedback, compartments and internal structure. Exact generation and corrective edit prompts are in `desktop/src/assets/figure-styles/generation-v3.json`. The former controlled training-loop examples remain historical provenance and are not loaded by the picker.

| Discipline / scene | Visual family | Scientific conventions and reference |
| --- | --- | --- |
| Communications / OFDM transceiver | Technical schematic | Pilots before IFFT, CP removal before FFT, received pilots plus known reference support estimation, estimate enters equalization. [Official MathWorks example](https://www.mathworks.com/help/comm/ug/ofdm-transmitter-and-receiver.html). |
| Probabilistic models / HMM inference | Abstract graph | Latent-state transitions and downward emissions; forward–backward marginals differ from Viterbi's best joint path. [Rabiner's foundational tutorial](https://doi.org/10.1109/5.18626). |
| Bioinformatics / paired single-cell multiome | Modular panels | Same-cell RNA and ATAC preprocessing remains separate; PCA and LSI both enter WNN; annotation uses molecular evidence. [Hao et al.](https://doi.org/10.1016/j.cell.2021.04.048), [Seurat's maintained WNN example](https://satijalab.org/seurat/articles/weighted_nearest_neighbor_analysis). |
| Deep learning / Transformer encoder | Tensor & spatial | Original post-norm encoder, two residual routes, self-attention Q/K/V projections and a distinct detail inset. [Attention Is All You Need](https://arxiv.org/abs/1706.03762). |
| Research agents / independent review | Pictogram narrative | Experiment plan and results reach an independent Reviewer; revision returns to Executor; local memory is contextual. Based on SomniQ's product architecture, not a claim about a published experiment. |
| Biochemistry / EGFR–MAPK signaling | Scientific illustration | Membrane/cytoplasm/nucleus, receptor recruitment, RAS nucleotide exchange, RAF–MEK–ERK phosphorylation and one selected ERK-to-SOS inhibitory feedback. [2026 MAPK/ERK model](https://doi.org/10.1038/s41598-026-44353-3), [2024 mechanism discussion](https://www.nature.com/articles/s41698-024-00554-5). |

The classic Transformer/HMM sources identify the architecture illustrated; they are not advertised as new research. Current software documentation and the 2026 signaling paper supplement the existing 2026 figure-generation research basis. Diagrams are original simplified illustrations, not copies of paper figures, recovered experimental data, atomic protein structures or complete pathway models.

The gallery displays discipline, scene and distinguishing features. Each image opens a detailed view with fit-to-window/original-size scrolling, expandable drawing requirements and references. Escape returns from detail to the gallery, then closes the gallery; focus returns to the initiating control. These examples are static and do not simulate palette/layout changes.

Selecting a style changes only its visual family. Loading a scenario is a separate explicit action that inserts the localized requirements and selects its family while retaining layout, palette, spacing and print choices. If a description exists, the button explicitly says it will replace it. Browsing and loading do not submit model calls. An imported source disables both style selection and scenario insertion, while still allowing detailed browsing.

Tests cover the native byte limit and contract round-trip, legacy/custom compatibility, independent option preservation, detail browsing versus explicit insertion, imported-source protection, and forwarding scene requirements plus the complete style contract only after submission. Browser verification covers native dialog focus/Escape, image detail and original-size scrolling, local loading, Chinese/English, light/dark themes and narrow layouts. Type checking and the desktop frontend build are required. Fixture verification does not establish real configured-model adherence or independent-review quality.
