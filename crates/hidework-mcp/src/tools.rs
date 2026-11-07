//! The tool catalogue. Every tool except `launch_app` is forwarded to the app under the same name.

use serde_json::{json, Value};

pub const INSTRUCTIONS: &str = "Hidework designs leather goods patterns (wallets, bags, journal covers, belts) and prints \
true-scale templates. Units are millimetres; piece coordinates are local to the piece with y pointing down, and a piece's \
position places it on the sheet. Edge i runs from vertex i to vertex i+1. Start with get_state to see the project, edge \
lengths, stitch hole counts and seam checks. Tools that change the pattern return a screenshot automatically; pass \
screenshot:false to skip it. Fold positions are in design coordinates (before fold allowance). Seams (joins) pair edges \
that sew together and report whether stitch lengths and hole counts match. run_drape simulates how a piece hangs in \
different leathers and thicknesses (1 oz = 1/64 inch = 0.397 mm); simulate, sim_pin, sim_weight, sim_object and sim_props drive the live 3D window to check how the finished item hangs and what it can carry. export writes print PDFs, SVG, laser SVG/DXF, or a \
3D-printable STL stencil.";

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    let mut props = props;
    if let Some(map) = props.as_object_mut() {
        map.insert("screenshot".into(), json!({"type": "boolean", "description": "Return a screenshot after the change (default true for changes)."}));
    }
    json!({
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": props, "required": required},
    })
}

fn point() -> Value {
    json!({"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}, "required": ["x", "y"]})
}

fn edge_ref() -> Value {
    json!({"type": "object", "properties": {
        "pieceId": {"type": "string"},
        "edges": {"type": "array", "items": {"type": "integer"}, "description": "Edge indices (0-based), contiguous"}
    }, "required": ["pieceId", "edges"]})
}

pub fn list() -> Vec<Value> {
    vec![
        tool("launch_app", "Start the Hidework app if it is not running (other tools do this automatically).", json!({}), &[]),
        tool(
            "get_state",
            "The open project summary: pieces with vertices, edges (length, stitch length, hole count), folds, holes, seams with match results, materials with bending length, selection, file path and print page count.",
            json!({"includeProject": {"type": "boolean", "description": "Also return the full project JSON"}}),
            &[],
        ),
        tool(
            "screenshot",
            "Capture the 2D pattern window, the 3D window, or the fabric-test bench as a PNG.",
            json!({"view": {"type": "string", "enum": ["pattern", "3d", "fabric"]}, "fit": {"type": "boolean", "description": "Fit the view first"}}),
            &[],
        ),
        tool("list_templates", "Starter projects available for new_project.", json!({}), &[]),
        tool("new_project", "Start a new project from a template (blank, card-wallet, belt, journal-cover). Discards unsaved changes.", json!({"template": {"type": "string"}}), &["template"]),
        tool("open_project", "Open a .hidework file.", json!({"path": {"type": "string"}}), &["path"]),
        tool("save_project", "Save the project (to its current file, or to path).", json!({"path": {"type": "string"}}), &[]),
        tool("set_project", "Replace the whole project with the given JSON (same shape as get_state includeProject).", json!({"project": {"type": "object"}}), &["project"]),
        tool(
            "add_piece",
            "Add a piece. shape rect or rounded uses width/height/radius; polygon uses vertices (straight edges).",
            json!({
                "shape": {"type": "string", "enum": ["rect", "rounded", "polygon"]},
                "name": {"type": "string"}, "width": {"type": "number"}, "height": {"type": "number"}, "radius": {"type": "number"},
                "vertices": {"type": "array", "items": point()},
                "x": {"type": "number"}, "y": {"type": "number"}, "materialId": {"type": "string"},
                "stitchAll": {"type": "boolean"}
            }),
            &["shape"],
        ),
        tool(
            "update_piece",
            "Change a piece's properties. Stitch settings: stitchMarginMm (edge to stitch line), pitchMm (pricking iron spacing), holeMm.",
            json!({
                "pieceId": {"type": "string"}, "name": {"type": "string"}, "materialId": {"type": "string"}, "cutCount": {"type": "integer"},
                "seamAllowanceMm": {"type": "number"}, "grainDeg": {"type": "number"}, "notes": {"type": "string"},
                "x": {"type": "number"}, "y": {"type": "number"},
                "stitchMarginMm": {"type": "number"}, "pitchMm": {"type": "number"}, "holeMm": {"type": "number"}
            }),
            &["pieceId"],
        ),
        tool("delete_piece", "Remove a piece and its seams.", json!({"pieceId": {"type": "string"}}), &["pieceId"]),
        tool(
            "transform_piece",
            "duplicate, mirror_x (flip left-right), mirror_y (flip top-bottom), rotate_cw or rotate_ccw (90 degrees).",
            json!({"pieceId": {"type": "string"}, "op": {"type": "string", "enum": ["duplicate", "mirror_x", "mirror_y", "rotate_cw", "rotate_ccw"]}}),
            &["pieceId", "op"],
        ),
        tool(
            "edit_vertex",
            "move vertex index to (x, y); insert a vertex on edge index near (x, y); or delete vertex index.",
            json!({"pieceId": {"type": "string"}, "op": {"type": "string", "enum": ["move", "insert", "delete"]}, "index": {"type": "integer"}, "x": {"type": "number"}, "y": {"type": "number"}}),
            &["pieceId", "op", "index"],
        ),
        tool(
            "set_edge",
            "Change one or more edges: stitched, curved (true makes a cubic curve; c1/c2 set its control points), skiveMm (skive zone width, 0 for none).",
            json!({
                "pieceId": {"type": "string"}, "index": {"type": "integer"}, "indices": {"type": "array", "items": {"type": "integer"}},
                "stitched": {"type": "boolean"}, "curved": {"type": "boolean"}, "c1": point(), "c2": point(), "skiveMm": {"type": "number"}
            }),
            &["pieceId"],
        ),
        tool(
            "add_fold",
            "Add a 180-degree fold. orientation horizontal (y = position) or vertical (x = position). contentsMm is what sits inside when closed (cards, layers); the pattern gains pi*(contents+thickness)/2.",
            json!({"pieceId": {"type": "string"}, "orientation": {"type": "string", "enum": ["horizontal", "vertical"]}, "position": {"type": "number"}, "contentsMm": {"type": "number"}}),
            &["pieceId", "orientation", "position"],
        ),
        tool(
            "update_fold",
            "Change a fold's orientation, position or contents.",
            json!({"pieceId": {"type": "string"}, "foldId": {"type": "string"}, "orientation": {"type": "string", "enum": ["horizontal", "vertical"]}, "position": {"type": "number"}, "contentsMm": {"type": "number"}}),
            &["pieceId", "foldId"],
        ),
        tool(
            "add_hole",
            "Punch a hole at (x, y) in design coordinates. lengthMm greater than diameterMm makes an oblong slot at angleDeg.",
            json!({"pieceId": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "diameterMm": {"type": "number"}, "label": {"type": "string"}, "lengthMm": {"type": "number"}, "angleDeg": {"type": "number"}}),
            &["pieceId", "x", "y"],
        ),
        tool(
            "update_hole",
            "Change a punched hole or slot.",
            json!({"pieceId": {"type": "string"}, "holeId": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "diameterMm": {"type": "number"}, "label": {"type": "string"}, "lengthMm": {"type": "number"}, "angleDeg": {"type": "number"}}),
            &["pieceId", "holeId"],
        ),
        tool("add_join", "Declare that edges a and b sew together; the seam check compares their stitch lengths and hole counts.", json!({"a": edge_ref(), "b": edge_ref()}), &["a", "b"]),
        tool(
            "delete_item",
            "Delete a fold, hole, join or material by id.",
            json!({"kind": {"type": "string", "enum": ["fold", "hole", "join", "material"]}, "pieceId": {"type": "string"}, "id": {"type": "string"}}),
            &["kind", "id"],
        ),
        tool(
            "add_strap",
            "Generate a strap or belt along +x: buckle end at x=0, tip at x=length.",
            json!({
                "name": {"type": "string"}, "lengthMm": {"type": "number"}, "widthMm": {"type": "number"},
                "tip": {"type": "string", "enum": ["round", "point", "square"]},
                "holes": {"type": "integer"}, "holeSpacingMm": {"type": "number"}, "firstHoleMm": {"type": "number"}, "holeMm": {"type": "number"},
                "buckleEnd": {"type": "boolean"}, "buckleFoldMm": {"type": "number"}, "tongueSlotMm": {"type": "number"}, "rivetMm": {"type": "number"},
                "stitched": {"type": "boolean"}, "materialId": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}
            }),
            &[],
        ),
        tool(
            "add_gusset",
            "Make a gusset strip as long as the stitch line along the given edges of a piece, and join it to them.",
            json!({"pieceId": {"type": "string"}, "edges": {"type": "array", "items": {"type": "integer"}}, "widthMm": {"type": "number"}}),
            &["pieceId", "edges", "widthMm"],
        ),
        tool("add_lining", "Make a lining or reinforcement piece inset inside a piece's outline.", json!({"pieceId": {"type": "string"}, "insetMm": {"type": "number"}}), &["pieceId"]),
        tool("list_material_presets", "Built-in leather and canvas presets with physics (starting estimates).", json!({}), &[]),
        tool(
            "add_material",
            "Add a material, from a preset id or custom. Thickness by thicknessMm or oz.",
            json!({"preset": {"type": "string"}, "name": {"type": "string"}, "kind": {"type": "string", "enum": ["leather", "waxedCanvas", "other"]}, "thicknessMm": {"type": "number"}, "oz": {"type": "number"}, "costPerSqft": {"type": "number"}}),
            &[],
        ),
        tool(
            "update_material",
            "Change a material: name, kind, thickness, cost, or physics (densityKgM3, bendingModulusMpa, tensileModulusMpa, anisotropy, biasStiffness, friction).",
            json!({
                "materialId": {"type": "string"}, "name": {"type": "string"}, "kind": {"type": "string"}, "thicknessMm": {"type": "number"}, "oz": {"type": "number"}, "costPerSqft": {"type": "number"},
                "densityKgM3": {"type": "number"}, "bendingModulusMpa": {"type": "number"}, "tensileModulusMpa": {"type": "number"},
                "anisotropy": {"type": "number"}, "biasStiffness": {"type": "number"}, "friction": {"type": "number"}
            }),
            &["materialId"],
        ),
        tool(
            "calibrate_material",
            "Set a material's bending stiffness from a cantilever strip test: the overhang (mm) at which a strip's tip droops to a 41.5 degree line.",
            json!({"materialId": {"type": "string"}, "overhangMm": {"type": "number"}}),
            &["materialId", "overhangMm"],
        ),
        tool("bill_of_materials", "Hide area per material (with waste), cost, seam length, thread estimate, stitch holes and hardware.", json!({"wastePct": {"type": "number"}}), &[]),
        tool(
            "run_drape",
            "Fabric test bench (like CLO's Fabric Kit): compare how a piece drapes in one or more materials/thicknesses and show it in 3D. scene: {type: cantilever, side, overhangMm} | {type: pedestal, radiusMm} | {type: hang, side}. Each variant names a materialId or preset, optionally oz or thicknessMm. Returns droop angle, drape coefficient, tip drop and bending length per variant, plus a screenshot.",
            json!({
                "pieceId": {"type": "string"},
                "scene": {"type": "object", "properties": {
                    "type": {"type": "string", "enum": ["cantilever", "pedestal", "hang"]},
                    "side": {"type": "string", "enum": ["left", "right", "top", "bottom"]},
                    "overhangMm": {"type": "number"}, "radiusMm": {"type": "number"}
                }, "required": ["type"]},
                "variants": {"type": "array", "items": {"type": "object", "properties": {
                    "materialId": {"type": "string"}, "preset": {"type": "string"}, "oz": {"type": "number"}, "thicknessMm": {"type": "number"}, "label": {"type": "string"}
                }}},
                "seconds": {"type": "number"}
            }),
            &["pieceId"],
        ),
        tool(
            "export",
            "Write output files. pdf (tiled print, page letter|a4), svg (one true-scale sheet), laser_svg (red cut, blue score, black engrave, kerf-compensated), dxf (layers CUT/HOLES/SCORE/TEXT), stl (3D-printable stencil plate with stitch holes through).",
            json!({
                "format": {"type": "string", "enum": ["pdf", "svg", "laser_svg", "dxf", "stl"]}, "path": {"type": "string"},
                "page": {"type": "string", "enum": ["letter", "a4"]}, "kerfMm": {"type": "number"}, "stitchHoleMm": {"type": "number"},
                "plateMm": {"type": "number"}, "pieces": {"type": "array", "items": {"type": "string"}}
            }),
            &["format", "path"],
        ),
        tool(
            "select",
            "Select something in the app (kind none|piece|edge|vertex|hole|fold|join).",
            json!({"kind": {"type": "string"}, "pieceId": {"type": "string"}, "index": {"type": "integer"}, "id": {"type": "string"}}),
            &["kind"],
        ),
        tool(
            "view",
            "Fit views, zoom the 2D window, set the 3D camera (front, back, top, side, iso), choose which window later screenshots show (pattern or 3d), or close the fabric test.",
            json!({"op": {"type": "string", "enum": ["fit", "zoom_in", "zoom_out", "pattern", "3d", "front", "back", "top", "side", "iso", "close_fabric_test"]}}),
            &["op"],
        ),
        tool(
            "simulate",
            "Run the live 3D simulation (CLO-style) for some seconds: pieces are folded (foldAngleDeg, default 180), sewn along their seams, fastened at coinciding rivet/snap holes, and settle under gravity with any pins, weights, objects and props. Returns load, stitch and pin forces, panel stress, sag and an estimated carrying capacity, plus a 3D screenshot. stressMap true colours the leather by how close it is to its limit.",
            json!({"seconds": {"type": "number"}, "foldAngleDeg": {"type": "number"}, "reset": {"type": "boolean"}, "rebuild": {"type": "boolean"}, "stressMap": {"type": "boolean"}}),
            &[],
        ),
        tool(
            "sim_pin",
            "Pin the leather in 3D at a pattern point (pieceId, x, y in pattern mm) or a world point (world [x,y,z] mm), like holding it by hand or hanging it on a nail.",
            json!({"pieceId": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "world": {"type": "array", "items": {"type": "number"}}, "id": {"type": "string"}}),
            &[],
        ),
        tool(
            "sim_weight",
            "Hang a weight (grams) from the leather at a pattern point or world point.",
            json!({"pieceId": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "world": {"type": "array", "items": {"type": "number"}}, "grams": {"type": "number"}, "id": {"type": "string"}}),
            &["grams"],
        ),
        tool(
            "sim_object",
            "Drop a rigid object onto or into the piece. preset: cards, phone, keys, notebook, tablet, bottle, apple, kilo; or give shape {type: box, size:[x,y,z]} | {type: sphere, radius} | {type: cylinder, radius, height} with grams. world [x,y,z] mm sets where (default: above the middle). Then call simulate.",
            json!({"preset": {"type": "string"}, "shape": {"type": "object"}, "grams": {"type": "number"}, "name": {"type": "string"}, "world": {"type": "array", "items": {"type": "number"}}}),
            &[],
        ),
        tool("sim_remove", "Remove a pin, weight or object from the 3D scene by id.", json!({"id": {"type": "string"}}), &["id"]),
        tool(
            "sim_props",
            "Set the scenery: floor (default), table_edge (half on a table, half over the edge), pedestal (round stand, optional radiusMm), hook_bar (a bar to hang over), or custom (props list, liftMm). Restarts the simulation.",
            json!({"preset": {"type": "string", "enum": ["floor", "table_edge", "pedestal", "hook_bar", "custom"]}, "radiusMm": {"type": "number"}, "props": {"type": "array", "items": {"type": "object"}}, "liftMm": {"type": "number"}}),
            &["preset"],
        ),
        tool("sim_status", "Current simulation readout: metrics, pins, objects, weights and props.", json!({}), &[]),
        tool("history", "Undo or redo.", json!({"op": {"type": "string", "enum": ["undo", "redo"]}, "steps": {"type": "integer"}}), &["op"]),
    ]
}
