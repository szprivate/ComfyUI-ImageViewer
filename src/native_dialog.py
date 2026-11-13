"""The operating system's own Open File dialog, shown on the ComfyUI machine for a page that runs on it.

No program is started: on Windows the dialog is comdlg32's, called in this process through ctypes; elsewhere it
is tkinter's, where Python has it. One dialog at a time. ``pick_file`` blocks until it is closed, so call it off
the event loop.

    pick_file(start="", title="Open") -> the chosen path, "" when cancelled
    Unavailable  no dialog can be shown here (no desktop, no tkinter)
    Busy         one is open already
"""
import os
import sys
import threading

_lock = threading.Lock()


class Unavailable(Exception):
    pass


class Busy(Exception):
    pass


def _filter_text(filters):
    """[(label, "*.exr;*.png"), ...] as comdlg32 wants it: label NUL pattern NUL ... NUL."""
    return "".join(f"{label}\0{pattern}\0" for label, pattern in filters) + "\0"


def _windows(start, title, filters):
    import ctypes
    from ctypes import wintypes

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wintypes.DWORD), ("hwndOwner", wintypes.HWND), ("hInstance", wintypes.HINSTANCE),
            ("lpstrFilter", wintypes.LPCWSTR), ("lpstrCustomFilter", wintypes.LPWSTR), ("nMaxCustFilter", wintypes.DWORD),
            ("nFilterIndex", wintypes.DWORD), ("lpstrFile", wintypes.LPWSTR), ("nMaxFile", wintypes.DWORD),
            ("lpstrFileTitle", wintypes.LPWSTR), ("nMaxFileTitle", wintypes.DWORD), ("lpstrInitialDir", wintypes.LPCWSTR),
            ("lpstrTitle", wintypes.LPCWSTR), ("Flags", wintypes.DWORD), ("nFileOffset", wintypes.WORD),
            ("nFileExtension", wintypes.WORD), ("lpstrDefExt", wintypes.LPCWSTR), ("lCustData", wintypes.LPARAM),
            ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wintypes.LPCWSTR), ("pvReserved", ctypes.c_void_p),
            ("dwReserved", wintypes.DWORD), ("FlagsEx", wintypes.DWORD),
        ]

    OFN_HIDEREADONLY, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST = 0x4, 0x8, 0x800
    OFN_FILEMUSTEXIST, OFN_EXPLORER = 0x1000, 0x80000
    buf = ctypes.create_unicode_buffer(32768)
    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    # Owned by the window in front (the browser the button was pressed in), so the dialog comes up over it.
    user32 = ctypes.windll.user32
    user32.GetForegroundWindow.restype = wintypes.HWND
    ofn.hwndOwner = user32.GetForegroundWindow()
    ofn.lpstrFilter = _filter_text(filters)
    ofn.lpstrFile = ctypes.cast(buf, wintypes.LPWSTR)
    ofn.nMaxFile = len(buf)
    ofn.lpstrInitialDir = start or None
    ofn.lpstrTitle = title
    ofn.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_HIDEREADONLY
    comdlg32 = ctypes.windll.comdlg32
    comdlg32.GetOpenFileNameW.argtypes = [ctypes.POINTER(OPENFILENAMEW)]
    comdlg32.GetOpenFileNameW.restype = wintypes.BOOL
    if comdlg32.GetOpenFileNameW(ctypes.byref(ofn)):
        return buf.value
    code = comdlg32.CommDlgExtendedError()
    if code:
        raise Unavailable(f"the Open dialog failed (code {code:#x})")
    return ""


def _tk(start, title, filters):
    if sys.platform not in ("win32", "darwin") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        raise Unavailable("this machine has no desktop to show a dialog on")
    try:
        import tkinter
        from tkinter import filedialog
    except Exception as e:
        raise Unavailable(f"Python has no tkinter here ({e})")
    try:
        root = tkinter.Tk()
    except Exception as e:
        raise Unavailable(f"no dialog can be shown ({e})")
    try:
        root.withdraw()
        root.attributes("-topmost", True)
        types = [(label, " ".join(pattern.split(";"))) for label, pattern in filters]
        return filedialog.askopenfilename(parent=root, title=title, initialdir=start or None, filetypes=types) or ""
    finally:
        try:
            root.destroy()
        except Exception:
            pass


def pick_file(start="", title="Open", filters=(("All files", "*.*"),)):
    start = start if start and os.path.isdir(start) else ""
    if not _lock.acquire(blocking=False):
        raise Busy("an Open dialog is up already")
    try:
        if sys.platform == "win32":
            return _windows(start, title, list(filters))
        return _tk(start, title, list(filters))
    finally:
        _lock.release()
