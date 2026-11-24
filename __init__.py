# Old "BEPIC_*" environment variables count as their IMAGE_VIEWER_* names; first,
# since the modules below read them as they load.
from .src.legacy_names import adopt_old_env
adopt_old_env()

# ComfyUI's page fetches every .js file here at startup; a low open-file limit (macOS: 256) made some fail.
from .src.open_files import apply as _raise_open_files
_raise_open_files()

from .src.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .src import viewer_api  # register /imageviewer/* HTTP routes

WEB_DIRECTORY = "js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
