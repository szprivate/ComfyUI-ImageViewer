# Dataset

[Home](../index.md)

Reviews a LoRA training set prepared by an agent and then monitors the training run. The panel reads and writes the dataset files directly, so agentY does not need to be running to open it.

## Opening

- **ComfyUI ▸ Dataset** in the lower bar: the open dataset, otherwise a list of datasets.
- Double-click a dataset's `manifest.json` in the file browser, or have agentY open it.

Each dataset has two pages, **Dataset** and **Training**.

## Review

- Edit the caption under each thumbnail; include, remove or restore images.
- **Find and replace** across all captions, and set the **trigger word**.
- Drag a **crop box** on a thumbnail; double-click removes it.
- Finish with **Approve & train**, **Ask the agent** (with a note) or **Cancel**. agentY receives the decision as your next message.

Any change that affects the training data withdraws an earlier approval.

## Training

The Training page shows progress, the loss curve, sample images and the event log. **Stop** ends the run. A notification appears when a run finishes or fails.

Files and routes: [dev/lora-dataset-design.md](dev/lora-dataset-design.md).
