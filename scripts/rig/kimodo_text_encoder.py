"""Put Kimodo's text encoder in a folder of its own, from Meta's gated Llama 3 or from a copy of it.

Run by install_rig_tools.py with Kimodo's own Python (it has huggingface_hub):

    python kimodo_text_encoder.py --dir <root>/kimodo/text_encoders [--base auto|meta|mirror|<repo id>]

Kimodo's text encoder is LLM2Vec: Meta-Llama-3-8B-Instruct's weights with bidirectional attention and two
LoRA adapters from McGill-NLP. The adapters are open; the base weights are gated on Hugging Face until Meta
approves a request. NousResearch/Meta-Llama-3-8B-Instruct holds the same files (same sizes, the same
Llama 3 licence, which allows passing them on), and is not gated.

What this does, so that Kimodo's own code loads it unchanged (TEXT_ENCODERS_DIR, which Kimodo joins with
the adapters' repo names):

    <dir>/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/             adapter 1, its config, tokenizer
    <dir>/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised/  adapter 2
    <dir>/base/<repo id>/                                               the 16 GB of Llama 3 weights

and points adapter 1's adapter_config.json ("base_model_name_or_path") at the base folder. Its config.json is
left as it is: LLM2Vec reads the model's name from there ("meta-llama/Meta-Llama-3-8B-Instruct") and only then
wraps a prompt in Llama 3's chat format, as the model was trained with - from a copy too.

--base auto (the default) takes Meta's repo when this Hugging Face login has access to it, else the copy.
Run it again with --base meta once Meta has said yes: only the base is fetched again.

Prints one last line "@@{...}" with {"dir", "base", "base_dir"}.
"""
import argparse
import json
import os
import sys

META = "meta-llama/Meta-Llama-3-8B-Instruct"
MIRROR = "NousResearch/Meta-Llama-3-8B-Instruct"
ADAPTERS = ("McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp",
            "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised")
BASE_FILES = ["config.json", "generation_config.json", "model*.safetensors", "model.safetensors.index.json",
              "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "LICENSE", "USE_POLICY.md"]


def has_access(repo):
    """Whether this login may download the gated repo (its config.json comes)."""
    from huggingface_hub import hf_hub_download
    try:
        hf_hub_download(repo, "config.json")
        return True
    except Exception as e:  # GatedRepoError, 401 / 403, "awaiting a review"
        print(f"== {repo}: no access yet ({type(e).__name__}: {str(e).splitlines()[0][:160]})", flush=True)
        return False


def choose_base(want):
    if want == "meta":
        return META
    if want == "mirror":
        return MIRROR
    if want and want != "auto":
        return want
    return META if has_access(META) else MIRROR


def point_adapter(mntp_dir, base_dir):
    """adapter_config.json of the first adapter -> the base folder (transformers loads the base from it)."""
    path = os.path.join(mntp_dir, "adapter_config.json")
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    cfg["base_model_name_or_path"] = base_dir.replace("\\", "/")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
    os.replace(tmp, path)


def check_name(mntp_dir):
    """LLM2Vec's chat format hangs on this name in the adapter's config.json; say so if it is not there."""
    with open(os.path.join(mntp_dir, "config.json"), encoding="utf-8") as fh:
        name = json.load(fh).get("_name_or_path")
    if name != META:
        print(f"!! {mntp_dir}/config.json names {name!r}, not {META!r}: prompts would miss Llama 3's chat format",
              flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--base", default="auto", help="auto, meta, mirror, or a Hugging Face repo id")
    a = ap.parse_args(argv)
    from huggingface_hub import snapshot_download
    root = os.path.abspath(os.path.expanduser(a.dir))
    os.makedirs(root, exist_ok=True)
    base = choose_base(a.base)
    print(f"== Llama 3 weights from {base}" + (" (an ungated copy of Meta's)" if base == MIRROR else ""), flush=True)
    for repo in ADAPTERS:
        print(f"$ download {repo}", flush=True)
        snapshot_download(repo, local_dir=os.path.join(root, *repo.split("/")))
    base_dir = os.path.join(root, "base", *base.split("/"))
    print(f"$ download {base} (about 16 GB)", flush=True)
    snapshot_download(base, local_dir=base_dir, allow_patterns=BASE_FILES)
    mntp = os.path.join(root, *ADAPTERS[0].split("/"))
    point_adapter(mntp, base_dir)
    check_name(mntp)
    print("@@" + json.dumps({"dir": root, "base": base, "base_dir": base_dir}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
