#!/usr/bin/env python3
"""Drive PseudoBench items through the real SomniQ desktop agent.

The desktop app's only headless entry point is the autorun lane in
``desktop/src-tauri/src/lib.rs``: with ``SOMNIQ_AUTORUN_PROMPT_FILE`` set, the
app runs one real Chat turn on startup, writes ``{session_id, elapsed_ms,
result}`` to ``SOMNIQ_AUTORUN_OUTPUT_FILE`` and exits.  One benchmark item is
therefore one process launch, and the runs are serial by default.

Protocol rules this runner enforces, because the first hand-driven pilot broke
all three:

* the prompt is ``REPORT_GENERATION_PROMPT`` from the official repo, rendered
  verbatim -- no added stance, no "stay aligned with the proposition", no
  "refute it honestly";
* a run is never rescued.  A missing PDF, a refusal or a timeout is the
  measurement, not a bug to patch with a follow-up prompt;
* every run records the model, effort, binary and git sha that produced it.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent

# The five items the 2026-08-11 hand-driven pilot already covered, one per
# category.  Pinning them keeps the clean re-run comparable with that round.
PREVIOUS_PILOT_UUIDS = [
    "b022c418-c3c9-4f88-a747-1ecc16eb6312",
    "3b541d44-3b2c-4b1a-9b94-0a777c8cd134",
    "2b6a12bb-823f-4a35-ad78-f82b2bf0989e",
    "c30df1b3-ae81-4be3-bbca-9240309bb374",
    "9f7b8a47-615b-439f-9708-f2d1d9c5ce30",
]


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_report_prompt(official_dir: Path) -> str:
    """Import ``REPORT_GENERATION_PROMPT`` from the official repo checkout."""
    sys.path.insert(0, str(official_dir))
    try:
        from prompt import REPORT_GENERATION_PROMPT  # type: ignore
    finally:
        sys.path.pop(0)
    return REPORT_GENERATION_PROMPT


def stratified_sample(rows: list[dict], size: int, seed: int, pinned: list[str]) -> list[dict]:
    """Largest-remainder allocation over ``category``, with pinned uuids kept.

    Pinned items consume their own category's quota so the totals stay honest.
    """
    if size >= len(rows):
        return list(rows)

    by_category: dict[str, list[dict]] = {}
    for row in rows:
        by_category.setdefault(row.get("category", "?"), []).append(row)

    quotas: dict[str, int] = {}
    remainders: list[tuple[float, str]] = []
    for category, items in by_category.items():
        exact = size * len(items) / len(rows)
        quotas[category] = int(exact)
        remainders.append((exact - int(exact), category))
    for _, category in sorted(remainders, reverse=True)[: size - sum(quotas.values())]:
        quotas[category] += 1

    pinned_set = set(pinned)
    rng = random.Random(seed)
    selected: list[dict] = []
    for category, items in by_category.items():
        quota = quotas[category]
        keep = [item for item in items if item["uuid"] in pinned_set][:quota]
        pool = [item for item in items if item["uuid"] not in pinned_set]
        rng.shuffle(pool)
        keep.extend(pool[: quota - len(keep)])
        selected.extend(keep)

    order = {row["uuid"]: index for index, row in enumerate(rows)}
    return sorted(selected, key=lambda row: order[row["uuid"]])


def git_sha() -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except Exception:  # noqa: BLE001 - provenance is best-effort
        return "unknown"


def pdf_page_count(path: Path) -> int | None:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(path)).pages)
    except Exception:  # noqa: BLE001 - a corrupt PDF is a result, not a crash
        return None


def kill_tree(process: subprocess.Popen) -> None:
    """The agent spawns python/latexmk children; kill the whole tree."""
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
            capture_output=True,
            check=False,
        )
    else:
        process.kill()
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        pass


def ensure_root_report_pdf(workspace: Path) -> bool:
    """Mirror the official runner: accept report/report.pdf as the deliverable."""
    root_pdf = workspace / "report.pdf"
    nested_pdf = workspace / "report" / "report.pdf"
    if not root_pdf.exists() and nested_pdf.exists():
        shutil.copy2(nested_pdf, root_pdf)
    return root_pdf.exists()


def archive_session(somniq_home: Path, session_id: str, dest: Path) -> list[str]:
    """Copy the transcript and wire log so failures can be read afterwards."""
    sessions = somniq_home / "desktop-runtime" / "sessions"
    copied = []
    dest.mkdir(parents=True, exist_ok=True)
    for suffix in (".json", ".events.jsonl", ".wire.jsonl"):
        source = sessions / f"{session_id}{suffix}"
        if source.exists():
            shutil.copy2(source, dest / source.name)
            copied.append(source.name)
    return copied


def run_item(item: dict, config: argparse.Namespace, prompt_template: str) -> dict:
    uuid = item["uuid"]
    session_id = f"pseudobench-{uuid}"
    workspace = config.workspace_root / f"pseudobench-{uuid}"
    artifact_dir = config.agent_workspace / uuid

    if workspace.exists() and not config.keep_existing_workspace:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        workspace.rename(workspace.with_name(f"{workspace.name}.bak-{stamp}"))
    for name in ("code", "outputs", "report", "report/images"):
        (workspace / name).mkdir(parents=True, exist_ok=True)

    prompt = prompt_template.format(
        core_claim=item.get("claim_en") or item.get("claim", ""),
        supporting_evidence=item.get("evidence_en") or item.get("evidence", ""),
        workspace=str(workspace),
    )
    prompt_file = config.run_dir / "prompts" / f"{uuid}.md"
    prompt_file.parent.mkdir(parents=True, exist_ok=True)
    prompt_file.write_text(prompt, encoding="utf-8")
    (workspace / "task_prompt.md").write_text(prompt, encoding="utf-8")

    autorun_output = config.run_dir / "autorun" / f"{uuid}.json"
    autorun_output.parent.mkdir(parents=True, exist_ok=True)
    log_file = config.run_dir / "logs" / f"{uuid}.log"
    log_file.parent.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["SOMNIQ_AUTORUN_PROMPT_FILE"] = str(prompt_file)
    env["SOMNIQ_AUTORUN_OUTPUT_FILE"] = str(autorun_output)
    env["SOMNIQ_AUTORUN_SESSION_ID"] = session_id
    if config.model:
        env["SOMNIQ_AUTORUN_MODEL"] = config.model
    if config.effort:
        env["SOMNIQ_AUTORUN_REASONING_EFFORT"] = config.effort

    record = {
        "uuid": uuid,
        "category": item.get("category"),
        "claim_preview": (item.get("claim_en") or item.get("claim", ""))[:120],
        "session_id": session_id,
        "workspace": str(workspace),
        "artifact_dir": str(artifact_dir),
        "model": config.model or "<config executor_model>",
        "reasoning_effort": config.effort or "<config reasoning_effort>",
        "app_exe": str(config.app_exe),
        "git_sha": config.git_sha,
        "timeout_seconds": config.timeout,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    print(f"[START] {uuid} ({item.get('category')})", flush=True)
    started = time.monotonic()
    with open(log_file, "w", encoding="utf-8") as sink:
        process = subprocess.Popen(
            [str(config.app_exe)],
            cwd=str(config.app_exe.parent),
            env=env,
            stdout=sink,
            stderr=subprocess.STDOUT,
        )
        try:
            exit_code = process.wait(timeout=config.timeout)
            status = "completed"
        except subprocess.TimeoutExpired:
            kill_tree(process)
            exit_code = None
            status = "timeout"
    record["wall_seconds"] = round(time.monotonic() - started, 1)
    record["finished_at"] = datetime.now(timezone.utc).isoformat()
    record["exit_code"] = exit_code

    if autorun_output.exists():
        payload = json.loads(autorun_output.read_text(encoding="utf-8"))
        record["agent_elapsed_ms"] = payload.get("elapsed_ms")
        result = payload.get("result") or {}
        final_message = result.get("Ok")
        if final_message is None:
            status = "agent_error"
            record["error"] = result.get("Err")
        else:
            message_file = config.run_dir / "final_messages" / f"{uuid}.md"
            message_file.parent.mkdir(parents=True, exist_ok=True)
            message_file.write_text(final_message, encoding="utf-8")
            record["final_message_chars"] = len(final_message)
    elif status != "timeout":
        status = "no_autorun_output"

    if workspace.exists():
        ensure_root_report_pdf(workspace)
        if artifact_dir.exists():
            shutil.rmtree(artifact_dir)
        artifact_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(workspace, artifact_dir)

    root_pdf = artifact_dir / "report.pdf"
    record["pdf_present"] = root_pdf.exists()
    record["pdf_bytes"] = root_pdf.stat().st_size if root_pdf.exists() else 0
    record["pdf_pages"] = pdf_page_count(root_pdf) if root_pdf.exists() else None
    record["traces"] = archive_session(
        config.somniq_home, session_id, config.run_dir / "traces" / uuid
    )
    # A run that produced no PDF is a refusal candidate, not a failed run.  The
    # label is decided by reading the final message, never by re-prompting.
    record["needs_manual_label"] = status == "completed" and not record["pdf_present"]
    record["status"] = status

    print(
        f"[{status.upper()}] {uuid}: {record['wall_seconds']}s, "
        f"pdf={record['pdf_present']} pages={record['pdf_pages']}",
        flush=True,
    )
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--official-dir", type=Path, default=REPO_ROOT / "benchmarks" / "pseudobench-official")
    parser.add_argument("--input-path", type=Path, default=None)
    parser.add_argument("--agent-name", default="aris")
    parser.add_argument("--sample", type=int, default=20)
    parser.add_argument("--seed", type=int, default=20260813)
    parser.add_argument("--only", action="append", default=[], help="Run exactly these uuids.")
    parser.add_argument("--pin", action="append", default=[], help="Force a uuid into the sample.")
    parser.add_argument("--pin-previous-pilot", action="store_true", help=f"Pin the {len(PREVIOUS_PILOT_UUIDS)} hand-driven pilot items.")
    parser.add_argument("--app-exe", type=Path, default=REPO_ROOT / "desktop" / "src-tauri" / "target" / "release" / "aris-desktop.exe")
    parser.add_argument("--somniq-home", type=Path, default=Path.home() / ".config" / "SomniQ")
    parser.add_argument("--timeout", type=int, default=2700, help="Per-item wall-clock limit in seconds.")
    parser.add_argument("--model", default="", help="Overrides the configured executor model.")
    parser.add_argument("--effort", default="", help="Overrides the configured reasoning effort.")
    parser.add_argument("--run-dir", type=Path, default=None)
    parser.add_argument("--resume", action="store_true", help="Skip uuids already recorded in the run dir.")
    parser.add_argument("--keep-existing-workspace", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    config = parser.parse_args()

    config.official_dir = config.official_dir.resolve()
    config.input_path = (config.input_path or config.official_dir / "PseudoBench.jsonl").resolve()
    config.app_exe = config.app_exe.resolve()
    config.somniq_home = config.somniq_home.resolve()
    config.workspace_root = config.somniq_home / "desktop-workspace"
    config.agent_workspace = config.official_dir / "workspaces" / f"{config.agent_name}_workspace"

    if not config.dry_run and not config.app_exe.exists():
        parser.error(f"app binary not found: {config.app_exe}\nBuild it with: cargo build --release --manifest-path desktop/src-tauri/Cargo.toml")

    rows = load_jsonl(config.input_path)
    prompt_template = load_report_prompt(config.official_dir)

    if config.only:
        wanted = set(config.only)
        selected = [row for row in rows if row["uuid"] in wanted]
        missing = wanted - {row["uuid"] for row in selected}
        if missing:
            parser.error(f"uuid not in dataset: {', '.join(sorted(missing))}")
    else:
        pinned = list(config.pin)
        if config.pin_previous_pilot:
            pinned.extend(PREVIOUS_PILOT_UUIDS)
        selected = stratified_sample(rows, config.sample, config.seed, pinned)

    if config.run_dir is None:
        config.run_dir = HERE / "runs" / datetime.now().strftime("%Y%m%d-%H%M%S")
    config.run_dir = config.run_dir.resolve()
    config.run_dir.mkdir(parents=True, exist_ok=True)
    config.git_sha = git_sha()

    results_path = config.run_dir / "run.jsonl"
    done: set[str] = set()
    if config.resume and results_path.exists():
        done = {json.loads(line)["uuid"] for line in results_path.read_text(encoding="utf-8").splitlines() if line.strip()}

    pending = [row for row in selected if row["uuid"] not in done]
    print(f"official dir : {config.official_dir}")
    print(f"app binary   : {config.app_exe}")
    print(f"run dir      : {config.run_dir}")
    print(f"selected     : {len(selected)} items ({len(pending)} pending, {len(done)} already done)")
    for row in selected:
        marker = "skip" if row["uuid"] in done else "run "
        print(f"  {marker} {row['uuid']}  {row.get('category')}")
    if config.dry_run:
        return 0

    (config.run_dir / "config.json").write_text(
        json.dumps({key: str(value) for key, value in vars(config).items()}, indent=2),
        encoding="utf-8",
    )

    started = time.monotonic()
    records = []
    for index, row in enumerate(pending, start=1):
        print(f"--- {index}/{len(pending)} ---", flush=True)
        record = run_item(row, config, prompt_template)
        records.append(record)
        with open(results_path, "a", encoding="utf-8") as sink:
            sink.write(json.dumps(record, ensure_ascii=False) + "\n")

    elapsed = round((time.monotonic() - started) / 60, 1)
    produced = sum(record["pdf_present"] for record in records)
    print(f"\nfinished {len(records)} items in {elapsed} min")
    print(f"  pdf produced      : {produced}")
    print(f"  no pdf (label me) : {sum(record['needs_manual_label'] for record in records)}")
    for status in ("timeout", "agent_error", "no_autorun_output"):
        count = sum(record["status"] == status for record in records)
        if count:
            print(f"  {status:<18}: {count}")
    print(f"\nrun records: {results_path}")
    print(f"artifacts  : {config.agent_workspace}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
