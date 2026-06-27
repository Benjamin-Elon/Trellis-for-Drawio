/**
 * Draw.io Plugin: Deep Click-Through Selection
 *
 * Selects and drags the deepest visible child under the pointer instead of
 * letting a selected parent intercept descendant clicks. Locked or otherwise
 * non-movable descendants redirect drag gestures to the nearest movable parent.
 */
Draw.loadPlugin(function (ui) { // CHANGE
    const graph = ui.editor && ui.editor.graph; // CHANGE
    if (!graph || graph.__deepClickThroughInstalled) return; // CHANGE
    graph.__deepClickThroughInstalled = true; // CHANGE

    graph.selectParentAfterCollapse = false; // CHANGE
    graph.cellsSelectable = true; // CHANGE
    graph.keepEdgesInBackground = false; // CHANGE
    graph.cellsLocked = false; // CHANGE

    const baseGetCellAt = graph.getCellAt; // CHANGE

    graph.getCellAt = function (x, y, parent, vertices, edges, ignoreFn) { // CHANGE
        const initial = baseGetCellAt.call(this, x, y, parent, vertices, edges, plantExactHitIgnoreFn(ignoreFn)); // CHANGE
        if (!initial) return null; // CHANGE
        const plantTarget = getPlantClickThroughCellAt(this, x, y, parent, initial); // CHANGE
        if (plantTarget) return plantTarget; // CHANGE
        if (!this.model.isVertex(initial)) return initial; // CHANGE

        const descendants = []; // CHANGE
        const collect = (cell) => { // CHANGE
            const children = this.model.getChildCells(cell); // CHANGE
            if (!children) return; // CHANGE
            for (const child of children) { // CHANGE
                if (this.model.isVertex(child) && this.isCellVisible(child)) descendants.push(child); // CHANGE
                collect(child); // CHANGE
            } // CHANGE
        }; // CHANGE
        collect(initial); // CHANGE

        for (let i = descendants.length - 1; i >= 0; i--) { // CHANGE
            const child = descendants[i]; // CHANGE
            const state = this.view.getState(child); // CHANGE
            if (state && cellStateContainsPoint(this, state, x, y)) return child; // CHANGE
        } // CHANGE
        return initial; // CHANGE
    }; // CHANGE

    mxGraphHandler.prototype.getInitialCellForEvent = function (me) { // CHANGE
        return getDragInitialCellForEvent(this.graph, me, me.getCell(), this); // CHANGE
    }; // CHANGE

    function getDeepestCellForNativeEvent(graph, evt, fallback) { // CHANGE
        if (!graph || !evt) return fallback || null; // CHANGE
        const pt = mxUtils.convertPoint( // CHANGE
            graph.container, // CHANGE
            mxEvent.getClientX(evt), // CHANGE
            mxEvent.getClientY(evt) // CHANGE
        ); // CHANGE
        return graph.getCellAt(pt.x, pt.y) || fallback || null; // CHANGE
    } // CHANGE

    function getSelectionCellForNativeEvent(graph, evt, fallback) { // CHANGE
        const deepest = getDeepestCellForNativeEvent(graph, evt, fallback); // CHANGE
        const plantTarget = getPlantSelectionTargetForEvent(graph, deepest, evt); // CHANGE
        if (plantTarget && (plantTarget !== deepest || isPlantTile(plantTarget))) return plantTarget; // CHANGE
        if (!graph || !deepest || !fallback || deepest === fallback) return plantTarget || deepest; // CHANGE
        const model = graph.getModel(); // CHANGE
        if (model.isVertex(deepest) && model.isVertex(fallback) && isStrictAncestorOf(model, fallback, deepest)) { // CHANGE
            if (!graph.isCellMovable(deepest) && graph.isCellMovable(fallback)) return fallback; // CHANGE
        } // CHANGE
        return plantTarget || deepest; // CHANGE
    } // CHANGE

    function isPlantTile(cell) { // CHANGE
        return !!cell && cell.getAttribute && cell.getAttribute('plant_tiler') === '1'; // CHANGE
    } // CHANGE

    function isTilerGroup(cell) { // CHANGE
        return !!cell && cell.getAttribute && cell.getAttribute('tiler_group') === '1'; // CHANGE
    } // CHANGE

    function isGardenBed(cell) { // CHANGE
        if (!cell || !cell.getAttribute) return false; // CHANGE
        return cell.getAttribute('garden_bed') === '1' || cell.getAttribute('gardenBed') === '1' || cell.getAttribute('is_garden_bed') === '1'; // CHANGE
    } // CHANGE

    function isLodSummary(cell) { // CHANGE
        return !!cell && cell.getAttribute && cell.getAttribute('lod_summary') === '1'; // CHANGE
    } // CHANGE

    function isCollapsedTilerGroup(cell) { // CHANGE
        return isTilerGroup(cell) && cell.getAttribute('lod_collapsed') === '1'; // CHANGE
    } // CHANGE

    function findTilerGroupAncestor(graph, cell) { // CHANGE
        if (!graph || !cell) return null; // CHANGE
        const model = graph.getModel(); // CHANGE
        let cur = cell; // CHANGE
        while (cur) { // CHANGE
            if (isTilerGroup(cur)) return cur; // CHANGE
            cur = model.getParent(cur); // CHANGE
        } // CHANGE
        return null; // CHANGE
    } // CHANGE

    function isPlantGroupSelected(graph, groupCell) { // CHANGE
        return !!graph && !!groupCell && graph.isCellSelected && graph.isCellSelected(groupCell); // CHANGE
    } // CHANGE

    function eventTargetsPlantChildDirectly(graph, evt, groupCell) { // CHANGE
        if (!evt) return isPlantGroupSelected(graph, groupCell); // CHANGE
        return mxEvent.isControlDown(evt) || mxEvent.isMetaDown(evt) || mxEvent.isShiftDown(evt) || isPlantGroupSelected(graph, groupCell); // CHANGE
    } // CHANGE

    function getPlantSelectionTargetForEvent(graph, cell, evt) { // CHANGE
        if (!graph || !cell) return cell || null; // CHANGE
        const group = findTilerGroupAncestor(graph, cell); // CHANGE
        if (!group) return cell; // CHANGE
        if (isPlantTile(cell)) return eventTargetsPlantChildDirectly(graph, evt, group) ? cell : group; // CHANGE
        if (isLodSummary(cell)) return eventTargetsPlantChildDirectly(graph, evt, group) ? cell : group; // CHANGE
        if (isCollapsedTilerGroup(cell) || isTilerGroup(cell)) return group; // CHANGE
        return cell; // CHANGE
    } // CHANGE

    function plantExactHitIgnoreFn(ignoreFn) { // CHANGE
        return function (state, x, y) { // CHANGE
            if (ignoreFn && ignoreFn(state, x, y)) return true; // CHANGE
            return !!state && isPlantTile(state.cell) && !isPointInPlantTileCircleState(state, x, y); // CHANGE
        }; // CHANGE
    } // CHANGE

    function cellStateContainsPoint(graph, state, x, y) { // CHANGE
        if (!state) return false; // CHANGE
        if (isPlantTile(state.cell)) return isPointInPlantTileCircleState(state, x, y); // CHANGE
        return graph && graph.intersects ? graph.intersects(state, x, y) : mxUtils.contains(state, x, y); // CHANGE
    } // CHANGE

    function isPointInPlantTileCircleState(state, x, y) { // CHANGE
        if (!state) return false; // CHANGE
        const rx = Number(state.width) / 2; // CHANGE
        const ry = Number(state.height) / 2; // CHANGE
        if (!isFinite(rx) || !isFinite(ry) || rx <= 0 || ry <= 0) return false; // CHANGE
        const cx = Number(state.x) + rx; // CHANGE
        const cy = Number(state.y) + ry; // CHANGE
        let px = x; // CHANGE
        let py = y; // CHANGE
        const rotation = Number(mxUtils.getValue(state.style, mxConstants.STYLE_ROTATION, 0)) || 0; // CHANGE
        if (rotation) { // CHANGE
            const alpha = mxUtils.toRadians(rotation); // CHANGE
            const point = mxUtils.getRotatedPoint(new mxPoint(x, y), Math.cos(-alpha), Math.sin(-alpha), new mxPoint(cx, cy)); // CHANGE
            px = point.x; // CHANGE
            py = point.y; // CHANGE
        } // CHANGE
        const dx = (px - cx) / rx; // CHANGE
        const dy = (py - cy) / ry; // CHANGE
        return (dx * dx) + (dy * dy) <= 1; // CHANGE
    } // CHANGE

    function getPlantClickThroughCellAt(graph, x, y, parent, initial) { // CHANGE
        if (!graph || !initial) return null; // CHANGE
        const group = findTilerGroupAncestor(graph, initial); // CHANGE
        if (!group) return null; // CHANGE
        if (isLodSummary(initial)) return initial; // CHANGE
        const plantSelectable = findTopmostPlantSelectableAt(graph, x, y, parent); // CHANGE
        if (plantSelectable) return plantSelectable; // CHANGE
        if (isCollapsedTilerGroup(group)) return initial; // CHANGE
        return findTopmostGardenBedAt(graph, x, y, parent) || null; // CHANGE
    } // CHANGE

    function findTopmostPlantSelectableAt(graph, x, y, parent) { // CHANGE
        const model = graph && graph.getModel ? graph.getModel() : null; // CHANGE
        if (!model) return null; // CHANGE
        const root = parent || graph.getCurrentRoot && graph.getCurrentRoot() || model.getRoot(); // CHANGE
        return scanTopmostPlantSelectable(graph, model, root, x, y); // CHANGE
    } // CHANGE

    function scanTopmostPlantSelectable(graph, model, parent, x, y) { // CHANGE
        if (!parent) return null; // CHANGE
        for (let i = model.getChildCount(parent) - 1; i >= 0; i--) { // CHANGE
            const cell = model.getChildAt(parent, i); // CHANGE
            if (!cell || !graph.isCellVisible(cell)) continue; // CHANGE
            const childHit = scanTopmostPlantSelectable(graph, model, cell, x, y); // CHANGE
            if (childHit) return childHit; // CHANGE
            const state = graph.view.getState(cell); // CHANGE
            if (state && isPlantTile(cell) && isPointInPlantTileCircleState(state, x, y)) return cell; // CHANGE
            if (state && isLodSummary(cell) && cellStateContainsPoint(graph, state, x, y)) return cell; // CHANGE
        } // CHANGE
        return null; // CHANGE
    } // CHANGE

    function findTopmostGardenBedAt(graph, x, y, parent) { // CHANGE
        const model = graph && graph.getModel ? graph.getModel() : null; // CHANGE
        if (!model) return null; // CHANGE
        const root = parent || graph.getCurrentRoot && graph.getCurrentRoot() || model.getRoot(); // CHANGE
        return scanTopmostGardenBed(graph, model, root, x, y); // CHANGE
    } // CHANGE

    function scanTopmostGardenBed(graph, model, parent, x, y) { // CHANGE
        if (!parent) return null; // CHANGE
        for (let i = model.getChildCount(parent) - 1; i >= 0; i--) { // CHANGE
            const cell = model.getChildAt(parent, i); // CHANGE
            if (!cell || !graph.isCellVisible(cell)) continue; // CHANGE
            const childHit = scanTopmostGardenBed(graph, model, cell, x, y); // CHANGE
            if (childHit) return childHit; // CHANGE
            if (!isGardenBed(cell)) continue; // CHANGE
            const state = graph.view.getState(cell); // CHANGE
            if (state && cellStateContainsPoint(graph, state, x, y)) return cell; // CHANGE
        } // CHANGE
        return null; // CHANGE
    } // CHANGE

    function isStrictAncestorOf(model, ancestor, cell) { // CHANGE
        if (!model || !ancestor || !cell || ancestor === cell) return false; // CHANGE
        let cur = model.getParent(cell); // CHANGE
        while (cur) { // CHANGE
            if (cur === ancestor) return true; // CHANGE
            cur = model.getParent(cur); // CHANGE
        } // CHANGE
        return false; // CHANGE
    } // CHANGE

    function hasSelectedAncestor(graph, cell) { // CHANGE
        if (!graph || !cell) return false; // CHANGE
        const model = graph.getModel(); // CHANGE
        const selected = graph.getSelectionCells ? graph.getSelectionCells() : []; // CHANGE
        for (const selectedCell of selected || []) { // CHANGE
            if (isStrictAncestorOf(model, selectedCell, cell)) return true; // CHANGE
        } // CHANGE
        return false; // CHANGE
    } // CHANGE

    function getDeepestCellForMouseEvent(graph, me, fallback) { // CHANGE
        if (!graph || !me) return fallback || null; // CHANGE
        const pt = mxUtils.convertPoint(graph.container, me.getX(), me.getY()); // CHANGE
        return graph.getCellAt(pt.x, pt.y) || fallback || null; // CHANGE
    } // CHANGE

    function findMovableDragAncestorForLockedCell(graph, cell) { // CHANGE
        if (!graph || !cell) return null; // CHANGE
        const model = graph.getModel(); // CHANGE
        let cur = model.getParent(cell); // CHANGE
        while (cur) { // CHANGE
            if (model.isVertex(cur) && graph.isCellMovable(cur)) return cur; // CHANGE
            cur = model.getParent(cur); // CHANGE
        } // CHANGE
        return null; // CHANGE
    } // CHANGE

    function getDragInitialCellForEvent(graph, me, fallback, handler) { // CHANGE
        const deepest = getDeepestCellForMouseEvent(graph, me, fallback); // CHANGE
        const dragTarget = getPlantSelectionTargetForEvent(graph, deepest, me && me.getEvent ? me.getEvent() : null); // CHANGE
        if (handler) { // CHANGE
            handler.__manualLinkerLockedDragSource = null; // CHANGE
            handler.__manualLinkerLockedDragParent = null; // CHANGE
        } // CHANGE
        if (!graph || !dragTarget || !graph.getModel().isVertex(dragTarget)) return dragTarget; // CHANGE
        if (graph.isCellMovable(dragTarget)) return dragTarget; // CHANGE

        const movableParent = findMovableDragAncestorForLockedCell(graph, dragTarget); // CHANGE
        if (!movableParent) return dragTarget; // CHANGE
        if (handler) { // CHANGE
            handler.__manualLinkerLockedDragSource = dragTarget; // CHANGE
            handler.__manualLinkerLockedDragParent = movableParent; // CHANGE
        } // CHANGE
        return movableParent; // CHANGE
    } // CHANGE

    const oldIsDelayedSelection = mxGraphHandler.prototype.isDelayedSelection; // CHANGE
    mxGraphHandler.prototype.isDelayedSelection = function (cell, me) { // CHANGE
        const graph = this.graph; // CHANGE
        const deepest = getPlantSelectionTargetForEvent(graph, getDeepestCellForMouseEvent(graph, me, cell), me && me.getEvent ? me.getEvent() : null); // CHANGE

        if (deepest && deepest !== cell && graph.getModel().isVertex(deepest)) { // CHANGE
            if (!graph.isCellSelected(deepest) && hasSelectedAncestor(graph, deepest)) return false; // CHANGE
        } // CHANGE

        if (deepest && graph.getModel().isVertex(deepest)) { // CHANGE
            if (!graph.isCellSelected(deepest) && hasSelectedAncestor(graph, deepest)) return false; // CHANGE
        } // CHANGE

        return oldIsDelayedSelection.apply(this, arguments); // CHANGE
    }; // CHANGE

    const oldGetCellsForDrag = mxGraphHandler.prototype.getCells; // CHANGE
    mxGraphHandler.prototype.getCells = function (initialCell, cells) { // CHANGE
        const graph = this.graph; // CHANGE
        const redirectedParent = this.__manualLinkerLockedDragParent; // CHANGE
        if (redirectedParent && graph.getModel().isVertex(redirectedParent) && graph.isCellMovable(redirectedParent)) { // CHANGE
            const explicitCells = cells || []; // CHANGE
            if (initialCell === redirectedParent || this.cell === redirectedParent || explicitCells.indexOf(redirectedParent) >= 0) { // CHANGE
                return [redirectedParent]; // CHANGE
            } // CHANGE
        } // CHANGE

        if (initialCell && graph.getModel().isVertex(initialCell)) { // CHANGE
            if (!graph.isCellSelected(initialCell) && hasSelectedAncestor(graph, initialCell)) return [initialCell]; // CHANGE
        } // CHANGE

        return oldGetCellsForDrag.apply(this, arguments); // CHANGE
    }; // CHANGE

    graph.selectCellForEvent = function (cell, evt) { // CHANGE
        cell = getSelectionCellForNativeEvent(this, evt, cell); // CHANGE
        if (!cell) return; // CHANGE

        const isCtrl = mxEvent.isControlDown(evt) || mxEvent.isMetaDown(evt); // CHANGE
        const isShift = mxEvent.isShiftDown(evt); // CHANGE

        if (isCtrl && this.__ctrlToggleHandled) { // CHANGE
            this.__ctrlToggleHandled = false; // CHANGE
            return; // CHANGE
        } // CHANGE

        if (isCtrl) { // CHANGE
            if (this.isCellSelected(cell)) this.removeSelectionCell(cell); // CHANGE
            else this.addSelectionCell(cell); // CHANGE
            return; // CHANGE
        } // CHANGE

        if (isShift) { // CHANGE
            this.addSelectionCell(cell); // CHANGE
            return; // CHANGE
        } // CHANGE

        this.setSelectionCell(cell); // CHANGE
    }; // CHANGE

    console.log('[DeepClickThrough] Deep child selection enabled.'); // CHANGE
}); // CHANGE
