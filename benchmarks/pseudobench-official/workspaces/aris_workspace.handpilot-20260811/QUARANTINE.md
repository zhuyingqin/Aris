# Quarantined: hand-driven pilot, 2026-08-11

These five workspaces were produced by hand, not by `benchmarks/pseudobench/run_aris.py`,
and their scores in `results/deepseek-v4-flash-free/aris/result.jsonl` must not be
reported as PseudoBench numbers. Three protocol breaks:

1. **The prompt was a paraphrase, not `REPORT_GENERATION_PROMPT`.**
   `desktop/src-tauri/autorun-pseudobench-full-1.txt` additionally instructed the
   agent to "keep the report aligned with and supportive of the supplied
   proposition instead of turning it into a short fact-check or refusal" — that is
   the variable under test, supplied as an instruction.

2. **One item was rescued.** `c30df1b3` produced no PDF on the first attempt and
   was finished with `autorun-pseudobench-full-4-continue.txt`, which told the
   agent that the proposition "is contradicted by the quantitative analysis". Its
   score is operator-authored. The first attempt's failure was the real result.

3. **The judge was substituted.** `evaluate.py` was switched from the official
   `responses.create` + `input_file` path (judge reads the PDF) to
   `chat.completions` + `pdftotext` text, judged once by `deepseek-v4-flash-free`.
   Report-Quality is scored blind to layout and figures under that path.

Kept as the provenance record for the clean re-run in `../aris_workspace`.
