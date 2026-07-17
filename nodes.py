import os
import json
import random
from PIL import Image
import numpy as np
import torch
import folder_paths
from server import PromptServer

try:
    from comfy.comfy_types.node_typing import IO
except Exception:
    IO = None

try:
    from . import roto_raster
except Exception:
    roto_raster = None

try:
    from . import file_writer
except Exception:
    file_writer = None


_ANY = IO.ANY if IO is not None else "IMAGE"

# File formats offered by the "save to ./output" mode. Discovered from the
# installed writers when file_writer imports cleanly, else a safe static list.
_FILE_FORMATS = file_writer.FILE_FORMATS if file_writer is not None else [
    "png", "exr", "tiff", "jpg", "mp4", "mov", "webm"]
_DEFAULT_FORMAT = "png" if "png" in _FILE_FORMATS else _FILE_FORMATS[0]


def _dims_from_input(inp):
    """Return (N, H, W) from a ComfyUI IMAGE [B,H,W,C] / MASK [B,H,W] tensor, or
    a native VIDEO object."""
    try:
        if isinstance(inp, torch.Tensor):
            t = inp
            if t.ndim == 4:        # B,H,W,C
                return int(t.shape[0]), int(t.shape[1]), int(t.shape[2])
            if t.ndim == 3:        # B,H,W  (mask)
                return int(t.shape[0]), int(t.shape[1]), int(t.shape[2])
            if t.ndim == 2:        # H,W
                return 1, int(t.shape[0]), int(t.shape[1])
        # ComfyUI VIDEO object: read dims/count without materializing frames.
        if hasattr(inp, "get_dimensions") and hasattr(inp, "get_frame_count"):
            w, h = inp.get_dimensions()
            return int(inp.get_frame_count()), int(h), int(w)
    except Exception:
        pass
    return 1, 512, 512


def _points_prompt(json_str, label):
    """Build a SAM3_POINTS_PROMPT dict from a normalized [{x,y},...] JSON string."""
    pts, labels = [], []
    try:
        arr = json.loads(json_str) if json_str and json_str.strip() else []
    except Exception:
        arr = []
    if isinstance(arr, list):
        for p in arr:
            try:
                x = float(p["x"])
                y = float(p["y"])
            except Exception:
                continue
            pts.append([x, y])
            labels.append(label)
    return {"points": pts, "labels": labels}


class bEpicSendToViewer:
    def __init__(self):
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "input": (IO.ANY, ) if IO is not None else (("IMAGE", "MASK"),),
                "tab_name": ("STRING", {"default": ""}),
                # "save to ./output" mode. When off (default) the node behaves
                # exactly as before — temp PNGs pushed to the viewer only. When
                # on, the incoming frames are ALSO persisted to ComfyUI's output
                # dir in `file_format`. The JS hides the three config widgets
                # below while this is off.
                "save_to_output": ("BOOLEAN", {"default": False}),
                "file_format": (_FILE_FORMATS, {"default": _DEFAULT_FORMAT}),
                "fps": ("FLOAT", {"default": 24.0, "min": 0.01, "max": 1000.0,
                                  "step": 0.01}),
                "filename_prefix": ("STRING", {"default": "bEpic"}),
            },
            "optional": {
                # Hidden (via JS) stores written by the in-viewer tools. Kept as
                # widgets so their values serialize into the workflow and reach
                # the backend on execute.
                "roto_data":     ("STRING", {"default": "", "multiline": False}),
                "sam3_positive": ("STRING", {"default": "[]", "multiline": False}),
                "sam3_negative": ("STRING", {"default": "[]", "multiline": False}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    # image passthrough + roto matte + SAM3 point prompts. The JS only reveals
    # the optional output slots once the corresponding viewer tool is used, but
    # the tuple returned here always matches this fixed order/length so ComfyUI
    # can map outputs by index.
    RETURN_TYPES = (_ANY, "MASK", "SAM3_POINTS_PROMPT", "SAM3_POINTS_PROMPT")
    RETURN_NAMES = ("image", "roto_mask", "positive_points", "negative_points")
    FUNCTION = "send"
    OUTPUT_NODE = True
    CATEGORY = "image/bEpic"

    def send(self, input, tab_name="", save_to_output=False,
             file_format="png", fps=24.0, filename_prefix="bEpic",
             roto_data="", sam3_positive="[]", sam3_negative="[]",
             unique_id=None):
        # ── 1. Save incoming tensors to temp PNGs and push to the viewer ──────
        def process_batch(inp, label):
            if inp is None:
                return []
            batch_results = []

            try:
                samples = inp
                for i, tensor in enumerate(samples):
                    t = tensor
                    arr = t.cpu().numpy()

                    # Detect if this array contains 3 or 4 color channels on any axis
                    chan_axis = None
                    for ax, s in enumerate(arr.shape):
                        if s in (3, 4):
                            chan_axis = ax
                            break

                    if chan_axis is not None and arr.ndim >= 2:
                        try:
                            # Move channel axis to last to get H,W,C
                            if chan_axis != arr.ndim - 1:
                                img_arr = np.moveaxis(arr, chan_axis, -1)
                            else:
                                img_arr = arr

                            # If there's a leading batch dimension, squeeze it
                            if img_arr.ndim == 4 and img_arr.shape[0] == 1:
                                img_arr = img_arr[0]

                            array = 255.0 * img_arr
                            img = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
                            # Convert RGBA → RGB so PNG saves in full colour
                            if img.mode == 'RGBA':
                                img = img.convert('RGB')
                            safe_label = label if label else f"send"
                            filename = f"bEpic_S_{unique_id}_{safe_label}_{i:04d}_{random.randint(1,1000)}.png"
                            img.save(os.path.join(self.output_dir, filename), compress_level=4)
                            full = os.path.abspath(os.path.join(self.output_dir, filename))
                            batch_results.append({"filename": filename, "subfolder": "", "type": self.type, "path": full})
                        except Exception:
                            continue
                    else:
                        try:
                            mask_arr = arr
                            if mask_arr.ndim == 3 and mask_arr.shape[0] == 1:
                                mask_arr = mask_arr[0]
                            if mask_arr.ndim == 3 and mask_arr.shape[-1] == 1:
                                mask_arr = mask_arr[..., 0]
                            mask_arr = (255.0 * mask_arr).astype(np.uint8)
                            mask_img = Image.fromarray(np.clip(mask_arr, 0, 255).astype(np.uint8)).convert('L')
                            safe_label = label if label else f"send"
                            mask_filename = f"bEpic_S_{unique_id}_{safe_label}_{i:04d}_{random.randint(1,1000)}_mask.png"
                            mask_img.save(os.path.join(self.output_dir, mask_filename), compress_level=4)
                            full = os.path.abspath(os.path.join(self.output_dir, mask_filename))
                            batch_results.append({"filename": mask_filename, "subfolder": "", "type": "mask", "path": full})
                        except Exception:
                            continue
            except Exception:
                return []
            return batch_results

        safe_label = tab_name.replace(" ", "_") if tab_name else "send"

        # Three source kinds feed the viewer tab:
        #   • a ComfyUI VIDEO object   → decoded to a playable file and shown as
        #     a <video> (always, even with the toggle off — it can't preview as
        #     temp PNGs); persisted to ./output when the toggle is on.
        #   • save-to-output on        → frames persisted in the chosen format
        #     (mp4/exr/tiff/...) and those files shown in the viewer.
        #   • otherwise                → the temp-PNG preview path used forever.
        # write_output/write_video_input return viewer frame dicts (saved files
        # for video and browser images, temp PNG proxies for exr/tiff/...).
        tab_frames = None
        if file_writer is not None and file_writer.is_video_input(input):
            try:
                _saved, tab_frames = file_writer.write_video_input(
                    input, save_to_output, filename_prefix, file_format, fps)
            except Exception as e:
                print(f"\033[91m[bEpicSendToViewer] video input failed: {e}\033[0m")
                tab_frames = None
        elif save_to_output and file_writer is not None:
            try:
                _saved, tab_frames = file_writer.write_output(
                    input, filename_prefix, file_format, fps)
            except Exception as e:
                print(f"\033[91m[bEpicSendToViewer] save to output failed: {e}\033[0m")
                tab_frames = None
        if tab_frames is None:
            tab_frames = process_batch(input, safe_label)

        tabs = {"tab": tab_frames}

        PromptServer.instance.send_sync("bepic.viewer.update", {
            "tabs": tabs,
            "unique_id": unique_id
        })

        # ── 2. Build the tool outputs ────────────────────────────────────────
        N, H, W = _dims_from_input(input)

        roto_obj = None
        if roto_data and roto_data.strip():
            try:
                roto_obj = json.loads(roto_data)
            except Exception:
                roto_obj = None

        if roto_obj and roto_raster is not None:
            try:
                mask_np = roto_raster.rasterize(roto_obj, W, H, N)
            except Exception:
                mask_np = np.zeros((N, H, W), dtype=np.float32)
        else:
            mask_np = np.zeros((N, H, W), dtype=np.float32)
        roto_mask = torch.from_numpy(np.ascontiguousarray(mask_np)).float()

        positive_points = _points_prompt(sam3_positive, 1)
        negative_points = _points_prompt(sam3_negative, 0)

        # ── 3. Passthrough + tool outputs ────────────────────────────────────
        return (input, roto_mask, positive_points, negative_points)


# mapping dictionaries for external use (nodes.py imports these)

NODE_CLASS_MAPPINGS = {
    "bEpicSendToViewer": bEpicSendToViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "bEpicSendToViewer": "bEpic Send To Image Viewer",
}
