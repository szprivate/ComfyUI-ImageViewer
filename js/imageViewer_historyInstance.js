// imageViewer_historyInstance.js
// One History strip view. The panel comes in instances (Sebastian 2026-11-23: panels come in instances): the
// first one is the markup in imageViewer.html and keeps its view state on the viewer (st === viewer, so every
// older caller of this._historyPanelSig / this.historyStrip / this._thumbLoad still reads and writes it); every
// further one is made here with a state object of its own. The dock registers the maker
// (HistoryMixin._historyRegisterMaker) and places the element.
//
// The history DATA is viewer-global and shared (this.history[HISTORY_KEY], one list of renders for every tab):
// every instance shows the same renders, and a click opens one in the main view from any of them. What is an
// instance's own is its VIEW of that list — the signature it was drawn from, its tile and heading caches, its
// thumbnail observer/pump, and where its strip is scrolled to. The collapsed groups, the group order and the
// tag/agent filter stay shared: they are persisted with the viewer state and drive the arrow keys, Ctrl+Shift
// ranges and the Clear button (historyDisplayIndices, clearHistoryFiltered), so they are one setting, not a
// per-panel one. The footer controls (Keep / Clear / the tag filter) live on the first panel only; an instance
// is a strip of its own without them.
import { HISTORY_KEY, snapshotTab, snapshotGroup, historySections, moveGroupInOrder } from "./imageViewer_historyData.js";

// Thumbnails asked for at once. A browser keeps six connections to a server, and a tile whose render sits on a
// network share can take a second or more to come back - six of those and the picture a history switch asks for
// waits for a free connection. Four leaves room for it (and for the viewer's other calls). Each instance caps
// its own strip; the loaded-URL cache is the viewer's, so a tile one strip has loaded paints instantly in another.
const THUMB_LOADS_MAX = 4;
// How far outside the strip's visible part a tile already loads.
const THUMB_NEAR_MARGIN = '300px';

/**
 * Make `parent`'s children `nodes`, in that order, moving as few as it can: the ones that go are taken out, and
 * one that stays is not moved unless the order needs it. (replaceChildren took every tile out and put it back,
 * which ends a drag that starts from one of them.)
 */
function placeChildren(parent, nodes) {
    const keep = new Set(nodes);
    for (const c of [...parent.children]) if (!keep.has(c)) c.remove();
    nodes.forEach((n, i) => { if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] || null); });
}

/** An instance's body, as classes only (it must not repeat the markup's ids): a strip, no footer. */
function buildDom(host) {
    const strip = host.ownerDocument.createElement('div');
    strip.className = 'history-strip';
    host.appendChild(strip);
    return { strip };
}

/** The ui of the markup that is already there (the first panel), by its classes. */
function existingUi(host) {
    return { strip: host.querySelector('.history-strip') };
}

/**
 * Make a History strip view in `host`. `st` holds what this view keeps of its own (the viewer itself for the
 * first one, a fresh object for every further one); `saved` is what a layout carried for it, if anything.
 * Returns the instance the dock keeps: { el, ui, refresh, paintCurrent, paintSelection, wake, save, dispose }.
 */
export function createHistoryInstance(v, host, st, saved) {
    const ui = host.querySelector('.history-strip') ? existingUi(host) : buildDom(host);
    const primary = st === v;
    let wantScroll = saved && Number.isFinite(saved.scroll) ? saved.scroll : null;
    let wantScrollX = saved && Number.isFinite(saved.scrollX) ? saved.scrollX : null;

    // ── Thumbnail loading ────────────────────────────────────────────────────
    //
    // What loading="lazy" did - only tiles at or near the visible part of the strip load - plus a cap on how
    // many are asked for at once (THUMB_LOADS_MAX). The strip itself is the observer's root, so this also works
    // with the viewer popped out into its own window. Each instance has its own observer and pump, rooted on
    // its own strip; the set of URLs already loaded is the viewer's, shared.

    function thumbLoader() {
        const strip = ui.strip;
        const win = (strip && strip.ownerDocument && strip.ownerDocument.defaultView) || null;
        if (!strip || !win || typeof win.IntersectionObserver !== 'function') return null;
        let L = st._thumbLoad;
        if (L && L.strip === strip && L.win === win) return L;
        // First use, or the strip moved to another window: pick up what was waiting.
        const waiting = L ? [...L.watched] : [];
        if (L && L.io) L.io.disconnect();
        L = st._thumbLoad = { strip, win, near: new Set(), watched: new Set(), inflight: new Set(), io: null };
        L.io = new win.IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) L.near.add(e.target);
                else L.near.delete(e.target);
            }
            pump();
        }, { root: strip, rootMargin: THUMB_NEAR_MARGIN });
        for (const img of waiting) { L.watched.add(img); L.io.observe(img); }
        return L;
    }

    // Point a strip tile at its thumbnail - now, or once it is near the visible part of the strip and a load
    // slot is free.
    function loadThumb(imgEl, url) {
        if (!url) return;
        const L = /^(data:|blob:)/.test(url) ? null : thumbLoader();
        if (!L) { imgEl.src = url; return; }
        // Loaded once already (a filter change or any rebuild remakes the tiles): set it now, from the
        // browser's cache, so the tile never shows empty. No request, so the lazy queue and its cap do not apply.
        if (v._thumbLoaded && v._thumbLoaded.has(url)) { imgEl.loading = 'eager'; imgEl.src = url; return; }
        imgEl._imageViewerThumbUrl = url;
        L.watched.add(imgEl);
        L.io.observe(imgEl);
    }

    function pump() {
        const L = st._thumbLoad;
        if (!L) return;
        // A tile dropped by a rebuild no longer holds a slot (nor waits for one).
        for (const img of L.inflight) if (!img.isConnected) L.inflight.delete(img);
        for (const img of L.watched) {
            if (!img.isConnected) { L.near.delete(img); L.watched.delete(img); L.io.unobserve(img); }
        }
        for (const img of L.near) {
            if (L.inflight.size >= THUMB_LOADS_MAX) break;
            L.near.delete(img);
            L.watched.delete(img);
            L.io.unobserve(img);
            const url = img._imageViewerThumbUrl;
            img._imageViewerThumbUrl = null;
            if (!url || !img.isConnected) continue;
            L.inflight.add(img);
            const done = (ev) => {
                if (ev && ev.type === 'load') {
                    const seen = v._thumbLoaded || (v._thumbLoaded = new Set());
                    seen.add(url);
                    if (seen.size > 3000) seen.delete(seen.values().next().value);
                }
                img.removeEventListener('load', done);
                img.removeEventListener('error', done);
                L.inflight.delete(img);
                pump();
            };
            img.addEventListener('load', done);
            img.addEventListener('error', done);
            // It is near the view already: no second, browser-side wait.
            img.loading = 'eager';
            img.src = url;
        }
    }

    // ── Strip wiring ─────────────────────────────────────────────────────────

    function groupDropClear() {
        const strip = ui.strip;
        if (!strip) return;
        strip.classList.remove('group-drop-end');
        for (const el of strip.querySelectorAll('.history-group.group-drop-before, .history-group.dragging')) {
            el.classList.remove('group-drop-before', 'dragging');
        }
    }

    /** Where a heading dragged over the strip would land: before the heading whose middle is below the pointer,
     *  else at the end. */
    function groupDropAt(clientY) {
        const heads = [...ui.strip.children].filter((el) => el.classList && el.classList.contains('history-group'));
        const at = heads.find((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 > clientY; });
        return { el: at || null, before: at ? at.dataset.group : null };
    }

    /**
     * Note a press on a tile (and the drag it may become) so refresh waits for its end. Wired once on the strip;
     * the release is heard on the strip's own document, the pop-out's when popped out. The hold is this view's
     * own: a press in one instance must not freeze another's strip.
     */
    function wirePress() {
        const strip = ui.strip;
        if (!strip || strip._ivPressWatch) return;
        strip._ivPressWatch = true;
        strip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || !(e.target && e.target.closest && e.target.closest('.history-thumb'))) return;
            const doc = strip.ownerDocument;
            let drag = false, timer = null;
            const end = () => {
                doc.removeEventListener('pointerup', up, true);
                doc.removeEventListener('dragstart', start, true);
                doc.removeEventListener('dragend', end, true);
                clearTimeout(timer);
                st._historyHeld = false;
                if (st._historyRenderOwed) { st._historyRenderOwed = false; v.renderHistoryPanel(); }
            };
            // A drag takes the pointer over (pointercancel, no pointerup): its dragend ends it.
            const up = () => { if (!drag) end(); };
            const start = () => { drag = true; };
            doc.addEventListener('pointerup', up, true);
            doc.addEventListener('dragstart', start, true);
            doc.addEventListener('dragend', end, true);
            // Never held for good, whatever the browser leaves out.
            timer = setTimeout(end, 60000);
            st._historyHeld = true;
        }, true);
    }

    function wireGroupDrag() {
        const strip = ui.strip;
        if (!strip || strip._ivGroupDrag) return;
        strip._ivGroupDrag = true;
        strip.addEventListener('dragover', (ev) => {
            const g = v._historyDragGroup;
            if (g == null) return;
            ev.preventDefault();
            try { ev.dataTransfer.dropEffect = 'move'; } catch (_) {}
            const { el, before } = groupDropAt(ev.clientY);
            const stack = v.history[HISTORY_KEY] || [];
            const now = historySections(stack, null, null, v._historyGroupOrder()).map((sec) => sec.group);
            const moves = !!moveGroupInOrder(now, g, before);
            strip.classList.toggle('group-drop-end', moves && !el);
            for (const h of strip.querySelectorAll('.history-group')) h.classList.toggle('group-drop-before', moves && h === el);
        });
        strip.addEventListener('dragleave', (ev) => {
            if (v._historyDragGroup == null) return;
            if (ev.relatedTarget && strip.contains(ev.relatedTarget)) return;
            groupDropClear();
        });
        strip.addEventListener('drop', (ev) => {
            const g = v._historyDragGroup;
            if (g == null) return;
            ev.preventDefault();
            ev.stopPropagation();
            const { before } = groupDropAt(ev.clientY);
            v._historyDragGroup = null;
            groupDropClear();
            v.moveHistoryGroup(g, before);
        });
    }

    // ── Highlights, painted on the tiles already in the strip ────────────────

    // Toggling classes rather than re-rendering: a rebuild drops and re-decodes every thumbnail, which is far
    // too much for a click that changed nothing but which items are highlighted. refresh applies the same
    // classes from state, so a rebuild for other reasons keeps them. A lone selected item is just the open one
    // (it has its own border), so the highlight only shows once there are two or more - except on a borrowed
    // strip, where nothing is open and a click only selects.
    function paintSelection() {
        if (!ui.strip) return;
        const picked = v.historySelectionIndices(v.historyKey());
        const selected = new Set(picked.length > 1 || v.historyBorrows() ? picked : []);
        for (const thumb of ui.strip.children) {
            const idx = Number(thumb.dataset ? thumb.dataset.idx : NaN);
            if (Number.isInteger(idx)) thumb.classList.toggle('multi', selected.has(idx));
        }
    }

    // The open item's highlight, set on the tiles already in the strip - what refresh would draw for it,
    // without making the tiles again.
    function paintCurrent(key) {
        if (!ui.strip) return;
        for (const thumb of ui.strip.children) {
            if (!thumb.classList || !thumb.classList.contains('history-thumb')) continue;
            const idx = Number(thumb.dataset ? thumb.dataset.idx : NaN);
            const isSelected = !v.historyBorrows() && v.currentHistoryKey === key && v.currentHistoryIndex === idx;
            if (thumb.classList.contains('selected') === isSelected) continue;
            thumb.classList.toggle('selected', isSelected);
            thumb.style.border = isSelected ? '2px solid #f60' : '';
        }
        paintSelection();
    }

    /** A group's heading in the strip: its name and count; a click folds it, and thumbnails dropped on it move
     *  into that group. Folding and grouping are the viewer's (shared); the heading is this strip's own. */
    function groupHeading(doc, section, anyGroups) {
        const g = section.group;
        if (!g && !anyGroups) return null;           // no groups at all: no heading
        const h = doc.createElement('div');
        h.className = 'history-group';
        const collapsed = v._historyCollapsedSet().has(g);
        h.classList.toggle('collapsed', collapsed);
        h.dataset.group = g;
        const caret = doc.createElement('span');
        caret.className = 'history-group-caret';
        caret.textContent = collapsed ? '▸' : '▾';
        const name = doc.createElement('span');
        name.className = 'history-group-name';
        name.textContent = g || 'No group';
        const count = doc.createElement('span');
        count.className = 'history-group-count';
        count.textContent = String(section.count);
        h.append(caret, name, count);
        if (g) {
            // Rename it: the pencil, or a right-click on the heading.
            const pen = doc.createElement('span');
            pen.className = 'history-group-rename';
            pen.textContent = '✎';
            pen.title = `Rename the group "${g}"`;
            pen.onclick = (ev) => { ev.stopPropagation(); v._historyGroupRenameField(h, g); };
            h.insertBefore(pen, count);
            h.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); v._historyGroupRenameField(h, g); };
        }
        h.title = `${g ? `Group "${g}"` : 'Not in a group'}: ${section.count} snapshot${section.count === 1 ? '' : 's'}\n`
                + `Click to ${collapsed ? 'show' : 'fold away'}; drop thumbnails here to move them ${g ? 'into this group' : 'out of their group'}`
                + '\nDrag the heading up or down to put the group elsewhere'
                + (g ? '\n✎ or right-click to rename it' : '');
        h.onmousedown = (ev) => ev.stopPropagation();
        h.onclick = (ev) => { ev.stopPropagation(); v.toggleHistoryGroupCollapsed(g); };
        // Dragged up or down the strip, it puts its group elsewhere (wireGroupDrag).
        h.draggable = true;
        h.addEventListener('dragstart', (ev) => {
            if (ev.target !== h) return;
            v._historyDragSnaps = null;
            v._historyDragGroup = g;
            try {
                ev.dataTransfer.setData('application/x-imageviewer-group', g);
                ev.dataTransfer.effectAllowed = 'move';
            } catch (_) {}
            h.classList.add('dragging');
        });
        h.addEventListener('dragend', () => { v._historyDragGroup = null; groupDropClear(); });
        // A thumbnail dragged in the strip (HistoryMixin keeps what it carries).
        h.addEventListener('dragover', (ev) => {
            if (!v._historyDragSnaps) return;
            ev.preventDefault();
            try { ev.dataTransfer.dropEffect = 'move'; } catch (_) {}
            h.classList.add('drop');
        });
        h.addEventListener('dragleave', () => h.classList.remove('drop'));
        h.addEventListener('drop', (ev) => {
            h.classList.remove('drop');
            const snaps = v._historyDragSnaps;
            if (!snaps) return;
            ev.preventDefault();
            ev.stopPropagation();
            v._historyDragSnaps = null;
            v.setHistoryGroupOf(snaps, g);
        });
        return h;
    }

    // ── The render ───────────────────────────────────────────────────────────

    function refresh() {
        if (!ui.strip) return;
        const doc = ui.strip.ownerDocument;
        // A tile pressed or dragged must stay in the page: Chrome starts no drag (and a running one ends) when
        // its source leaves the document, which a render in between - the missing-file check, a new output -
        // did. The render is made when the press or the drag is over (wirePress).
        wirePress();
        if (st._historyHeld) { st._historyRenderOwed = true; return; }
        // On a cut's tab a click only selects (historyBorrows).
        const borrowed = v.historyBorrows();
        const key   = HISTORY_KEY;
        const stack = v.history[key] || [];

        // The open tile: the snapshot looked at, or the tab's own newest.
        const open = v._historyOpenIndex();
        if (!borrowed) {
            v.currentHistoryKey   = open == null ? null : key;
            v.currentHistoryIndex = open;
        }

        // --- fast-path: skip full DOM rebuild if nothing changed ---
        const collapsed = v._historyCollapsedSet();
        const layoutSig = JSON.stringify({ key, borrowed, len: stack.length, cmp: v.historyCompare,
                                           groups: stack.map((s) => snapshotGroup(s)).join('\u0001'),
                                           collapsed: [...collapsed].sort(),
                                           order: v._historyGroupOrder(),
                                           tags: v.historyTagSig ? v.historyTagSig(stack) : "" });
        const newSig = `${layoutSig}|${v.currentHistoryIndex}`;
        if (newSig === st._historyPanelSig) return;
        // Only the open item moved (a click in the strip, the arrow keys): move its highlight instead of
        // rebuilding the strip. A rebuild makes every tile anew, and every new tile asks for its thumbnail
        // again - on a history switch, that was a strip's worth of requests and decodes queued in front of the
        // picture the switch was waiting for. A caller that wants a real rebuild clears _historyPanelSig.
        if (st._historyPanelSig && st._historyPanelLayoutSig === layoutSig) {
            st._historyPanelSig = newSig;
            paintCurrent(key);
            return;
        }
        st._historyPanelSig = newSig;
        st._historyPanelLayoutSig = layoutSig;

        // The tag filter in the footer (HistoryTagsMixin) - the first panel's footer, the shared filter.
        if (primary && v._syncHistoryTagFilter) v._syncHistoryTagFilter();

        // One section per group, the group used last first (imageViewer_historyData.js).
        const visible = v.historyTagVisible ? (s) => v.historyTagVisible(s) : null;
        // Once the user has ordered the groups, a group new to the order is pinned where it first shows (on
        // top), so new renders never shuffle the headings.
        const order = v._historyGroupOrder();
        if (order.length) {
            const fresh = historySections(stack, null, null, order).map((sec) => sec.group).filter((g) => !order.includes(g));
            if (fresh.length) { v.historyGroupOrder = [...fresh, ...order]; v.queuePersistViewerState?.(); }
        }
        const sections = historySections(stack, visible, collapsed, v._historyGroupOrder());
        wireGroupDrag();
        const anyGroups = sections.some((sec) => sec.group);

        // A tile is made ONCE per snapshot and kept (_historyTiles, by the snapshot itself) for as long as what
        // it shows stays the same: every new render used to remake the whole strip - twice, switchTab and then
        // showInViewerTab - and each new tile set its <img> again, so a strip of N tiles was N elements, N
        // listeners and N decodes per render. Only what depends on the tile's place (its index, its highlight)
        // is painted on every pass (paintThumb); the handlers read the index off the tile. The cache is this
        // view's own: a tile element can only sit in one strip.
        const tiles = (st._historyTiles instanceof WeakMap) ? st._historyTiles : (st._historyTiles = new WeakMap());
        const used = new Set();
        const tileSig = (snapshot, imgObj, url) => {
            const from = snapshotTab(snapshot);
            let agent = '';
            try { agent = v.historyAgentTagSig ? v.historyAgentTagSig(snapshot) : ''; } catch (e) { /* ignore */ }
            return [borrowed ? 1 : 0, url || '', snapshotGroup(snapshot), (imgObj && imgObj.label) || '',
                    (v.historyTagOf && v.historyTagOf(snapshot)) || '', from ? v._historyTabLabel(from) : '', agent].join('\u0002');
        };
        const buildThumb = (snapshot, imgObj, url) => {
            const thumb     = doc.createElement('div');
            thumb.className = 'history-thumb';
            const at = () => Number(thumb.dataset.idx);

            const imgEl = doc.createElement('img');
            if (imgObj) {
                // An image snapshot has no separate poster, so this <img> points at the full-resolution render
                // — and a decoded bitmap stays resident for as long as the element is attached. Lazy means only
                // the thumbnails actually scrolled into view pay for a decode; the rest cost nothing until you
                // look at them.
                imgEl.loading  = 'lazy';
                imgEl.decoding = 'async';
                // A thumbnail is only a hint that something is wrong — a video's poster is a separate temp
                // file, so it can be gone while the clip itself is fine. The prune pass checks the real media
                // before anything is removed. A failed tile is not kept: the next pass makes it again, so a
                // file that arrived late still shows. A poster kept in ComfyUI's temp folder is gone after a
                // restart (ComfyUI empties temp when it starts): the tile is then made from the media itself,
                // once, before it counts as failed.
                const fallback = imgObj.thumb && v.thumbUrl ? v.thumbUrl({ ...imgObj, thumb: null }) : null;
                imgEl.onerror = () => {
                    if (fallback && fallback !== url && !imgEl._imageViewerFellBack) {
                        imgEl._imageViewerFellBack = true;
                        imgEl.src = fallback;
                        return;
                    }
                    thumb._imageViewerFailed = true; v.noteMediaLoadFailed(imgObj);
                };
                try { loadThumb(imgEl, url); } catch (e) { /* ignore */ }
            }
            thumb.appendChild(imgEl);
            const tagDot = v.historyTagDot ? v.historyTagDot(snapshot) : null;
            if (tagDot) thumb.appendChild(tagDot);
            const caption = v.historyThumbCaption ? v.historyThumbCaption(doc, snapshot) : null;
            if (caption) thumb.appendChild(caption);
            const agentTag = v.historyAgentTagBadge ? v.historyAgentTagBadge(doc, snapshot) : null;
            if (agentTag) thumb.appendChild(agentTag);
            // Drag source: drop onto the ComfyUI graph to make a loader node. The whole snapshot is passed so
            // multi-image sequences map to a sequence loader (see _makeHistoryThumbDraggable /
            // _sequenceDirForSnapshot); key and index let a drag pick up the whole selection at once.
            if (imgObj && v._makeHistoryThumbDraggable) {
                v._makeHistoryThumbDraggable(thumb, imgObj, snapshot, key, at);
            }
            // ...and onto a group's heading, to move it (and the selection it is in).
            thumb.addEventListener('dragstart', () => {
                v._historyDragSnaps = v.isHistoryItemSelected(key, at())
                    ? v.selectedHistorySnapshots(key).map((p) => p.snapshot) : [snapshot];
            });
            thumb.addEventListener('dragend', () => { v._historyDragSnaps = null; });

            // Don't preventDefault here — that would block the native drag start used to drop thumbnails onto
            // the graph. stopPropagation still keeps the mousedown from reaching any parent panel handler.
            thumb.onmousedown  = ev => ev.stopPropagation();
            thumb.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); v.showThumbContextMenu(ev, imgObj, key, at()); };
            // On a cut's tab a click selects and the cut stays on screen; a double-click opens the snapshot in
            // its tab.
            if (borrowed) {
                thumb.onclick = (ev) => {
                    ev.stopPropagation();
                    const idx = at();
                    if (ev.shiftKey) v.extendHistorySelection(key, idx);
                    else if (ev.ctrlKey || ev.metaKey) v.toggleHistorySelection(key, idx);
                    else {
                        v.startHistorySelection(key, idx);
                        // A plain click loads it into the Source viewer, as Resolve's media pool does; the cut
                        // stays on screen.
                        if (ev.detail <= 1) v._historyToSource(idx);
                    }
                };
                thumb.ondblclick = (ev) => {
                    ev.stopPropagation();
                    const idx = at();
                    if (v.historyCompare) v.exitHistoryCompare();
                    v.openHistorySnapshot(key, idx);
                    v.startHistorySelection(key, idx);
                };
                return thumb;
            }
            thumb.onclick = (ev) => {
                ev.stopPropagation();
                const idx = at();

                // Ctrl/Cmd owns multi-selection so that plain Shift stays with compare. Neither changes what
                // the viewport is showing.
                if (ev.ctrlKey || ev.metaKey) {
                    if (ev.shiftKey) v.extendHistorySelection(key, idx);
                    else             v.toggleHistorySelection(key, idx);
                    return;
                }

                // Any other click is about the view, but the item it opens is also where a selection starts:
                // Ctrl+click then adds to it.
                v.startHistorySelection(key, idx);

                if (ev.shiftKey && Number.isInteger(v.currentHistoryIndex) && v.currentHistoryKey === key) {
                    if (!v.historyCompare) {
                        v.historyCompare = { key, baseIdx: v.currentHistoryIndex, otherIdx: idx };
                        v.enterHistoryCompare();
                    } else if (v.historyCompare.key === key && (idx === v.historyCompare.baseIdx || idx === v.historyCompare.otherIdx)) {
                        v.exitHistoryCompare();
                    } else {
                        v.historyCompare.otherIdx = idx;
                        v.enterHistoryCompare();
                    }
                    return;
                }

                // Unpin first so toggleCompare acts on tab state rather than on the snapshot compare we are
                // leaving (exitHistoryCompare already turns compare off when it wasn't on beforehand).
                if (v.historyCompare) v.exitHistoryCompare();
                if (v.isComparing) v.toggleCompare();

                if (v.isViewingHistory && v.currentHistoryKey === key && v.currentHistoryIndex === idx) {
                    v.restoreHistoryView();
                } else {
                    v.historyCompare      = null;
                    v.openHistorySnapshot(key, idx);
                }
            };
            return thumb;
        };
        // What depends on where the tile is: its index, its title, its highlights.
        const multiOn = borrowed || v.historySelectionIndices(key).length > 1;
        const paintThumb = (thumb, snapshot, imgObj, idx) => {
            thumb.dataset.idx = String(idx);
            const what = imgObj && imgObj.label ? ` - ${imgObj.label}` : '';
            const from = snapshotTab(snapshot);
            const fromWords = from ? `, from ${v._historyTabLabel(from)}` : '';
            const groupWords = snapshotGroup(snapshot) ? ` (group ${snapshotGroup(snapshot)})` : '';
            thumb.title = borrowed
                ? `History ${idx + 1}${what}${fromWords}${groupWords}\n` +
                  `Drag onto the timeline to add it to the cut\n` +
                  `Click to load it into the Source viewer, Ctrl+click to add to the selection, Shift+click for a range\n` +
                  `Double-click to open it in its tab\n` +
                  `Right-click to tag it or move it to another group`
                : `History ${idx + 1}${what}${fromWords}${groupWords}\n` +
                          `Click to show it (in its tab), then Ctrl+click to add to the selection, Ctrl+Shift+click for a range\n` +
                          `Shift+click to compare against the open snapshot\n` +
                          `C with several Ctrl-selected: compare them (3+: a Contact Sheet of all)\n` +
                          `Drag onto a group's heading to move it there; right-click to tag it or pick a group`;
            const isSelected = !borrowed && (v.currentHistoryKey === key && v.currentHistoryIndex === idx);
            thumb.classList.toggle('selected', isSelected);
            thumb.style.border = isSelected ? '2px solid #f60' : '';
            const cmp = v.historyCompare && v.historyCompare.key === key ? v.historyCompare : null;
            thumb.classList.toggle('base', !!cmp && idx === cmp.baseIdx);
            thumb.classList.toggle('compare', !!cmp && idx === cmp.otherIdx);
            thumb.classList.toggle('multi', multiOn && v.isHistoryItemSelected(key, idx));
        };
        const makeThumb = (snapshot, idx) => {
            const imgObj = (snapshot && snapshot.length > 0) ? snapshot[0] : null;
            let url = null;
            if (imgObj) { try { url = v.thumbUrl(imgObj); } catch (e) { /* ignore */ } }
            const sig = tileSig(snapshot, imgObj, url);
            const kept = snapshot && typeof snapshot === 'object' ? tiles.get(snapshot) : null;
            let thumb = kept && kept.sig === sig && !kept.el._imageViewerFailed && !used.has(kept.el) ? kept.el : null;
            if (!thumb) {
                thumb = buildThumb(snapshot, imgObj, url);
                if (snapshot && typeof snapshot === 'object' && !(kept && used.has(kept.el))) tiles.set(snapshot, { el: thumb, sig });
            }
            used.add(thumb);
            paintThumb(thumb, snapshot, imgObj, idx);
            return thumb;
        };

        // Headings are kept the same way, by what they show.
        const headsBefore = st._historyHeadings instanceof Map ? st._historyHeadings : new Map();
        const headsNow = new Map();
        const nodes = [];
        for (const sec of sections) {
            const hk = `${anyGroups ? 1 : 0}\u0002${sec.group}\u0002${sec.count}\u0002${collapsed.has(sec.group) ? 1 : 0}`;
            let heading = headsBefore.get(hk);
            // One with its rename field open is made again: leaving the field redraws to get the name back.
            if (heading === undefined || headsNow.has(hk) || (heading && heading.querySelector('input'))) {
                heading = groupHeading(doc, sec, anyGroups);
            }
            headsNow.set(hk, heading);
            if (heading) {
                heading.classList.remove('drop');
                nodes.push(heading);
            }
            for (const idx of sec.indices) nodes.push(makeThumb(stack[idx], idx));
        }
        st._historyHeadings = headsNow;

        if (stack.length && !nodes.length) {
            const none = doc.createElement('div');
            none.className = 'history-tag-empty';
            none.textContent = 'Nothing tagged like that here';
            nodes.push(none);
        } else if (borrowed && !stack.length) {
            const none = doc.createElement('div');
            none.className = 'history-tag-empty';
            none.textContent = 'No history yet. Renders show here, to drag onto the cut.';
            nodes.push(none);
        }
        // Replace strip contents in one operation - and not at all when the tiles are already there in that
        // order (a forced redraw that changed nothing), so the strip is not laid out again for nothing.
        const cur = ui.strip.children;
        const same = cur.length === nodes.length && nodes.every((n, i) => cur[i] === n);
        if (!same) placeChildren(ui.strip, nodes);

        // A layout's saved scroll, applied once after the first draw (the strip has its content by then).
        if (wantScroll != null) {
            ui.strip.scrollTop = wantScroll;
            if (wantScrollX != null) ui.strip.scrollLeft = wantScrollX;
            wantScroll = null; wantScrollX = null;
        }

        // Only reached when the signature changed, so this rides on real rebuilds — a restore from
        // localStorage, a new output, a tab switch — rather than on every call. Paths already verified are
        // skipped, so a settled session sends nothing.
        v.scheduleHistoryPrune();

        if (primary && v.historyClearBtn) v.historyClearBtn.disabled = stack.length === 0;
        // With a tag filter on, Clear clears what it shows (HistoryTagsMixin).
        if (primary && v._syncHistoryClearTitle) v._syncHistoryClearTitle();
    }

    // The first panel's empty-area click is bound by _initHistoryPanel (imageViewer.js); an instance binds its
    // own, the same gesture: leave compare, or jump to the newest visible snapshot.
    if (!primary) {
        host.addEventListener('click', (e) => {
            if (v.historyCompare) { v.exitHistoryCompare(); return; }
            if (v.isComparing)    { v.toggleCompare(); return; }
            if (!v.isViewingHistory) return;
            if (e.target && e.target.closest &&
                (e.target.closest('.history-thumb') || e.target.closest('.history-path') || e.target.closest('.history-thumb-wrapper'))) return;
            v.jumpToLatestVisibleHistory();
        });
    }

    return {
        el: host,
        ui,
        refresh,
        paintCurrent,
        paintSelection,
        /** The panel came into view: draw it afresh (the dock's wake, as _onPanelShown does for the first). */
        wake() { st._historyPanelSig = null; refresh(); },
        save() {
            return { scroll: ui.strip ? ui.strip.scrollTop : 0, scrollX: ui.strip ? ui.strip.scrollLeft : 0 };
        },
        dispose() {
            const L = st._thumbLoad;
            if (L) {
                try { if (L.io) L.io.disconnect(); } catch (_) { /* gone */ }
                L.near.clear(); L.watched.clear(); L.inflight.clear();
                st._thumbLoad = null;
            }
            st._historyHeld = false;
            st._historyRenderOwed = false;
        },
    };
}