# Generated and hybrid explanatory illustrations

Read this guide when a physical scene, spatial relationship or conceptual picture
helps explain the problem in a paper or slide deck. Use native TikZ for precise
graph logic and mathematical notation. Both routes start from the same brief:
the question, takeaway, entities, supported relationships and assumptions.

## Use the existing image service

SomniQ Desktop exposes `SomniImage` when the signed-in account's drawing model is
enabled and available. It generates or edits images and returns project-relative
local paths. This is the existing account-bound API, separate from the chat
model. If its schema is deferred, use `ToolSearch` with `select:SomniImage,ReadMediaFile`.
If it is absent from the available catalog, do not claim generation occurred;
use a suitable existing asset or native construction and report the limitation.
Respect an explicitly requested generation route and the runtime's external-action
permissions. A capability assessment alone is not a request to spend image quota.

Construct the complete prompt from the actual problem and document context:

- The physical or conceptual entities and scientifically supported relationships.
- The intended reading order, composition, palette and space needed for labels.
- Which labels are painted into the image and which will be native overlays.
  Prefer native text for equations, exact numbers, dense terminology and revisions.
- Whether the illustration is a schematic; exclude invented measurements,
  performance comparisons or claims of an actual experimental setup.

For example, an authorized request for an illustrated inverse-control slide
might use the following call, adapted to the method's actual system:

```json
{
  "prompt": "Conceptual scientific illustration for a slide explaining inverse control. A planar two-link robot arm shown in three observed poses on a plain white background, with a small observation camera. These are illustrative poses, not measured experiment results. Place the scene on the left and leave open space on the right for a native mathematical explanation. Restrained blue and orange palette, clear silhouettes, no decorative elements. Do not paint text, equations, arrows or numeric results; these will be overlaid accurately in LaTeX.",
  "size": "1536x1024",
  "n": 1
}
```

Omit `model` to use the configured drawing model. The supported `size` values
are `auto`, `1024x1024`, `1536x1024` and `1024x1536`; this tool does not accept
`aspectRatio`. Include project-relative reference image paths in `files` when
editing or maintaining continuity with an existing scene. Reuse a suitable saved
image before submitting a new request. Preserve failures and timeouts as such;
do not automatically resubmit a paid request or switch generation providers.
Any additional generation must remain within the authorized request and budget.

## Integrate the saved result

Read the actual returned image with `ReadMediaFile` before describing its pixels
or accepting it. Check the scientific relationships, anatomy or geometry,
unintended text and usable label space. A plausible-looking scene can still
misrepresent the problem. Correct exact labels locally when possible; a failed
semantic check keeps the image a draft.

The tool stores images and `generation.json` under
`.somniq/artifacts/somni-images/<requestId>/`, including actual prompt, model,
references, image hashes and any returned revised prompt. Preserve that record.
Copy the selected image into the document's `figures/` directory for portable
delivery, retaining its original path and hash in the content/source record.
For Figures assets, preserve the selected saved version and its request records.

Include the local PNG/JPEG with `graphicx` and `\includegraphics`. Preserve aspect
ratio: a landscape generation is not necessarily a 16:9 slide. Fit the image in
its allotted region or compose it beside the explanation. For hybrids, place the
image in a named TikZ node and position native labels and arrows relative to its
anchors. Keep the image, overlay source and caption separate so a label change
does not require another paid generation. Check overlay alignment after resizing
or cropping, and compile and inspect the actual containing PDF.

In slides, keep the selected image path/hash, generation-record path, diagram
brief, overlay content and visible schematic label in `slides.json` alongside
the notes. In the slide quality manifest, register the image as a `figure` source
and the generation record as a `document` source; use the `method` evidence role
for this explanatory illustration. It cannot substantiate a measured metric.
Apply the common content to both PDF and PPTX, and inspect both actual exports.
Native PPTX text/shapes can preserve overlay editability; an embedded composite
image or SVG does not promise editable PowerPoint nodes.

When editable vector reconstruction is requested, reuse the existing Figures
workflow with the selected saved image, versioning, independent Reviewer and
bounded revision. Reconstruction requires checking the rebuilt semantics; it
does not turn generated artwork into experimental evidence. Preserve the parent
workflow's independent review for the final composition and disclose any review
or visual check that was not performed.
