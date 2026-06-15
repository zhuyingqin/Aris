# Visual Evidence Chain

ARIS literature evidence and question-answer chains use rendered PDF page images
as the primary reading input. OCR/extracted text remains available for the
separate full-text Brief workflow, but it is not the evidence-chain input.

## Flow

1. The desktop renders every PDF page to a JPEG image.
2. Each page image receives a deterministic fingerprint.
3. Pages are sent to the configured vision-capable executor in batches of four.
4. The model reads each image directly and extracts page-scoped visual evidence.
5. ARIS rejects evidence that refers to a page outside the supplied batch.
6. A final text-only synthesis call builds question-answer chains using only the
   IDs of accepted visual evidence items.
7. Saved evidence and support annotations retain page number, visual source, and
   page-image fingerprint.

This batching ensures every page is presented to the visual model without
placing the entire paper's images into one request.

## Model requirements

MiniMax evidence-chain reading requires `MiniMax-M3`. MiniMax M2.x models are
text-only and are rejected before a visual request is sent. Other configured
executors may be used when their provider endpoint accepts image content.

## Trust boundary

The image fingerprint proves which rendered page image was supplied for an
evidence item. It does not prove that a model transcription is character-perfect.
Visual evidence is therefore displayed as visual-page evidence and should be
human-reviewed from the linked PDF page before final publication.

