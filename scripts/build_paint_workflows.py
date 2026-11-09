"""Build Paint's Generate workflows (src/paint_workflows/) from ComfyUI's own templates.

    python scripts/build_paint_workflows.py [path/to/agentY-core]

The official templates (``comfyui_workflow_templates_official``, as agentY-core carries them, and its
``..._custom`` ones) are copied and trimmed: what only shows something (notes, compare and preview nodes)
goes, a second reference picture goes or is fed the same picture, and the nodes Paint fills in get titles -
``paint:image`` (the picture), ``paint:prompt`` (the words), ``paint:output`` (the result), ``paint:tune``
(the node whose settings the dialog offers), ``paint:box`` (a box from the selection), ``paint:scale``.
Templates in ComfyUI's canvas format ("ui") are kept as they are and turned into a prompt by ComfyUI's page
(in a graph of their own, never on the user's canvas); the few in the API format ("api") run as they are.

``RECIPES`` is the table: what each workflow is called, which actions it does, the size its model works
at, and how its template is trimmed. ``index.json`` is written from it. The trimmed files and the index
are committed; this script is only run again when the table or the templates change.
"""

import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "src", "paint_workflows")
CORE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "agenty-core")
OFFICIAL = os.path.join(CORE, "comfyui_workflow_templates_official", "templates")
CUSTOM = os.path.join(CORE, "comfyui_workflow_templates_custom", "templates")

# Nodes that only show something: they go.
SHOW_ONLY = {"Note", "MarkdownNote", "ImageCompare", "PreviewAny", "MaskPreview", "PreviewImage"}

EDIT = ["fill", "remove", "extend", "edit"]
ONE_MP = {"mp": 1.0, "mult": 16, "max": 2048}
API_MP = {"mp": 1.0, "mult": 16, "max": 2048}
FOUR_MP = {"mp": 4.0, "mult": 16, "max": 4096}
AS_IS = {"mp": None, "mult": 1, "max": 4096}
UPSCALE_IN = {"mp": None, "mult": 1, "max": 2048}

# Each recipe: id, label, api (a partner node, paid), actions, size, src ("name" of an official template or
# "c:name" of agentY-core's own), and how it is trimmed:
#   titles {node id: title} (root), sub {node id: title} (inside its subgraph), drop [ids], merge [ids] (a
#   second LoadImage: fed what paint:image gives), link [[from id, from slot, to id, input name, type]],
#   add [{node}], mask: [node id, input] (the selection goes in as a mask there - an inpainting model).
# Server side (paint_generate): prompts, prompt_input, set, aspect, dims, scale, tune, optional.
RECIPES = [
    # ── existing API-format workflows, kept as they are ───────────────────────
    {"id": "flux_fill", "label": "FLUX.1 Fill dev (local)", "file": "flux_fill.json", "api": False, "format": "api",
     "actions": ["fill", "remove", "extend"], "mask_in": True, "size": ONE_MP,
     "prompts": {"remove": "empty background, nothing there", "extend": "", "fill": ""},
     "set": {"extend": [["8", "noise_mask", False]]}, "models_from": "flux_fill_inpaint_example",
     "from": "flux_fill_inpaint_example / flux_fill_outpaint_example"},
    {"id": "flux_fill_onereward_remove", "label": "FLUX.1 Fill OneReward + removal LoRA (local)", "file": "flux_fill_onereward_remove.json",
     "api": False, "format": "api", "actions": ["remove"], "mask_in": True, "size": ONE_MP, "prompts": {"remove": "remove"},
     "models_from": "image_flux.1_fill_dev_OneReward", "from": "image_flux.1_fill_dev_OneReward"},
    {"id": "gpt_image_2_inpaint", "label": "GPT Image 2 inpaint (API)", "file": "gpt_image_2_inpaint.json", "api": True, "format": "api",
     "actions": EDIT, "mask_in": True, "size": {"mp": 1.0, "mult": 16, "max": 1536}, "from": "api_openai_image_1_inpaint"},
    {"id": "gpt_image_25_inpaint", "label": "GPT Image 2.5 Flare, masked (API)", "file": "gpt_image_25_inpaint.json", "api": True, "format": "api",
     "actions": EDIT, "mask_in": True, "size": {"mp": 1.0, "mult": 16, "max": 1536},
     "from": "api_openai_gpt_image_25_flare_image_edit (with its mask input)"},
    {"id": "flux_kontext_edit", "label": "FLUX.1 Kontext dev (local)", "file": "flux_kontext_edit.json", "api": False, "format": "api",
     "actions": EDIT, "size": ONE_MP, "models_from": "flux_kontext_dev_basic", "from": "flux_kontext_dev_basic"},
    {"id": "gpt_image_25_edit", "label": "GPT Image 2.5 Flare (API)", "file": "gpt_image_25_edit.json", "api": True, "format": "api",
     "actions": EDIT, "size": {"mp": 1.0, "mult": 16, "max": 1536}, "from": "api_openai_gpt_image_25_flare_image_edit"},
    {"id": "nano_banana2_edit", "label": "Nano Banana 2 (API)", "file": "nano_banana2_edit.json", "api": True, "format": "api",
     "actions": EDIT, "size": {"mp": 4.0, "mult": 8, "max": 4096}, "aspect": ["2", "aspect_ratio"], "from": "api_i2i_imageEdit_nanoBanana2"},
    {"id": "qwen3_edit", "label": "Qwen Image 3 Edit (API)", "file": "qwen3_edit.json", "api": True, "format": "api",
     "actions": EDIT, "size": {"mp": 2.0, "mult": 16, "max": 2560, "min": 512}, "from": "api_qwen3_image_edit"},
    {"id": "qwen2511_edit", "label": "Qwen Image Edit 2511 (local)", "file": "qwen2511_edit.json", "api": False, "format": "api",
     "actions": EDIT, "size": ONE_MP, "models_from": "image_qwen_image_edit_2511", "from": "image_qwen_image_edit_2511"},
    {"id": "qwen2511_lightning_edit", "label": "Qwen Image Edit 2511 Lightning (local)", "file": "qwen2511_lightning_edit.json", "api": False,
     "format": "api", "actions": EDIT, "size": ONE_MP, "models_from": "image_qwen_image_edit_2511",
     "from": "image_qwen_image_edit_2511 (Lightning LoRA switched on)"},
    {"id": "seedream5_edit", "label": "Seedream 5.0 Pro (API)", "file": "seedream5_edit.json", "api": True, "format": "api",
     "actions": EDIT, "size": {"mp": 4.0, "mult": 16, "max": 4096, "min": 1024}, "dims": ["2", "model.width", "model.height"],
     "from": "api_bytedance_seedream_5_0_pro_image_edit"},
    {"id": "nano_banana_pro_edit", "label": "Nano Banana Pro (API)", "file": "nano_banana_pro_edit.json", "api": True, "format": "api",
     "actions": EDIT, "size": {"mp": 4.0, "mult": 8, "max": 4096}, "from": "api_nano_banana_pro"},
    {"id": "nano_banana21_edit", "label": "Nano Banana 2.1 (API)", "file": "nano_banana21_edit.json", "api": True, "format": "api",
     "actions": EDIT, "size": {"mp": 4.0, "mult": 8, "max": 4096}, "from": "api_nano_banana_2_1_image_edit"},

    # ── edit models from the official templates ─────────────────────────────
    {"id": "flux_kontext_pro", "label": "FLUX.1 Kontext Pro (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_bfl_flux_1_kontext_pro_image", "titles": {84: "paint:image", 83: "paint:prompt", 85: "paint:output"},
     "drop": [90, 91], "link": [[84, 0, 83, "input_image", "IMAGE"]], "aspect": ["paint:prompt", "aspect_ratio"]},
    {"id": "flux_kontext_max", "label": "FLUX.1 Kontext Max (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_bfl_flux_1_kontext_max_image", "titles": {84: "paint:image", 95: "paint:prompt", 85: "paint:output"},
     "drop": [90, 91], "link": [[84, 0, 95, "input_image", "IMAGE"]], "aspect": ["paint:prompt", "aspect_ratio"]},
    {"id": "flux3_edit", "label": "FLUX.3 (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_bfl_flux3_image_edit", "titles": {4: "paint:image", 3: "paint:prompt", 2: "paint:output"}},
    {"id": "seedream5_flash_edit", "label": "Seedream 5.0 Flash (API)", "api": True, "actions": EDIT,
     "size": {"mp": 4.0, "mult": 16, "max": 4096, "min": 1024},
     "src": "api_bytedance_seedream_5_0_flash_image_edit", "titles": {16: "paint:image", 14: "paint:prompt", 15: "paint:output"}},
    {"id": "grok_edit", "label": "Grok Imagine (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_grok_image_edit", "titles": {6: "paint:image", 9: "paint:prompt", 3: "paint:output"}},
    {"id": "grok_imagine2_edit", "label": "Grok Imagine Image 2 (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_grok_imagine_image_2_image_edit", "titles": {11: "paint:image", 10: "paint:prompt", 12: "paint:output"}, "drop": [13]},
    {"id": "krea3_edit", "label": "Krea 3 (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_krea3_image_edit", "titles": {8: "paint:image", 1: "paint:prompt", 7: "paint:output"}},
    {"id": "luma_uni1_edit", "label": "Luma Uni-1 (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_luma_uni_1_image_edit", "titles": {33: "paint:image", 37: "paint:prompt", 34: "paint:output"}},
    {"id": "meta_muse_edit", "label": "Meta Muse Image (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_meta_muse_image_image_edit", "titles": {4: "paint:image", 3: "paint:prompt", 2: "paint:output"}, "drop": [5]},
    {"id": "nano_banana2_lite_edit", "label": "Nano Banana 2 Lite (API)", "api": True, "actions": EDIT,
     "size": {"mp": 4.0, "mult": 8, "max": 4096},
     "src": "api_nano_banana_2_lite_image_edit", "titles": {8: "paint:image", 3: "paint:prompt", 4: "paint:output"}},
    {"id": "gpt_image_25_sunburst_edit", "label": "GPT Image 2.5 Sunburst, masked (API)", "api": True, "actions": EDIT, "mask_in": True,
     "size": {"mp": 1.0, "mult": 16, "max": 1536},
     "src": "api_openai_gpt_image_25_sunburst_image_edit", "titles": {376: "paint:image", 392: "paint:prompt", 391: "paint:output"},
     "mask": [392, "model.mask"]},
    {"id": "mai_26_edit", "label": "MAI Image 2.6 (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_openrouter_mai_image_26_image_edit", "titles": {6: "paint:image", 5: "paint:prompt", 4: "paint:output"}, "drop": [14]},
    {"id": "mai_26_flash_edit", "label": "MAI Image 2.6 Flash (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_openrouter_mai_image_26_flash_image_edit", "titles": {6: "paint:image", 5: "paint:prompt", 4: "paint:output"}},
    {"id": "hunyuan35_edit", "label": "Hunyuan Image 3.5 preview (API)", "api": True, "actions": EDIT, "size": ONE_MP,
     "src": "api_tencent_hy_image_3_5_preview_image_edit", "titles": {5: "paint:image", 4: "paint:prompt", 2: "paint:output"}},
    {"id": "bria_fibo_edit", "label": "Bria FIBO edit, masked (API)", "api": True, "actions": EDIT, "mask_in": True, "size": ONE_MP,
     "src": "api_bria_image_edit", "titles": {5: "paint:image", 3: "paint:prompt", 8: "paint:output"}, "mask": [3, "mask"]},
    # local
    {"id": "qwen2509_edit", "label": "Qwen Image Edit 2509 Lightning (local)", "api": False, "actions": EDIT, "size": ONE_MP,
     "src": "image_qwen_image_edit_2509", "titles": {78: "paint:image", 469: "paint:output"}, "sub": {111: "paint:prompt"}},
    {"id": "qwen21_edit", "label": "Qwen Image 2.1 (local)", "api": False, "actions": EDIT, "size": ONE_MP,
     "src": "image_qwen_image_2_1_image_edit", "titles": {470: "paint:image", 461: "paint:output"}, "drop": [475],
     "sub": {484: "paint:prompt"}, "prompt_input": "on_false"},
    {"id": "qwen21_turbo_edit", "label": "Qwen Image 2.1 Turbo (local)", "api": False, "actions": EDIT, "size": ONE_MP,
     "src": "image_qwen_image_2_1_turbo_image_edit", "titles": {470: "paint:image", 461: "paint:output"},
     "sub": {484: "paint:prompt"}, "prompt_input": "on_false"},
    {"id": "flux2_klein_4b_edit", "label": "FLUX.2 Klein 4B (local)", "api": False, "actions": EDIT, "size": ONE_MP,
     "src": "image_flux2_klein_image_edit_4b_distilled", "titles": {76: "paint:image", 9: "paint:output"}, "drop": [92, 81, 94],
     "sub": {74: "paint:prompt"}},
    {"id": "flux2_klein_9b_edit", "label": "FLUX.2 Klein 9B (local)", "api": False, "actions": EDIT, "size": ONE_MP, "format": "api",
     "src": "c:image_flux2_klein_image_edit_9b_distilled", "models_from": "image_flux2_klein_image_edit_9b_base"},
    {"id": "longcat_edit", "label": "LongCat Image Edit (local)", "api": False, "actions": EDIT, "size": ONE_MP,
     "src": "image_longcat_image_edit", "titles": {13: "paint:image", 9: "paint:output"}, "sub": {4: "paint:prompt"}},
    {"id": "firered_edit", "label": "FireRed Image Edit 1.1 (local)", "api": False, "actions": EDIT, "size": ONE_MP,
     "src": "image_firered_image_edit1_1", "titles": {143: "paint:image", 9: "paint:output"}, "sub": {187: "paint:prompt"}},
    {"id": "omnigen2_edit", "label": "OmniGen2 (local)", "api": False, "actions": EDIT, "size": ONE_MP,
     "src": "image_omnigen2_image_edit", "titles": {16: "paint:image", 6: "paint:prompt", 9: "paint:output"}, "merge": [33]},

    # ── remove background / select subject ─────────────────────────────────
    {"id": "birefnet", "label": "BiRefNet (local, ComfyUI)", "api": False, "actions": ["background", "select_subject"], "size": UPSCALE_IN,
     "src": "utility_birefnet_remove_background", "titles": {17: "paint:image"},
     "add": [{"id": 900, "type": "SaveImage", "title": "paint:output", "widgets_values": ["paint/generate"], "pos": [900, 0],
              "inputs": [{"name": "images", "type": "IMAGE"}], "outputs": []}],
     "link": [[19, 0, 900, "images", "IMAGE"]]},
    {"id": "bria_rmbg", "label": "Bria remove background (API)", "api": True, "actions": ["background", "select_subject"], "size": UPSCALE_IN,
     "src": "utility_bria_remove_image_background", "titles": {26: "paint:image", 32: "paint:tune", 27: "paint:output"}},
    {"id": "recraft_rmbg", "label": "Recraft remove background (API)", "api": True, "actions": ["background", "select_subject"],
     "size": UPSCALE_IN, "format": "api", "file": "recraft_rmbg.json",
     "graph": {"1": {"class_type": "LoadImage", "inputs": {"image": "paint/in.png"}, "_meta": {"title": "paint:image"}},
               "2": {"class_type": "RecraftRemoveBackgroundNode", "inputs": {"image": ["1", 0]}, "_meta": {"title": "paint:tune"}},
               "3": {"class_type": "SaveImage", "inputs": {"filename_prefix": "paint/generate", "images": ["2", 0]},
                     "_meta": {"title": "paint:output"}}}},
    {"id": "rmbg2", "label": "RMBG: RMBG-2.0 (local)", "file": "rmbg2.json", "api": False, "format": "api",
     "actions": ["background", "select_subject"], "size": UPSCALE_IN, "tune": ["2"], "pack": "ComfyUI-RMBG",
     "downloads_itself": ["RMBG/RMBG-2.0"], "from": "RemoveBackground_RMBG2"},
] + [
    {"id": f"rmbg_{key.lower().replace('-', '_').replace('.', '')}", "label": f"RMBG: {key} (local)", "file": "rmbg2.json", "api": False,
     "format": "api", "actions": ["background", "select_subject"], "size": UPSCALE_IN, "tune": ["2"], "pack": "ComfyUI-RMBG",
     "set": {"*": [["2", "model", key]]}, "downloads_itself": [f"RMBG/{key}"], "from": "RemoveBackground_RMBG2"}
    for key in ("INSPYRENET", "BEN", "BEN2")
] + [
    {"id": f"rmbg_{key.lower().replace('-', '_')}", "label": f"RMBG: {key} (local)", "file": "rmbg_birefnet.json", "api": False,
     "format": "api", "actions": ["background", "select_subject"], "size": UPSCALE_IN, "tune": ["2"], "pack": "ComfyUI-RMBG",
     "set": {"*": [["2", "model", key]]}, "downloads_itself": [f"RMBG/BiRefNet/{key}"], "from": "ComfyUI-RMBG BiRefNet (RMBG)",
     **({"graph": {"1": {"class_type": "LoadImage", "inputs": {"image": "paint/in.png"}, "_meta": {"title": "paint:image"}},
                   "2": {"class_type": "BiRefNetRMBG", "_meta": {"title": "paint:tune"},
                         "inputs": {"image": ["1", 0], "model": "BiRefNet-general", "sensitivity": 1.0, "mask_blur": 0, "mask_offset": 0,
                                    "invert_output": False, "refine_foreground": False, "background": "Alpha",
                                    "background_color": "#222222"}},
                   "3": {"class_type": "MaskToImage", "inputs": {"mask": ["2", 1]}},
                   "4": {"class_type": "SaveImage", "inputs": {"filename_prefix": "paint/generate", "images": ["3", 0]},
                         "_meta": {"title": "paint:output"}}}} if key == "BiRefNet-general" else {})}
    for key in ("BiRefNet-general", "BiRefNet_512x512", "BiRefNet-HR", "BiRefNet-portrait", "BiRefNet-matting",
                "BiRefNet-HR-matting", "BiRefNet_lite", "BiRefNet_lite-2K", "BiRefNet_dynamic", "BiRefNet_lite-matting",
                "BiRefNet_toonout")
] + [
    # ── upscale ────────────────────────────────────────────────────────────
    {"id": "upscale_model", "label": "Upscale model (local)", "file": "upscale_model.json", "api": False, "format": "api",
     "actions": ["upscale"], "size": UPSCALE_IN, "models_from": "c:upscale_using_model", "from": "upscale_using_model"},
    {"id": "magnific_precise", "label": "Magnific Precise (API)", "file": "magnific_precise.json", "api": True, "format": "api",
     "actions": ["upscale"], "size": AS_IS, "scale": ["2", "scale_factor"], "tune": ["2"], "from": "api_magnific_image_upscale_precise"},
    {"id": "magnific_creative", "label": "Magnific Creative (API)", "api": True, "actions": ["upscale"], "size": AS_IS, "format": "api",
     "src": "c:api_magnific_image_upscale_creative", "scale": ["paint:tune", "scale_factor"], "tune": ["paint:tune"]},
    {"id": "crystal", "label": "Crystal Upscaler, Clarity AI (API)", "api": True, "actions": ["upscale"], "size": AS_IS,
     "src": "api_clarity_ai_crystal_upscale", "titles": {2: "paint:image", 1: "paint:tune", 4: "paint:output"},
     "scale": ["paint:tune", "model.scale_factor", "number"], "tune": ["paint:tune"]},
    {"id": "recraft_crisp", "label": "Recraft Crisp Upscale (API)", "api": True, "actions": ["upscale"], "size": AS_IS,
     "src": "utility_recraft_crisp_image_upscale", "titles": {2: "paint:image", 7: "paint:tune", 3: "paint:output"}},
    {"id": "recraft_creative", "label": "Recraft Creative Upscale (API)", "api": True, "actions": ["upscale"], "size": AS_IS,
     "src": "utility_recraft_creative_image_upscale", "titles": {2: "paint:image", 8: "paint:tune", 3: "paint:output"}},
    {"id": "topaz_bloom2", "label": "Topaz Bloom 2 (API)", "api": True, "actions": ["upscale"], "size": AS_IS,
     "src": "api_topaz_image_enhance_bloom2", "titles": {3: "paint:image", 2: "paint:tune", 4: "paint:output"}, "tune": ["paint:tune"]},
    {"id": "topaz_wonder35", "label": "Topaz Wonder 3.5 (API)", "api": True, "actions": ["upscale"], "size": AS_IS,
     "src": "api_topaz_image_enhance_wonder3_5", "titles": {3: "paint:image", 8: "paint:tune", 4: "paint:output"}, "tune": ["paint:tune"]},
    {"id": "wavespeed_seedvr2", "label": "SeedVR2 on WaveSpeed (API)", "api": True, "actions": ["upscale"], "size": AS_IS,
     "src": "api_wavespeed_image_upscale", "titles": {9: "paint:image", 18: "paint:tune", 3: "paint:output"}, "tune": ["paint:tune"]},
    {"id": "seedvr2_7b", "label": "SeedVR2 7B (local)", "api": False, "actions": ["upscale"], "size": UPSCALE_IN,
     "src": "utility_seedvr2_7b_int8_upscale_image", "titles": {1: "paint:image", 9: "paint:output"},
     "sub": {57: "paint:scale", 54: "paint:tune"}, "scale": ["paint:scale", "resize_type.multiplier", "number"],
     "tune": ["paint:tune"]},

    # ── select objects (SAM3) ──────────────────────────────────────────────
    {"id": "sam3", "label": "SAM 3.1 (local)", "api": False, "actions": ["select_objects"], "size": UPSCALE_IN,
     "src": "utility_image_segment_sam3", "titles": {79: "paint:image"}, "drop": [111, 114],
     "sub": {78: "paint:prompt", 75: "paint:tune"}, "prompt_input": "text", "optional": ["paint:prompt", "paint:box"],
     "tune": ["paint:tune"],
     "add": [{"id": 901, "type": "PrimitiveBoundingBox", "title": "paint:box", "widgets_values": [0, 0, 512, 512], "pos": [-300, 300],
              "inputs": [], "outputs": [{"name": "BOUNDING_BOX", "type": "BOUNDING_BOX"}]},
             {"id": 902, "type": "MaskToImage", "widgets_values": [], "pos": [700, 0],
              "inputs": [{"name": "mask", "type": "MASK"}], "outputs": [{"name": "IMAGE", "type": "IMAGE"}]},
             {"id": 903, "type": "SaveImage", "title": "paint:output", "widgets_values": ["paint/generate"], "pos": [950, 0],
              "inputs": [{"name": "images", "type": "IMAGE"}], "outputs": []}],
     "link": [[901, 0, 99, "bboxes", "BOUNDING_BOX"], [99, 0, 902, "mask", "MASK"], [902, 0, 903, "images", "IMAGE"]]},
]

SERVER_KEYS = ("id", "label", "file", "api", "format", "actions", "size", "prompts", "prompt_input", "set", "aspect", "dims",
               "scale", "tune", "optional", "pack", "downloads_itself", "from", "mask_in")


def load(name):
    folder = CUSTOM if name.startswith("c:") else OFFICIAL
    with open(os.path.join(folder, name.replace("c:", "") + ".json"), encoding="utf-8") as fh:
        return json.load(fh)


# ── trimming a canvas-format workflow ─────────────────────────────────────────

def _links(d):
    """The root links as {id: [id, from, from_slot, to, to_slot, type]}."""
    return {L[0]: L for L in d.get("links", [])}


def _node(d, nid):
    return next((n for n in d["nodes"] if n["id"] == nid), None)


def _unlink(d, lid):
    L = _links(d).get(lid)
    if not L:
        return
    _id, a, a_slot, b, b_slot, _t = L[:6]
    na, nb = _node(d, a), _node(d, b)
    if na and a_slot < len(na.get("outputs", [])):
        out = na["outputs"][a_slot]
        out["links"] = [x for x in (out.get("links") or []) if x != lid] or None
    if nb:
        for inp in nb.get("inputs", []):
            if inp.get("link") == lid:
                inp["link"] = None
    d["links"] = [x for x in d["links"] if x[0] != lid]


def drop_node(d, nid):
    n = _node(d, nid)
    if not n:
        raise KeyError(f"node {nid} is not in the template")
    for inp in n.get("inputs", []):
        if inp.get("link") is not None:
            _unlink(d, inp["link"])
    for out in n.get("outputs", []):
        for lid in list(out.get("links") or []):
            _unlink(d, lid)
    d["nodes"] = [x for x in d["nodes"] if x["id"] != nid]


def add_link(d, a, a_slot, b, b_input, typ):
    nb = _node(d, b)
    na = _node(d, a)
    if not na or not nb:
        raise KeyError(f"link {a} -> {b}: a node is not there")
    slot = next(i for i, inp in enumerate(nb["inputs"]) if inp["name"] == b_input)
    if nb["inputs"][slot].get("link") is not None:
        _unlink(d, nb["inputs"][slot]["link"])
    lid = max([L[0] for L in d["links"]] + [d.get("last_link_id") or 0]) + 1
    d["links"].append([lid, a, a_slot, b, slot, typ])
    d["last_link_id"] = lid
    nb["inputs"][slot]["link"] = lid
    out = na["outputs"][a_slot]
    out["links"] = (out.get("links") or []) + [lid]


def merge_into(d, src, dst):
    """Whatever *src* (a LoadImage) feeds is fed by *dst* instead; *src* goes."""
    n = _node(d, src)
    for slot, out in enumerate(n.get("outputs", [])):
        for lid in list(out.get("links") or []):
            L = _links(d)[lid]
            to, to_slot, typ = L[3], L[4], L[5]
            name = _node(d, to)["inputs"][to_slot]["name"]
            _unlink(d, lid)
            add_link(d, dst, slot, to, name, typ)
    drop_node(d, src)


def prune_subgraphs(d):
    """Keep only the subgraph definitions some node still uses."""
    defs = d.get("definitions", {}).get("subgraphs", [])
    if not defs:
        return
    by_id = {s["id"]: s for s in defs}
    used, todo = set(), [n["type"] for n in d["nodes"]]
    while todo:
        t = todo.pop()
        if t in by_id and t not in used:
            used.add(t)
            todo += [n["type"] for n in by_id[t].get("nodes", [])]
    d["definitions"]["subgraphs"] = [s for s in defs if s["id"] in used]


def node_types(d):
    """Every node type in the workflow (subgraphs' too), subgraph ids left out."""
    defs = {s["id"]: s for s in d.get("definitions", {}).get("subgraphs", [])}
    out = set()
    for n in d.get("nodes", []) + [x for s in defs.values() for x in s.get("nodes", [])]:
        if n["type"] not in defs:
            out.add(n["type"])
    return out


def models_of(d):
    """[{name, url, directory}] every node of a canvas-format workflow says it needs."""
    seen, out = set(), []
    subs = [x for s in d.get("definitions", {}).get("subgraphs", []) for x in s.get("nodes", [])]
    for n in d.get("nodes", []) + subs:
        for m in (n.get("properties") or {}).get("models") or []:
            if m.get("name") and m.get("url") and m["name"] not in seen:
                seen.add(m["name"])
                out.append({"name": m["name"], "url": m["url"], "directory": m.get("directory") or ""})
    return out


def trim(r):
    d = copy.deepcopy(load(r["src"]))
    for nid in r.get("merge", []):
        img = next(k for k, v in r["titles"].items() if v == "paint:image")
        merge_into(d, nid, img)
    for nid in r.get("drop", []):
        drop_node(d, nid)
    for n in [x for x in d["nodes"] if x["type"] in SHOW_ONLY]:
        drop_node(d, n["id"])
    for spec in r.get("add", []):
        n = {"id": spec["id"], "type": spec["type"], "pos": spec.get("pos", [0, 0]), "size": [270, 120], "flags": {}, "order": 0,
             "mode": 0, "inputs": [dict(i, link=None) for i in spec.get("inputs", [])],
             "outputs": [dict(o, links=None) for o in spec.get("outputs", [])], "properties": {"Node name for S&R": spec["type"]},
             "widgets_values": spec.get("widgets_values", [])}
        if spec.get("title"):
            n["title"] = spec["title"]
        d["nodes"].append(n)
        d["last_node_id"] = max(d.get("last_node_id") or 0, spec["id"])
    for a, a_slot, b, b_input, typ in r.get("link", []):
        add_link(d, a, a_slot, b, b_input, typ)
    if r.get("mask"):
        img = next(k for k, v in r["titles"].items() if v == "paint:image")
        add_link(d, img, 1, r["mask"][0], r["mask"][1], "MASK")
    for nid, title in (r.get("titles") or {}).items():
        n = _node(d, nid)
        if not n:
            raise KeyError(f"{r['id']}: node {nid} is not in {r['src']}")
        n["title"] = title
    for nid, title in (r.get("sub") or {}).items():
        hits = [n for s in d.get("definitions", {}).get("subgraphs", []) for n in s.get("nodes", []) if n["id"] == nid]
        if len(hits) != 1:
            raise KeyError(f"{r['id']}: subgraph node {nid} found {len(hits)} times")
        hits[0]["title"] = title
    prune_subgraphs(d)
    # Seeds: ComfyUI draws a new one each run anyway (and Paint sets them); the canvas copy says so.
    d.pop("extra", None)
    return d


# ── API-format workflows (agentY-core's own, written here) ─────────────────────

def titled_api(r):
    g = copy.deepcopy(r.get("graph") or load(r["src"]))
    if "graph" in r:
        return g
    ids = sorted(g, key=lambda k: [int(p) for p in k.split(":")])
    def first(cls):
        return next(k for k in ids if g[k]["class_type"] in cls)
    g[first(("LoadImage",))].setdefault("_meta", {})["title"] = "paint:image"
    g[first(("SaveImage", "SaveImageAdvanced"))].setdefault("_meta", {})["title"] = "paint:output"
    if r["id"] == "magnific_creative":
        g[first(("MagnificImageUpscalerCreativeNode",))]["_meta"]["title"] = "paint:tune"
    if r["id"] == "flux2_klein_9b_edit":
        k = next(k for k in ids if g[k]["class_type"] == "CLIPTextEncode" and "positive" in str(g[k].get("_meta", {}).get("title", "")).lower())
        g[k]["_meta"]["title"] = "paint:prompt"
    return g


def main():
    os.makedirs(OUT, exist_ok=True)
    index = []
    for r in RECIPES:
        fmt = r.get("format") or "ui"
        e = {k: r[k] for k in SERVER_KEYS if k in r}
        e["format"] = fmt
        e.setdefault("from", r.get("src", "").replace("c:", ""))
        if fmt == "ui":
            d = trim(r)
            e["file"] = r["id"] + ".json"
            e["models"] = models_of(d)
            e["nodes"] = sorted(node_types(d))
            with open(os.path.join(OUT, e["file"]), "w", encoding="utf-8") as fh:
                json.dump(d, fh, indent=1)
        else:
            if "src" in r or "graph" in r:
                if r.get("graph") is None and r.get("src") is None:
                    pass
                g = titled_api(r)
                e["file"] = r.get("file") or (r["id"] + ".json")
                if not os.path.exists(os.path.join(OUT, e["file"])) or r.get("src") or r.get("graph"):
                    with open(os.path.join(OUT, e["file"]), "w", encoding="utf-8") as fh:
                        json.dump(g, fh, indent=1)
            with open(os.path.join(OUT, e["file"]), encoding="utf-8") as fh:
                g = json.load(fh)
            e["nodes"] = sorted({v["class_type"] for v in g.values()})
            if r.get("models_from"):
                e["models"] = [m for m in models_of(load(r["models_from"]))]
        index.append(e)
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1)
    print(f"{len(index)} workflows written to {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
