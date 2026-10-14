"""Which folders the viewer's HTTP routes may read from and write to.

Every /bepic/* route that takes a path checks it here. Those routes answer
anything that can reach ComfyUI's port — another machine when ComfyUI runs with
--listen, or any page open in the user's own browser — so a path in a request
is a claim to be checked, never a permission.

Allowed, always: ComfyUI's input, output and temp folders. On top of those, the
user can allow more folders, e.g. a project drive:
  - one per line in ~/.bepic_viewer/roots.txt ('#' starts a comment; the file
    named by BEPIC_VIEWER_ROOTS_FILE instead, when that is set), or
  - in the BEPIC_VIEWER_ROOTS environment variable, separated by ';' on Windows
    and ':' elsewhere — the form a launcher such as AYON can set.
Both live where ComfyUI's web API can't write — its userdata routes are confined
to the per-user folder. The file is re-read whenever it changes, so an edit
needs no restart.

The file is kept per OS user, beside the viewer's settings (viewer_settings.py),
and NOT in ComfyUI's folder, where it used to be (bepic_viewer_roots.txt). That
folder is a git checkout somebody else manages: a launcher or updater that runs
`git stash --include-untracked` before switching versions swept the file into a
stash, and the list was empty again at every start. The old file is still read
— an install that lists folders there keeps working — and its folders are
copied to the new file the first time, so they survive the next sweep.

The viewer's settings page edits the file too (/bepic/roots). That is the one
request that can widen the list, so it is fenced (`may_edit`): answered only
for a request from the ComfyUI machine itself, sent by ComfyUI's own page —
another site open in the browser can't — unless the admin allows remote
editing with BEPIC_VIEWER_ROOTS_REMOTE_EDIT=1, and never when
BEPIC_VIEWER_ROOTS_LOCKED=1. Folders in the environment variable are shown but
can't be removed from the page: whoever set the variable owns them.

Workflow execution is not affected: a node in a queued prompt still loads any
path it is given. This only governs what the viewer's own routes will touch.
"""

import ipaddress
import os
import string
import sys
from urllib.parse import urlsplit

import folder_paths

ROOTS_ENV  = "BEPIC_VIEWER_ROOTS"
ROOTS_FILE_ENV = "BEPIC_VIEWER_ROOTS_FILE"
LEGACY_FILE = os.path.join(folder_paths.base_path, "bepic_viewer_roots.txt")


def _roots_file():
    custom = os.environ.get(ROOTS_FILE_ENV, "").strip().strip('"')
    if custom:
        return os.path.abspath(os.path.expandvars(os.path.expanduser(custom)))
    return os.path.join(os.path.expanduser("~"), ".bepic_viewer", "roots.txt")


ROOTS_FILE = _roots_file()
LOCKED_ENV = "BEPIC_VIEWER_ROOTS_LOCKED"
REMOTE_EDIT_ENV = "BEPIC_VIEWER_ROOTS_REMOTE_EDIT"

_FILE_HEADER = """# Folders the bEpic Image Viewer may open, besides ComfyUI's input, output and
# temp folders. One per line; '#' starts a comment. Edited by hand or from
# ComfyUI's Settings -> bEpic Viewer -> Folders.
"""

_cache = {"key": None, "roots": []}


def _real(path):
    """The one form paths are compared in: absolute, links resolved, case folded.
    Resolving links is what keeps a junction inside an allowed folder from
    reaching out of it."""
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def _inside(real_path, real_root):
    try:
        return os.path.commonpath([real_path, real_root]) == real_root
    except ValueError:                  # different drives, or a malformed path
        return False


def within(path, root):
    """True when `path` lies inside `root` (or is it)."""
    try:
        return _inside(_real(path), _real(root))
    except Exception:
        return False


def comfy_dirs():
    """[(label, path)] for ComfyUI's own media folders."""
    out = []
    for label, get in (("Input",  folder_paths.get_input_directory),
                       ("Output", folder_paths.get_output_directory),
                       ("Temp",   folder_paths.get_temp_directory)):
        try:
            out.append((label, os.path.abspath(get())))
        except Exception:
            pass
    return out


def _env_entries():
    return [e.strip() for e in os.environ.get(ROOTS_ENV, "").split(os.pathsep) if e.strip()]


def _read_entries(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return [line.strip() for line in fh
                    if line.strip() and not line.lstrip().startswith("#")]
    except FileNotFoundError:
        return []
    except Exception as e:
        print(f"[bEpicViewer] could not read {path}: {e}")
        return []


def _write_entries(path, entries, comments=None):
    if comments is None:
        try:
            with open(path, encoding="utf-8") as fh:
                comments = [line.rstrip("\r\n") for line in fh if line.lstrip().startswith("#")]
        except FileNotFoundError:
            comments = _FILE_HEADER.rstrip("\n").split("\n")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(list(comments) + list(entries)) + "\n")
    os.replace(tmp, path)


def _merged(*lists):
    """The entries of each list in order, each folder once."""
    out, seen = [], set()
    for entry in (e for entries in lists for e in entries):
        key = os.path.normcase(expand(entry))
        if key and key not in seen:
            seen.add(key)
            out.append(entry)
    return out


def _adopt_legacy():
    """Copy what the old file in ComfyUI's folder lists into the user's file,
    once per change of the old file: after that it no longer matters whether
    the old one is swept away."""
    old = _read_entries(LEGACY_FILE)
    if not old:
        return
    have = _read_entries(ROOTS_FILE)
    both = _merged(have, old)
    if len(both) > len(have):
        try:
            _write_entries(ROOTS_FILE, both)
        except Exception as e:
            print(f"[bEpicViewer] could not copy {LEGACY_FILE} to {ROOTS_FILE}: {e}")


def file_entries():
    """The folders listed in the file (and in the old one in ComfyUI's folder,
    while it is still there), as written."""
    return _merged(_read_entries(ROOTS_FILE), _read_entries(LEGACY_FILE))


def expand(raw):
    """One entry as the folder it means (expanded, made absolute), or ""."""
    entry = os.path.expandvars(os.path.expanduser(str(raw).strip().strip('"')))
    if not entry:
        return ""
    # "W:" on its own means the current folder on W:, not the drive.
    if len(entry) == 2 and entry[1] == ":":
        entry += os.sep
    # Relative entries are taken from ComfyUI's folder, where the file sits.
    return os.path.abspath(os.path.join(folder_paths.base_path, entry))


def _configured():
    """The folders the user listed, as written (expanded, made absolute)."""
    return [p for p in (expand(e) for e in _env_entries() + file_entries()) if p]


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


# ── What may be allowed, and what may be served ──────────────────────────────
#
# A folder the user allows is a folder of pictures and films, not a way into the
# machine. So the list never holds a whole drive, the home folder or anything
# above it, or the system's own folders; inside an allowed folder nothing under
# a hidden folder (.ssh, .aws, .git ...) or AppData is opened; and the routes that
# hand back a file's bytes hand back media only. Together these keep a key, a
# token or a config out of reach of every route, whatever folder is listed.

# What the viewer shows: pictures, films, sound, 3D files - and the files a 3D
# file names beside itself (a .gltf's .bin, an .obj's .mtl, its textures).
MEDIA_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".ico", ".svg",
    ".tif", ".tiff", ".exr", ".dpx", ".tga", ".hdr",
    ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".avi", ".mpg", ".mpeg", ".wmv", ".flv",
    ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac",
    ".glb", ".gltf", ".fbx", ".obj", ".stl", ".ply", ".usd", ".usda", ".usdc", ".usdz", ".abc",
    ".spz", ".splat", ".ksplat", ".sog",
    ".bin", ".mtl", ".ktx2",
})

_PRIVATE_NAMES = {"appdata", "application data"}


def is_media(path):
    """True for a file the viewer shows, by its extension."""
    return os.path.splitext(str(path or ""))[1].lower() in MEDIA_EXTS


def _private_part(real_path):
    """True when a folder on the way to `real_path` is a hidden one or AppData:
    where keys, tokens and program settings are kept, never media."""
    parts = [p for p in real_path.replace("\\", "/").split("/")[1:] if p]
    return any(p.startswith(".") or p.lower() in _PRIVATE_NAMES for p in parts)


def _system_dirs():
    out = []
    for var in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"):
        v = os.environ.get(var, "").strip()
        if v:
            out.append(v)
    if sys.platform != "win32":
        out += ["/etc", "/bin", "/sbin", "/usr", "/var", "/proc", "/sys", "/dev", "/boot", "/root"]
    return out


def too_broad(path):
    """Why `path` can't be an allowed folder, or "": a drive or filesystem root,
    the home folder or one above it, a system folder, a hidden folder."""
    try:
        real = _real(path)
    except Exception:
        return "not a folder path"
    if os.path.dirname(real) == real:
        return "a whole drive"
    home = _real(os.path.expanduser("~"))
    if _inside(home, real):
        return "the home folder, or a folder that holds it"
    for sysdir in _system_dirs():
        if _inside(real, _real(sysdir)):
            return "a system folder"
    if _private_part(real):
        return "a hidden folder, or one in AppData"
    return ""


def roots():
    """[(label, path, real)] for every allowed folder, ComfyUI's own first."""
    comfy = comfy_dirs()
    key = (os.environ.get(ROOTS_ENV, ""), _mtime(ROOTS_FILE), _mtime(LEGACY_FILE), tuple(comfy))
    if _cache["key"] != key:
        if _cache.get("legacy") != key[2]:
            _cache["legacy"] = key[2]
            _adopt_legacy()
            key = key[:1] + (_mtime(ROOTS_FILE),) + key[2:]
        seen, out = set(), []
        for label, path in comfy + [(p, p) for p in _configured()]:
            real = _real(path)
            if label == path:
                why = too_broad(path)
                if why:
                    print(f"[bEpicViewer] not allowing {path}: {why}. List the project "
                          f"folders inside it instead.")
                    continue
            if real not in seen:
                seen.add(real)
                out.append((label, path, real))
        _cache.update(key=key, roots=out)
    return _cache["roots"]


def is_allowed(path):
    """True when `path` lies inside one of the allowed folders."""
    if not path:
        return False
    try:
        real = _real(path)
    except Exception:
        return False
    comfy = {_real(p) for _, p in comfy_dirs()}
    for _, _, root in roots():
        if _inside(real, root):
            # ComfyUI's own folders are trusted as they are (a Linux or Desktop
            # install may keep them under a hidden folder); inside a folder the
            # user added, nothing below a hidden folder or AppData.
            if root in comfy or not _private_part(real[len(root):] or "/"):
                return True
    return False


def may_serve(path):
    """True when a route may hand back this file's bytes: inside the allowed
    folders AND a picture, film, sound or 3D file. Listing a folder and writing
    an export only need is_allowed; returning a file's content needs this."""
    return is_media(path) and is_allowed(path)


def serve_refusal(path):
    if is_allowed(path):
        return (f"{os.path.basename(path)} is not a picture, film, sound or 3D file, "
                f"and the viewer hands back nothing else.")
    return refusal(path)


def in_comfy_dirs(path):
    """True when `path` lies inside ComfyUI's own input, output or temp folder —
    the only places the viewer writes files next to a source."""
    return any(within(path, p) for _, p in comfy_dirs())


def refusal(path):
    """What to tell the user when a path is out of bounds, and how to allow it."""
    return (f"{path} is outside the folders the viewer may open: ComfyUI's input, "
            f"output and temp folders, plus any listed in {ROOTS_FILE} (one per "
            f"line) or in the {ROOTS_ENV} environment variable. Add the folder "
            f"in ComfyUI's Settings → bEpic Viewer → Folders (or in that file) "
            f"to open it here.")


# ── Editing the list (the settings page) ─────────────────────────────────────

def _truthy(name):
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _ip(text):
    try:
        ip = ipaddress.ip_address(str(text or "").split("%")[0])
    except ValueError:
        return None
    return getattr(ip, "ipv4_mapped", None) or ip


def _is_local(request):
    """True for a request made on the ComfyUI machine itself: over loopback, or
    to one of the machine's own addresses (ComfyUI run with --listen and opened
    by machine name), where the connection comes FROM the address it went TO."""
    remote = _ip(request.remote)
    if remote is None:
        return False
    if remote.is_loopback:
        return True
    try:
        sock = request.transport.get_extra_info("sockname")
        return sock is not None and _ip(sock[0]) == remote
    except Exception:
        return False


def _own_host(host):
    """True when `host` (a Host header, with or without its port) is an IP
    address, localhost, or one of this machine's own names."""
    name = str(host or "").strip().lower()
    if not name:
        return False
    if name.startswith("["):                        # [::1]:8188
        name = name[1:name.find("]")] if "]" in name else name[1:]
    elif name.count(":") == 1:
        name = name.rsplit(":", 1)[0]
    if _ip(name) is not None:
        return True
    if name == "localhost" or name.endswith(".localhost"):
        return True
    import socket
    try:
        own = {socket.gethostname().lower(), socket.getfqdn().lower()}
    except Exception:
        own = set()
    own |= {n.split(".")[0] for n in own}           # the short name too
    return name.rstrip(".") in own


def may_edit(request):
    """(allowed, reason) for a request that would change the list, or look
    outside it.

    A browser always sends Origin on a POST; a page of another site carries its
    own, so it must name the host the request was sent to. A request with no
    Origin at all is not from a browser page.
    """
    if _truthy(LOCKED_ENV):
        return False, f"The folder list is locked ({LOCKED_ENV} is set). Edit {ROOTS_FILE} instead."
    # The name the page was opened by must be this machine's: an address, or
    # localhost / the machine's own name. A site that points its own name at
    # 127.0.0.1 (DNS rebinding) sends a matching Origin and arrives over
    # loopback, so neither check below would catch it; its Host gives it away.
    if not _own_host(request.host):
        return False, "Refused: the page was not opened by this machine's address or name."
    origin = request.headers.get("Origin")
    if origin is not None:
        parts = urlsplit(origin)
        if origin == "null" or not parts.netloc or parts.netloc.lower() != (request.host or "").lower():
            return False, "Refused: the request did not come from ComfyUI's own page."
    if not _is_local(request) and not _truthy(REMOTE_EDIT_ENV):
        return False, (f"The folder list can only be changed from the ComfyUI machine itself "
                       f"(set {REMOTE_EDIT_ENV}=1 there to allow it from others), "
                       f"or by editing {ROOTS_FILE}.")
    return True, ""


def _status(path):
    if not path:
        return "invalid"
    try:
        return "ok" if os.path.isdir(path) else "missing"
    except OSError:
        return "missing"


def describe():
    """Everything the settings page shows about the list."""
    def row(e):
        p = expand(e)
        return {"entry": e, "path": p, "status": _status(p)}
    return {
        "file": ROOTS_FILE,
        "legacy_file": LEGACY_FILE if os.path.isfile(LEGACY_FILE) else "",
        "env_var": ROOTS_ENV,
        "comfy": [{"label": label, "path": path, "status": _status(path)}
                  for label, path in comfy_dirs()],
        "env": [row(e) for e in _env_entries()],
        "file_entries": [row(e) for e in file_entries()],
    }


def write_file_entries(entries):
    """Replace the folders listed in the file, keeping its comment lines.
    Raises ValueError for an entry that can't be a folder path."""
    clean, seen = [], set()
    for raw in entries:
        entry = str(raw or "").strip().strip('"')
        if not entry:
            continue
        if any(ch in entry for ch in "\r\n\0"):
            raise ValueError(f"not a folder path: {entry!r}")
        why = too_broad(expand(entry))
        if why:
            raise ValueError(f"{entry} can't be allowed: it is {why}. "
                             f"Add the project folders inside it instead.")
        key = os.path.normcase(expand(entry))
        if key and key not in seen:
            seen.add(key)
            clean.append(entry)

    _write_entries(ROOTS_FILE, clean)
    # The page shows one list and this is all of it now: a folder left in the
    # old file would come straight back, removed or not.
    if _read_entries(LEGACY_FILE):
        try:
            _write_entries(LEGACY_FILE, [], comments=[
                "# The bEpic Image Viewer keeps its folder list per user now:",
                f"# {ROOTS_FILE}",
                "# (This file is still read; folders listed here are copied there.)"])
        except Exception as e:
            print(f"[bEpicViewer] could not empty {LEGACY_FILE}: {e}")
    _cache["key"] = None
    _cache["legacy"] = _mtime(LEGACY_FILE)
    return clean


def list_folders(path):
    """Sub-folders of `path` for the settings page's folder picker: names only,
    never files. No path: the drives (Windows) or "/". It looks outside the
    allowed folders by design, so it is only ever answered behind may_edit."""
    if not path:
        if sys.platform == "win32":
            drives = [f"{d}:\\" for d in string.ascii_uppercase if os.path.isdir(f"{d}:\\")]
            return {"path": "", "parent": None, "dirs": [{"name": d, "path": d} for d in drives]}
        path = "/"
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(path):
        raise FileNotFoundError(path)
    dirs = []
    with os.scandir(path) as it:
        for e in it:
            try:
                if e.is_dir() and not e.name.startswith((".", "$")):
                    dirs.append({"name": e.name, "path": e.path})
            except OSError:
                continue
    dirs.sort(key=lambda d: d["name"].lower())
    parent = os.path.dirname(path)
    if parent == path:                      # at a drive root
        parent = "" if sys.platform == "win32" else None
    return {"path": path, "parent": parent, "dirs": dirs[:2000]}
