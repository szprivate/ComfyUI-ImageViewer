# Dependencies

[Home](index.md)

Every file the Send to Image Viewer node or [agentY](https://github.com/szprivate/agentY) saves records what it was made from, and each file it read records what was made from it. Files saved by other nodes that put their workflow into the file (ComfyUI's Save Image, Save Video, VHS Video Combine) are worked out from that workflow the first time you look at them. It all runs in ComfyUI; agentY does not have to be running. Right-click a History thumbnail ▸ **Show dependencies** to see that record as a graph, top to bottom: inputs above, what was made from them below.

![The Dependencies tab: a plate on top, its passes below, the render made from them](images/dependencies-tab.png)

- Each node is a file, with its thumbnail and kind (source, depth, mask, render…). Each edge names what made it.
- Every picture and film has a coloured frame: green for a still image, blue for a video. The strip at the bottom of the frame names the model the file was made with, read from the graph stored with the file or embedded in it. That is the checkpoint, UNet or diffusion model, or the model of an API node such as Veo or Kling, plus how many LoRAs were used. Hover the file to see every model, including the VAE and text encoders. A file made without a graph (a plate, a JPEG) shows only IMAGE or VIDEO, unless something else says how it was made:
  - a Magnific creation agentY downloaded carries what Magnific told agentY: the prompt (shown as a prompt box), the model, the provider, the credits and its Magnific link;
  - any file whose maker signed it with C2PA "content credentials" (Magnific's films from Seedance, OpenAI, Firefly, Google ...) shows the model the credentials name. They are read, not verified, and editing or re-encoding a file drops them;
  - a file with "magnific" in its name is tagged Magnific even when nothing else says so (a manual download).
  The caption then shows the tags: `magnific · dreamina-seedance-2-5`.
- The file you started from is outlined. A file made from an older version of an input is marked **out of date** (hover for why). A missing file is greyed.
- **Prompts** sit in text boxes one row above the file they made, with a **Copy** button. The **Prompts** button hides them.
- More than four passes of one kind fold into one node. Click it to unfold.

![Prompts above the render they went into](images/dependencies-prompts.png)

| To | Do |
|---|---|
| Open a file | Click its node |
| Centre on a file | Double-click its node |
| Fit the graph | <kbd>F</kbd>, or **Fit** |
| Find older files made before the record existed | **Look in folder** |
| Read it again | **Reload** |

What it can't know:

- A file with no workflow in it or beside it (a JPEG, a file from another program, ComfyUI started with `--disable-metadata`) shows on its own.
- Outside the Send node and agentY, what was made from a file is known only once those files have been looked at, or after **Look in folder** in their folder.
- A graph with several save nodes: the file is matched to one by its name, which can be the wrong one.

The records are small JSON files in an `agent_metadata` folder beside the files, the same ones agentY reads.
