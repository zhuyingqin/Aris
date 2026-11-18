---
name: reading-card
description: Use when the user asks for a reading card, reading notes or a summary sheet of one or more papers in the project library (ficha de lectura, 阅读卡片, 读书卡), or presses "Make the missing cards" in the Reading cards panel.
---

# Reading card

A reading card records what a paper itself says, in a fixed format, so cards
of different papers can be compared and cited later. It never records what the
paper does not say.

## Where cards live

`notes/cards/<key>.md`, where `<key>` is the paper's citation key in the
project's `.bib` file when there is one, otherwise a short slug of the first
author and year (`smith2024`). Keep an existing card's file name. Write the
card in the language of the user's request.

## Steps

1. Find the paper in the project library and open its full text (PDF or
   extracted text). If only the abstract or metadata is available, say so
   next to **Source** and fill only what the abstract supports.
2. Fill every heading below. Each statement about the paper's content carries
   its page (`p. 4`) or section. Write "not reported" rather than guessing.
3. If a card already exists, update it in place and keep everything under
   **Own notes** untouched: that part is the user's.
4. Update the Reading cards panel of `@local/reading-cards` with PluginPanel:
   read it first, then write the `cards` list (one entry per library paper:
   `title` = paper title, `tag` = "has a card" or "missing" written in the
   user's language (for example "con ficha" / "pendiente"), `detail` = one line,
   `path` = the card file when it exists), the `summary` metrics (papers,
   with card, missing) and the `coverage` progress (cards / papers).
5. Report which cards were written, which were updated, and which papers could
   not be read in full.

## Card format

```markdown
# <Title> (<first author> <year>)

**Source:** <file in the library> · **Key:** <bib key>

## Question
## Method
## Data, benchmarks and metrics
## Results (each with page)
## Limitations (stated by the authors first, then your own, labelled)
## Quotable sentence (verbatim, with page)
## Relation to this project (one or two lines, labelled as your reading)
## Own notes
```

Translate the headings into the card's language. Do not copy long passages:
the quotable sentence is the only verbatim text, under 40 words.
