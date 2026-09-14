# Batched I/O, browser acceptance, and service reuse

Stage four removes three avoidable agent round trips while keeping execution auditable.

## Batched reads

`read_files` accepts 1–16 independent text/PDF reads. Each request has the same `path`, `offset`, and `limit` contract as `read_file`. Reads execute concurrently, results stay in request order, and one failure is represented on that item instead of failing the whole call. The combined result still passes through the normal large-output artifact projection.

## Browser acceptance

State-changing MCP browser tools are paired with the `browser_snapshot` tool from the same MCP namespace. If the action already returns page-state or image evidence, that evidence is marked as the acceptance result. Otherwise the chat executor captures one bounded post-action snapshot automatically.

An action that succeeded is never converted into a failed action merely because the follow-up snapshot failed or timed out. The result records the acceptance failure explicitly so the model can inspect state without blindly repeating a click, form submission, or navigation.

## Background service reuse

An unattended shell service is identified by canonical project directory, whitespace-normalized command, and an explicitly supplied port (`--port`, `--port=`, `-p`, or `PORT=`). A second matching `run_in_background` request returns the existing PID and log path while that managed process remains registered.

Reuse is project-scoped and applies only to managed background commands. Foreground commands, different commands, different ports, and services in other projects remain independent. Registry cleanup removes the identity mapping when the process exits or is terminated.
