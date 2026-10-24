# LoRA dataset panel ("Dataset")

The agent prepares a LoRA training dataset (agentY issue #75); the viewer is where the user looks at it,
fixes it, approves it, and then watches the training. User and agent edit the same files; the viewer needs
no agentY to work (agentY is only told what the user decided, when it is running).

## Decisions

1. **The files are the contract** (module docstring of `agenty_core/tools/lora_training/formats.py`):
   `<ComfyUI output>/agent/lora_datasets/<name>/{manifest.json, review.json, items/}` and
   `agent/lora_runs/<job>/{job.json, progress.json, events.jsonl, samples.json, samples/, control.json, train.log, result.json}`.
   The viewer reads and writes them directly; there is no database and no agentY call on the data path.
2. **Python side = `lora_io.py`** (no aiohttp, tested alone): only those two folders are touched, names are plain
   slugs (no path parts), a served file must be a picture or clip inside one of the folders (symlinks resolved),
   writes are atomic (temp file + rename). `manifest_sha` is a port of agenty_core's and
   `tests/test_lora_io.py` pins a fixed vector (and compares with agenty_core when it is importable).
3. **Saving keeps what the panel does not know**: the manifest on disk is the base, the panel's keys and items
   (merged per item `id`) go over it. `status`, `approved_at`, `name`, `version`, `created` and the summary counts
   are the server's. An item's `file` must stay inside the dataset folder. A dataset being trained on is read-only.
4. **An edit after approval voids it**: when the manifest's hash (trigger word, model, included items' file /
   caption / crop) no longer equals `review.manifest_sha`, the save sets review `pending` and status `review`.
   Edits that training does not see (caption style, warnings) keep the approval.
5. **Approve / Ask / Cancel** save the panel's manifest first, then write `review.json` (`by: "viewer"`) and set
   `manifest.status` (`approved` / `review` / `cancelled`). The response carries a short `message`; the panel hands
   it to agentY through `window.agentYViewerBridge.feedback` (the "Send to agentY" path: the user's next message
   in the active conversation) and silently skips it when that bridge is not there.
6. **Edits are pure functions** on the manifest (`bEpicViewer_loraModel.js`: toggle, caption, remove / restore,
   bulk find/replace, trigger word with optional rewrite, crop clamp, summary counts, undo `History`) and the
   training helpers (smoothed loss, sparkline path, durations, new-event filter, poll delay), all node-tested.
7. **UI = one editor over a host element** (`bEpicViewer_loraEditor.js`, like the Motion editor), mounted by the
   dock panel (`bEpicViewer_loraPanel.js`, dock id `loraDataset`, bar group *ComfyUI > Dataset*) and by the
   standalone harness. Opening is also done by `POST /bepic/push` with a lora dataset's `manifest.json`
   (event `bepic.lora.open`).
8. **Crop** is dragged on the item's thumbnail and stored normalised `[x, y, w, h]` (double-click clears it, the
   whole picture is stored as `null`). The thumbnail is the prepared item file, so the box is drawn in its frame;
   the contract defines the crop on the original file, which the trainer's writer applies.
9. **Training tab** polls every ~3 s while a run is running and the panel is open, every 12 s when idle, every
   15 s while the panel is closed. Toasts (and a browser notification for finished / failed / stopped while the
   tab is hidden) fire for NEW events only: the last event id per run is remembered (in memory and `localStorage`),
   and a run seen for the first time does not replay its old events.

## Routes (all also under `/api/bepic/lora/...`)

| route | request | answer |
|---|---|---|
| `GET /bepic/lora/datasets` | | `{datasets: [{name, dir, manifest_path, subject, kind, model, status, trigger_word, count, included, removed, review, cover, updated}]}` |
| `GET /bepic/lora/dataset?name=` | | `{name, dir, manifest_path, manifest, review, sha}` |
| `GET /bepic/lora/file?path=` | absolute, or relative to `<output>/agent` | the picture / clip (403 outside the two folders or for other file types) |
| `POST /bepic/lora/dataset_save` | `{name, manifest}` | `{ok, manifest, review, sha, reset_approval}` |
| `POST /bepic/lora/review` | `{name, action: approve\|ask\|cancel, note, manifest?}` | `{ok, state, review, manifest, message}` |
| `GET /bepic/lora/runs` | | `{runs: [{name, status, step, total, pct, dataset, model, updated}]}` |
| `GET /bepic/lora/run?name=` | | `{name, dir, progress, job, result, control, samples (files get an absolute path), events (last 200), log_tail (last 60 lines)}` |
| `POST /bepic/lora/control` | `{name, action: "stop", keep}` | `{ok, control}`; writes `control.json` `{action, keep, t, by: "viewer"}`; 409 once the run ended |

Errors are `{error}` with 400 (bad input), 403 (outside the folders), 404, 409 (busy / ended), 422 (not a dataset,
nothing included, empty note).

## Tests

`tests/test_lora_io.py` (unittest, runs under pytest too), `tests/test_lora_model.mjs` (`node --test`), and the
harness `python tests/harness_lora/server.py [port]` -> `http://127.0.0.1:8767/page.html` (`?tab=training`): the
real `lora_io` routes over a demo dataset and a running demo job in a temp folder.
