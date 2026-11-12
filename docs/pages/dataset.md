# Dataset

[Home](../index.md)

The Dataset panel reviews a LoRA training dataset an agent prepared, and then shows the training. It works on the files directly, so it needs no agentY to open.

## Opening

- **ComfyUI ▸ Dataset** in the lower bar: the open dataset, else a list of them.
- Double-click a dataset's `manifest.json` in the file browser, or let agentY show it.

Each dataset opens on its own, with a **Dataset** page and a **Training** page.

## Reviewing

- Edit captions under the thumbnails. Include, remove or restore pictures.
- **Find and replace** across all captions, and set the **trigger word**.
- Drag a **crop box** on a thumbnail; double-click clears it.
- Then **Approve & train**, **Ask the agent** (with a note), or **Cancel**. agentY gets your decision as your next message.

An edit that changes what training sees takes the approval back.

## Training

The Training page shows the run: progress, the loss curve, sample pictures and events. **Stop** ends it. A notice tells you when a run finishes or fails.

How the files and routes work: [dev/lora-dataset-design.md](dev/lora-dataset-design.md).
