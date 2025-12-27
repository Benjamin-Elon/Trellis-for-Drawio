/**
 * Draw.io Plugin: Context Menu Submenus for Copy/Paste, Move, and Edit
 *
 * - Adds three submenus to the cell right-click menu:
 *   - "Copy / Paste": cut, copy, copy as image, copy as SVG, duplicate
 *   - "Move": to front, to back, bring forward, send backward
 *   - "Edit": edit style, edit data, edit link, edit connection points
 * - Hides the original top-level entries for those actions to clean up the menu.
 * - Cleans up leftover separators after hiding items.
 */

Draw.loadPlugin(function (ui) {
    const graph = ui.editor && ui.editor.graph;
    if (!graph) {
        return;
    }

    if (graph.__contextSubmenusInstalled) {
        return;
    }
    graph.__contextSubmenusInstalled = true;

    // -----------------------------
    // 1. Configuration
    // -----------------------------

    const COPY_PASTE_ACTIONS = [
        'cut',
        'copy',
        'copyAsImage',
        'copyAsSvg',
        'duplicate'
    ];

    const MOVE_ACTIONS = [
        'toFront',
        'toBack',
        'bringForward',
        'sendBackward'
    ];

    const EDIT_ACTIONS = [
        'editStyle',
        'editData',
        'editLink',
        'editConnectionPoints' // NEW
    ];

    const COPY_PASTE_LABEL = 'Copy / Paste';
    const MOVE_LABEL = 'Move';
    const EDIT_LABEL = 'Edit';

    // Manual display labels for actions (human-friendly)
    const DISPLAY_LABELS = {
        cut: 'Cut',
        copy: 'Copy',
        copyAsImage: 'Copy As Image',
        copyAsSvg: 'Copy As SVG',
        duplicate: 'Duplicate',

        toFront: 'To Front',
        toBack: 'To Back',
        bringForward: 'Bring Forward',
        sendBackward: 'Send Backward',

        editStyle: 'Edit Style',
        editData: 'Edit Data',
        editLink: 'Edit Link',
        editConnectionPoints: 'Edit Connection Points' // NEW
    };

    // -----------------------------
    // 2. Helpers
    // -----------------------------

    function getDisplayLabelForAction(actionKey) {
        if (Object.prototype.hasOwnProperty.call(DISPLAY_LABELS, actionKey)) {
            return DISPLAY_LABELS[actionKey];
        }
        const action = ui.actions.get(actionKey);
        if (action && action.label) {
            return action.label;
        }
        return actionKey;
    }

    /**
     * Adds a menu item for a named UI action to the given menu/submenu.
     * Uses manual display labels for consistency.
     */
    function addActionMenuItem(menu, parent, actionKey) {
        const action = ui.actions.get(actionKey);
        if (!action) {
            return;
        }

        const label = getDisplayLabelForAction(actionKey);

        menu.addItem(label, null, function () {
            if (typeof action.funct === 'function') {
                action.funct();
            }
        }, parent);
    }

    /**
     * Hides the first menu row whose text matches the given candidates
     * (case-insensitive, exact or simple substring match).
     */
    function hideRowByLabelCandidates(menu, labelCandidates) {
        if (!menu || !menu.div) {
            return;
        }

        const rows = menu.div.getElementsByTagName('tr');
        if (!rows || !rows.length) {
            return;
        }

        const normalizedCandidates = (labelCandidates || [])
            .map(function (s) {
                return (s || '').trim().toLowerCase();
            })
            .filter(function (s) {
                return s.length > 0;
            });

        if (!normalizedCandidates.length) {
            return;
        }

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const text = (row.innerText || row.textContent || '').trim().toLowerCase();
            if (!text) continue;

            const match = normalizedCandidates.some(function (cand) {
                return text === cand || text.indexOf(cand) !== -1;
            });

            if (match) {
                row.style.display = 'none';
                break; // hide first match only
            }
        }
    }

    /**
     * Hides all top-level menu items for the given action keys by trying:
     * - the action's native label
     * - the manual display label
     * - a spaced version of camelCase if applicable
     */
    function hideOriginalActionItems(menu, actionKeys) {
        if (!Array.isArray(actionKeys)) return;

        actionKeys.forEach(function (key) {
            const action = ui.actions.get(key);
            const nativeLabel = action && action.label ? action.label : null;
            const displayLabel = DISPLAY_LABELS[key] || nativeLabel || key;

            const candidates = [];
            if (nativeLabel) candidates.push(nativeLabel);
            if (DISPLAY_LABELS[key]) candidates.push(DISPLAY_LABELS[key]);

            if (
                !DISPLAY_LABELS[key] &&
                nativeLabel &&
                /^[a-z]+([A-Z][a-z0-9]+)+$/.test(nativeLabel)
            ) {
                const spaced = nativeLabel.replace(/([a-z])([A-Z])/g, '$1 $2');
                candidates.push(spaced);
            }

            if (!candidates.length) {
                candidates.push(displayLabel);
            }

            hideRowByLabelCandidates(menu, candidates);
        });
    }

    /**
     * Builds one submenu with items mapped from the given action keys.
     */
    function buildSubmenu(menu, title, actionKeys) {
        if (!actionKeys || !actionKeys.length) {
            return null;
        }

        const parent = menu.addItem(title, null, null);

        actionKeys.forEach(function (key) {
            addActionMenuItem(menu, parent, key);
        });

        return parent;
    }

    /**
     * Removes hidden rows and collapses redundant separators.
     */
    function cleanSeparators(menu) {
        if (!menu || !menu.div) return;

        // Remove rows that are fully hidden (old items we set display:none)
        let rows = Array.from(menu.div.querySelectorAll('tr'));

        rows.forEach(function (row) {
            if (row.style && row.style.display === 'none') {
                if (row.parentNode) row.parentNode.removeChild(row);
            }
        });

        // Recompute rows after removing hidden ones
        rows = Array.from(menu.div.querySelectorAll('tr'));

        function isSeparator(row) {
            if (!row) return false;

            // Separator class on <tr>
            if (row.classList && row.classList.contains('mxPopupMenuSeparator')) return true;

            // Separator class on descendants (<td>, <div>, etc.)
            if (row.querySelector('.mxPopupMenuSeparator')) return true;

            // HR-based separator
            if (row.querySelector('hr')) return true;

            // Treat completely empty spacer rows as separators
            const text = (row.innerText || row.textContent || '')
                .replace(/\u00a0/g, ' ')
                .trim();

            if (!text) {
                const tds = row.getElementsByTagName('td');
                if (tds.length <= 1) return true;
            }

            return false;
        }

        // Remove leading separators
        while (rows.length && isSeparator(rows[0])) {
            rows[0].remove();
            rows.shift();
        }

        // Remove trailing separators
        while (rows.length && isSeparator(rows[rows.length - 1])) {
            rows[rows.length - 1].remove();
            rows.pop();
        }

        // Remove consecutive separators
        for (let i = 1; i < rows.length; i++) {
            if (isSeparator(rows[i]) && isSeparator(rows[i - 1])) {
                rows[i].remove();
                rows.splice(i, 1);
                i--;
            }
        }
    }

    /**
     * Main post-processor to reorganize the popup menu.
     */
    function reorganizeContextMenu(menu, cell, evt) {
        // Only adjust for cell popup
        if (!cell) {
            return;
        }

        // Add submenus
        menu.addSeparator();
        buildSubmenu(menu, COPY_PASTE_LABEL, COPY_PASTE_ACTIONS);
        buildSubmenu(menu, MOVE_LABEL, MOVE_ACTIONS);
        buildSubmenu(menu, EDIT_LABEL, EDIT_ACTIONS);

        // Hide originals
        hideOriginalActionItems(menu, COPY_PASTE_ACTIONS);
        hideOriginalActionItems(menu, MOVE_ACTIONS);
        hideOriginalActionItems(menu, EDIT_ACTIONS);

        // Cleanup separators (and remove hidden rows)
        cleanSeparators(menu);
    }

    // -----------------------------
    // 3. Wrap popup menu factory
    // -----------------------------

    const oldFactory = graph.popupMenuHandler.factoryMethod;

    graph.popupMenuHandler.factoryMethod = function (menu, cell, evt) {
        if (typeof oldFactory === 'function') {
            oldFactory.apply(this, arguments);
        }

        try {
            reorganizeContextMenu(menu, cell, evt);
        } catch (e) {
            if (window && window.console && console.error) {
                console.error('Context submenu plugin error:', e);
            }
        }
    };
});
