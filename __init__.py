# Old "BEPIC_*" environment variables count as their IMAGE_VIEWER_* names; first,
# since the modules below read them as they load.
from .legacy_names import adopt_old_env
adopt_old_env()

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import viewer_api  # register /imageviewer/* HTTP routes

WEB_DIRECTORY = "js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']