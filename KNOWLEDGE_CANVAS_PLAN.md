# Knowledge Canvas Plan

Status: approved for implementation  
Task: WMB-1300  
Contract: REQ-015, AC-011, CAP-016, EVAL-015

## 1. Outcome

Turn the existing long-term Library into a working knowledge system: a user can place real WMB objects on a persistent canvas, draw explicit semantic relations, select an exact subset, preview and save it as a static context package, give only that package to Pi for discussion or creation, and later trace which package informed a content project.

The canvas is a working view. It is not the database of truth.

## 2. Product invariants

1. Existing sources, topics, opportunities, projects, publications, reviews and findings remain their existing business records. A canvas node references them; it does not copy or own them.
2. Removing a node removes only its placement. Archiving a business object and archiving a semantic relation are separate explicit actions.
3. Relations have a direction, type and optional label. Pi suggestions are not confirmed knowledge until the user accepts them.
4. A context package contains only explicitly selected objects and the relations whose two endpoints are selected.
5. The first release creates static packages. Their snapshots remain stable when source objects later change.
6. Pi defaults to `selected_only`. The UI previews the exact manifest before sending; WMB never silently adds the full canvas or full Library.
7. UI, IPC, MCP and built-in Pi use the same business functions. Writes use optimistic revisions; MCP mutations use an atomic idempotency receipt.

## 3. Four business concepts

### 3.1 Business objects

The first release can reference `topic`, `source`, `plan_item`, `content_project`, `review`, `method_finding`, plus a canvas-local note. Polymorphic references are validated against a fixed server-side allow-list before every write.

### 3.2 Semantic relations

Relations connect real objects with `supports`, `contradicts`, `derived_from`, `responds_to`, `uses_method`, `becomes_content`, or a user label. Direction is always visible. Relation truth and relation visibility on one canvas are stored separately.

### 3.3 Canvas views

A canvas stores a name, optional topic, viewport and revision. Nodes store reference, position, size and display density. One object may appear on multiple canvases. Canvas reads and layout writes are batched.

### 3.4 Static context packages

A package stores its name, objective, user instruction, selected object snapshots, selected internal relation snapshots, package revision and actual Pi-use manifest. A later content project can link back to the package.

## 4. Primary workflow

1. Enter Knowledge Canvas from Library or a long-term topic.
2. Search existing assets and place them on the current canvas, or create a note.
3. Drag nodes, zoom/pan, click, Shift-select or box-select.
4. Connect two nodes and explicitly choose the relation type.
5. Inspect the selection: object count, type distribution, internal relations and estimated payload.
6. Remove unwanted objects or relations, enter package objective and question, then save a static package.
7. Preview the exact manifest and choose “Discuss with Pi” or “Create from package”.
8. Pi reads the package through the shared business API. Its proposed nodes/relations remain suggestions until accepted.
9. A created content project records the package link; later review can trace back to the package and source objects.

## 5. Interaction contract

- Click selects one node; Shift-click adds or removes; dragging empty space creates a rectangular selection; Escape exits connection mode, then clears selection, then closes the drawer.
- Node dragging persists on pointer release. Current-session undo/redo covers placement and relation edits.
- A connection is created only after a relation type is chosen. Reconnect, relabel, hide on this canvas and archive the real relation are distinct actions.
- Nodes, toolbar actions and the object/relation list have keyboard equivalents. Relation meaning is never conveyed by color alone.
- At 1100 px, selection details and Pi use drawers rather than stacked overlays. The canvas retains a usable center area and the selected set is preserved.
- Leaving with unsaved layout offers save or discard.

## 6. Persistence

Migration 18 adds:

- `knowledge_canvases`
- `knowledge_canvas_nodes`
- `knowledge_relations`
- `knowledge_canvas_relation_views`
- `knowledge_context_packages`
- `knowledge_context_package_items`
- `knowledge_context_package_relations`
- `knowledge_context_uses`
- `content_project_context_packages`

No graph database, object-registry duplicate, vector store or new frontend dependency is introduced.

## 7. Shared commands

Business functions provide:

- list/create/read/update canvas;
- search allowed objects and add/remove/batch-move nodes;
- create/update/archive relations and hide/show them on a canvas;
- create/read static context package and build its bounded manifest;
- record a package use and link it to an existing or newly created content project.

IPC exposes narrow equivalents. MCP exposes read commands plus idempotent mutations. The renderer never submits SQL, arbitrary table names or arbitrary object types.

## 8. Bounded payload

The server builds the manifest, not the renderer. It returns included objects, included internal relations, excluded items, truncation details and an estimated character count. The first release refuses an over-limit package before Pi starts; it does not silently trim.

## 9. Acceptance

EVAL-015 must prove:

1. Create a canvas, add a real source, topic and note, move them and create directed support/contradiction relations; restart restores positions and relations.
2. The same source can appear on two canvases; updating it is visible in both; removing one placement does not delete the source.
3. Hiding a line does not archive the relation; archiving a relation does not erase an existing static package snapshot.
4. Selecting five nodes while a sentinel remains unselected creates a package containing exactly those five objects and only their internal relations.
5. A repeated MCP `request_id` creates one package/use; stale revisions fail without partial writes.
6. Pi's actual manifest contains the previewed IDs and no sentinel or whole-library additions.
7. Package-to-project linkage reads back in both directions and selected source IDs become project sources.
8. A 250-node canvas opens, selects, saves and restores without horizontal page overflow; 1100×700 completes the main workflow with drawers.

## 10. Delivery order

1. Migration and shared business functions.
2. Atomic MCP idempotency boundary and IPC/MCP commands.
3. Persistent canvas, search/add, drag, multi-select, box-select and semantic edges.
4. Static package preview/save and Pi selected-only handoff.
5. Package-to-project traceability and real-data/readback acceptance.

## 11. Deferred by evidence

Dynamic packages, domain-wide AI retrieval, vector search, automatic relation inference, nested groups, freehand lasso, automatic layout, minimap, cross-canvas global graph editing, realtime collaboration and tens-of-thousands-node virtualization are not in WMB-1300.

They are added only after real use demonstrates the corresponding need. A canvas-engine dependency requires a 3,000-node/5,000-edge prototype that materially beats the native implementation; dynamic packages require repeated reuse where snapshot drift is demonstrably harmful.

