# Somni gateway drawing

SomniImage uses the signed-in Somni account to generate or edit images. The
current conversation model writes a complete drawing prompt from the user's
request and context, then calls the image tool. The selected drawing model is
independent of the Executor and Reviewer models. The research review loop
continues to use its existing roles.

## Settings and model discovery

Settings > Models contains Somni drawing with an enable switch and drawing model
selector. The existing Sync models action refreshes the managed model cache;
GPT Image models appear in the drawing selector and are excluded from ordinary
chat, Executor, Reviewer, and retrieval model choices. The current gateway
advertises `gpt-image-2`, `gpt-image-2.5-sunburst`, and `gpt-image-2.5-flare`.
The default is `gpt-image-2` when available. A removed configured model is shown
as unavailable, rather than silently selecting another paid service.

`somni_image_enabled` and `somni_image_model` are stored alongside the existing
local configuration. `somni_image_settings` and `somni_image_settings_set` expose
only availability and preferences. Account tokens remain in the native runtime.

## Prompt and API flow

The tool schema requires `prompt`; optional fields are project reference `files`,
`model`, `size`, `quality`, and `n`. Both its description and the chat system
prompt instruct the conversation model to specify subject, composition,
relationships, style, exact labels, and desired changes before invoking the
tool. Measured scientific plots continue to use plotting code and real data.

The shared `api` crate posts JSON to `/v1/images/generations`, or multipart
`image[]` files to `/v1/images/edits` when references are present. These are the
[image routes in the deployed New API revision](https://github.com/QuantumNous/new-api/blob/2035a82aeb5414253a728bd937d4b8f97aa99b9b/router/relay-router.go).
The native tool reuses the approved Somni gateway and current account inference
token. Its FullAccess permission makes the external paid action explicit in the
existing tool permission flow. Requests are never automatically retried.

The transport accepts base64 images or public HTTPS image download URLs. CDN
downloads use a separate connection without the gateway Authorization header,
reject redirects and internal network addresses, and pin resolved addresses.
PNG, JPEG, and WebP responses are validated and decoded within bounded size and
memory limits. References must resolve inside the current project, with at most
16 files, 32 MB per file, and 64 MB in total. Each call requests 1–4 images.

## Artifacts, cancellation, and display

Images are saved under
`.somniq/artifacts/somni-images/<random-run-id>/image-N.<extension>`. The adjacent
`generation.json` records the actual prompt, model, references, dimensions,
SHA-256 hashes, revised prompts, timestamp, and reported usage. It contains no
account credential. The tool returns these project-relative paths to the
conversation; chat previews and the existing image node canvas display them.
Reference images can feed later generations using the existing image lineage.

Cancellation drops the active request promptly. After submission, cancellation
or timeout cannot guarantee that the provider stopped generation or billing;
the result tells the user to check account usage before submitting again.

## Gateway prerequisite and verification

The public gateway must forward POST requests for both image endpoints to New
API. A visible drawing model in `/v1/models` does not establish image route
availability. On 2026-10-04, a live conversation model generated the test prompt,
but generation returned an HTML Nginx 404. A subsequent route check confirmed
that the public vhost still forwarded only the existing conversation endpoints.
The client now reports that missing route with an actionable error.

After the gateway forwarding was corrected, both unauthenticated image POST
endpoints returned New API's JSON 401 rather than Nginx's HTML 404. A single live
generation then completed: `MiniMax-M3.1-Flash-Preview` wrote the prompt in about
2 seconds, and `gpt-image-2` returned a valid PNG in about 86 seconds. The local
image was decoded and visually checked. The request specified 1024×1024 with
low quality; the provider actually returned 1254×1254. Artifact dimensions and
UI metadata use the decoded result rather than assuming the requested size.

Focused API and native tests cover authenticated generation, multipart editing,
credential redaction, no duplicate submissions, invalid image rejection,
project path containment, local audit records, and cancellation after the
server accepts a request. Frontend tests cover settings persistence, drawing
model separation, image previews, actual model display, and reference lineage.
Live generation through the shared client is now verified. Multipart editing is
covered by focused transport tests; no additional paid edit was submitted in
this generation check. The client integration is present in the source build;
this check did not replace the running installed desktop executable.

## Desktop dispatch regression

A subsequent desktop conversation exposed a separate client failure: ToolSearch
published `SomniImage`, but the rich-result executor omitted it from its desktop
dispatch list. Calls fell through to the shared kernel and returned
`unsupported tool: SomniImage` before any image HTTP request was submitted.
The desktop now shares one dispatch classification between rich results and
serial batch scheduling, including the paid image tool. A regression invokes
the actual native image parser through that dispatch boundary and checks that
MCP image results retain their separate rich-result path.

Drawing requests activate the configured API tool before generic file creation
and media extras. GPT image requests use that API; explicit Oracle, webpage or
Image Assist requests retain the webpage route. The prompt explains the API's
`size` field and prevents silent substitution with SVG or webpage automation
when the user requests API generation. An opt-in ignored desktop test exercises
dispatch, the current account's selected drawing model, and artifact saving:

```powershell
$env:SOMNIQ_IMAGE_SMOKE_WORKSPACE = 'F:/Agent/Aris'
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib somni_image_live_desktop_dispatch_saves_an_api_artifact -- --ignored --nocapture
```

This check submits one paid image request and never retries automatically.

The opt-in check passed with the account's selected `gpt-image-2.5-flare`:
the native dispatch and artifact writer saved a decoded 1254×1254 PNG in about
55 seconds. The project-local `generation.json` records the submitted prompt,
actual model, dimensions, hash and reported usage. This verifies the repaired
native path independently of any running executable still built before the fix.
