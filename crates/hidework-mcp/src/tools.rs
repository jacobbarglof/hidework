//! The tool catalogue. Every tool except `launch_app` is forwarded to the app under the same name.

use serde_json::{json, Value};

pub const INSTRUCTIONS: &str = "Hidework designs leather goods patterns (wallets, bags, journal covers, belts) and prints \
true-scale templates. Units are millimetres; piece coordinates are local to the piece with y pointing down, and a piece's \
position places it on the sheet. Edge i runs from vertex i to vertex i+1. Start with get_state to see the project, edge \
lengths, stitch hole counts and seam checks. Tools that change the pattern return a screenshot automatically; pass \
screenshot:false to skip it. Fold positions are in design coordinates (before fold allowance). Seams (joins) pair edges \
that sew together and report whether stitch lengths and hole counts match. run_drape simulates how a piece hangs in \
different leathers and thicknesses (1 oz = 1/64 inch = 0.397 mm); simulate, sim_pin, sim_weight, sim_object and sim_props drive the live 3D window to check how the finished item hangs and what it can carry. export writes print PDFs, SVG, laser SVG/DXF, or a \
3D-printable STL stencil. list_catalogue gives the stitch types (saddle, lockstitch, running, back, cross, \
baseball, whip, blanket and four lacings), threads and laces, seam constructions (edge to edge, turned, lapped, butt, welted, \
piped, bound, zipper), glues, edge finishes and hardware ids. make_bag builds a complete arranged bag (tote, boxedTote, \
messenger, bucket, zipPouch). arrange_piece places a piece on the bag form in 3D (front, back, left, right, bottom, top, \
wrapSides for a gusset, wrapAround, backFlap, handleFront, handleBack, strapSides). add_hardware with throughPieceId sets \
matching fasteners through two layers so they hold in 3D.";

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
        tool("new_project", "Start a new project from a template id (list_templates gives all 51, e.g. blank, card-wallet, bifold, belt, journal-cover, tote, messenger). Discards unsaved changes.", json!({"template": {"type": "string"}}), &["template"]),
        tool("open_project", "Open a .hidework file.", json!({"path": {"type": "string"}}), &["path"]),
        tool("save_project", "Save the project (to its current file, or to path).", json!({"path": {"type": "string"}}), &[]),
        tool("set_project", "Replace the whole project with the given JSON (same shape as get_state includeProject).", json!({"project": {"type": "object"}}), &["project"]),
        tool(
            "add_piece",
            "Add a piece. shape rect or rounded uses width/height/radius; oval uses width/height; circle uses width (across); slot (both ends round) and strap_end (end round or point, the far end) use width/height; polygon uses vertices (straight edges); mirror_half uses vertices for one half, starting and ending on the vertical centre line through the first vertex, and mirrors it so both sides match. x/y is the top-left corner (for mirror_half, an offset added to the vertices).",
            json!({
                "shape": {"type": "string", "enum": ["rect", "rounded", "oval", "circle", "slot", "strap_end", "polygon", "mirror_half"]},
                "end": {"type": "string", "enum": ["round", "point"]},
                "name": {"type": "string"}, "width": {"type": "number"}, "height": {"type": "number"}, "radius": {"type": "number"},
                "vertices": {"type": "array", "items": point()},
                "x": {"type": "number"}, "y": {"type": "number"}, "materialId": {"type": "string"},
                "stitchAll": {"type": "boolean"}
            }),
            &["shape"],
        ),
        tool(
            "update_piece",
            "Change a piece's properties. Stitch settings: stitchKind (see list_catalogue), stitchMarginMm (edge to stitch line), pitchMm (pricking iron or lacing chisel spacing), holeMm (hole size, or slit length = lace width for lacing), rows (1-4) and rowGapMm.",
            json!({
                "pieceId": {"type": "string"}, "name": {"type": "string"}, "materialId": {"type": "string"}, "cutCount": {"type": "integer"},
                "seamAllowanceMm": {"type": "number"}, "grainDeg": {"type": "number"}, "notes": {"type": "string"},
                "x": {"type": "number"}, "y": {"type": "number"},
                "stitchMarginMm": {"type": "number"}, "pitchMm": {"type": "number"}, "holeMm": {"type": "number"},
                "stitchKind": {"type": "string", "enum": ["saddle", "lockstitch", "running", "backstitch", "cross", "baseball", "whip", "blanket", "laceWhip", "laceSingleLoop", "laceDoubleLoop", "laceCross"]},
                "rows": {"type": "integer"}, "rowGapMm": {"type": "number"}
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
            "Change one or more edges: stitched, curved (true makes a cubic curve; c1/c2 set its control points), skiveMm (skive zone width, 0 for none), finish (raw, burnished, painted, turned = folded edge with a turn allowance turnMm, bound), crease (decorative crease line).",
            json!({
                "pieceId": {"type": "string"}, "index": {"type": "integer"}, "indices": {"type": "array", "items": {"type": "integer"}},
                "stitched": {"type": "boolean"}, "curved": {"type": "boolean"}, "c1": point(), "c2": point(), "skiveMm": {"type": "number"},
                "finish": {"type": "string", "enum": ["raw", "burnished", "painted", "turned", "bound"]}, "turnMm": {"type": "number"}, "crease": {"type": "boolean"}
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
        tool(
            "add_join",
            "Declare that edges a and b join; the seam check compares their stitch lengths and hole counts. Give b.edges [] to sew a onto the face of piece b (patch pocket, tab). construction: edgeToEdge, turned, lapped, butt, welted, piped, bound, zipper. glue: none, contactCement, waterContact, pva, tape. Welts, piping and binding can use insertMaterialId and insertMm.",
            json!({"a": edge_ref(), "b": edge_ref(), "construction": {"type": "string"}, "glue": {"type": "string"}, "glueWidthMm": {"type": "number"}, "insertMaterialId": {"type": "string"}, "insertMm": {"type": "number"}}),
            &["a", "b"],
        ),
        tool(
            "update_join",
            "Change a seam's construction, glue, glue band width, or welt/piping/binding insert.",
            json!({"joinId": {"type": "string"}, "construction": {"type": "string"}, "glue": {"type": "string"}, "glueWidthMm": {"type": "number"}, "insertMaterialId": {"type": "string"}, "insertMm": {"type": "number"}}),
            &["joinId"],
        ),
        tool("list_catalogue", "Stitch types, threads and laces, seam constructions, glues, edge finishes and hardware (ids, sizes, weights, strengths).", json!({}), &[]),
        tool(
            "add_hardware",
            "Set hardware into a piece at (x, y) design coordinates: rivets, Chicago screws, snaps, magnetic snaps, turn locks, grommets, feet, rings, buckles, swivel clasps, zippers, plaques, conchos (kind from list_catalogue). It adds the holes, slits or window it needs, its weight, and a 3D model. throughPieceId puts the matching half on another arranged piece at the same 3D point so they fasten in the simulation.",
            json!({"pieceId": {"type": "string"}, "kind": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "angleDeg": {"type": "number"}, "sizeMm": {"type": "number"}, "label": {"type": "string"}, "throughPieceId": {"type": "string"}}),
            &["pieceId", "kind", "x", "y"],
        ),
        tool(
            "update_hardware",
            "Move or change set hardware.",
            json!({"pieceId": {"type": "string"}, "hardwareId": {"type": "string"}, "kind": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "angleDeg": {"type": "number"}, "sizeMm": {"type": "number"}, "label": {"type": "string"}}),
            &["pieceId", "hardwareId"],
        ),
        tool(
            "add_mark",
            "Add surface work centred at (x, y): stamp (maker's mark, text), tooling (pattern floral|geometric|basketweave|border|pebble), emboss, engrave, paint (pattern = CSS colour), text, perforate (pattern 'spacing/diameter' mm, e.g. 6/2, adds the holes).",
            json!({"pieceId": {"type": "string"}, "kind": {"type": "string", "enum": ["stamp", "tooling", "emboss", "engrave", "paint", "text", "perforate"]}, "x": {"type": "number"}, "y": {"type": "number"}, "width": {"type": "number"}, "height": {"type": "number"}, "angleDeg": {"type": "number"}, "text": {"type": "string"}, "pattern": {"type": "string"}}),
            &["pieceId", "kind", "x", "y"],
        ),
        tool(
            "update_mark",
            "Move, resize or change surface work.",
            json!({"pieceId": {"type": "string"}, "markId": {"type": "string"}, "kind": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "width": {"type": "number"}, "height": {"type": "number"}, "angleDeg": {"type": "number"}, "text": {"type": "string"}, "pattern": {"type": "string"}}),
            &["pieceId", "markId"],
        ),
        tool(
            "make_bag",
            "Build a complete bag, replacing the project: every piece with matching seams, rivets through both layers, closure, pocket and feet, arranged in 3D. style tote|boxedTote|messenger|bucket|zipPouch; any other field overrides the style's defaults: widthMm, heightMm, depthMm, cornerMm, leather (preset id), thicknessMm, construction, glue, stitch, carry (none|handles|shoulder|both), handleLengthMm, handleWidthMm, strapLengthMm, strapWidthMm, closure (none|magnetic|turnLock|snap), flapMm, pocket, feet, edge (raw|burnished|painted|turned), threadColor.",
            json!({"style": {"type": "string", "enum": ["tote", "boxedTote", "messenger", "bucket", "zipPouch"]}, "name": {"type": "string"},
                "widthMm": {"type": "number"}, "heightMm": {"type": "number"}, "depthMm": {"type": "number"}, "cornerMm": {"type": "number"},
                "leather": {"type": "string"}, "thicknessMm": {"type": "number"}, "construction": {"type": "string"}, "glue": {"type": "string"}, "stitch": {"type": "string"},
                "carry": {"type": "string"}, "handleLengthMm": {"type": "number"}, "handleWidthMm": {"type": "number"}, "strapLengthMm": {"type": "number"}, "strapWidthMm": {"type": "number"},
                "closure": {"type": "string"}, "flapMm": {"type": "number"}, "pocket": {"type": "boolean"}, "feet": {"type": "boolean"}, "edge": {"type": "string"}, "threadColor": {"type": "string"}}),
            &["style"],
        ),
        tool(
            "arrange_piece",
            "Place a piece in 3D on the bag form (like CLO arrangement points): face flat|front|back|left|right|bottom|top|wrapSides|wrapAround|backFlap|handleFront|handleBack|strapSides; offsetX/offsetY shift it (y down); layerMm moves it out from the form (negative inside, for linings); spanMm and tabMm shape handles and straps.",
            json!({"pieceId": {"type": "string"}, "face": {"type": "string"}, "offsetX": {"type": "number"}, "offsetY": {"type": "number"}, "layerMm": {"type": "number"}, "spanMm": {"type": "number"}, "tabMm": {"type": "number"}}),
            &["pieceId", "face"],
        ),
        tool(
            "set_form",
            "Size of the bag form pieces are arranged on: the finished bag along its stitch lines (widthMm, depthMm, heightMm), cornerMm for rounded bottom corners, round for an oval plan.",
            json!({"widthMm": {"type": "number"}, "depthMm": {"type": "number"}, "heightMm": {"type": "number"}, "cornerMm": {"type": "number"}, "round": {"type": "boolean"}}),
            &[],
        ),
        tool(
            "set_thread",
            "Choose the thread or lace (id from list_catalogue), its colour (CSS), and the 3D hardware finish (brass, nickel, gunmetal, copper, black).",
            json!({"thread": {"type": "string"}, "color": {"type": "string"}, "hardwareFinish": {"type": "string", "enum": ["brass", "nickel", "gunmetal", "copper", "black"]}}),
            &[],
        ),
        tool(
            "add_laminate",
            "Glue two pieces face to face (lining, stiffener, doubled strap). Arrange both on the same face so they meet in 3D.",
            json!({"a": {"type": "string"}, "b": {"type": "string"}, "glue": {"type": "string"}}),
            &["a", "b"],
        ),
        tool(
            "round_corner",
            "Round a straight corner (vertex index) to radiusMm, like a corner punch. Seams on later edges are renumbered.",
            json!({"pieceId": {"type": "string"}, "vertex": {"type": "integer"}, "radiusMm": {"type": "number"}}),
            &["pieceId", "vertex"],
        ),
        tool(
            "add_dart",
            "Cut a V dart into a straight edge at fraction 'at' along it (widthMm across, depthMm deep) and join its two sides.",
            json!({"pieceId": {"type": "string"}, "edge": {"type": "integer"}, "at": {"type": "number"}, "widthMm": {"type": "number"}, "depthMm": {"type": "number"}}),
            &["pieceId", "edge"],
        ),
        tool(
            "run_command",
            "Run a typed command exactly as in Hidework's Rhino-style command line, e.g. \"Rectangle 80 50\", \"Strap 600 25\", \"View 3d\", \"Snap on\", \"Grid 5\", \"Units in\". With no text, lists every command id.",
            json!({"text": {"type": "string"}}),
            &[],
        ),
        tool(
            "check_pattern",
            "Run the pattern checker: plain-English problems, warnings and tips (seams that don't match, holes too close to edges, fasteners that miss, stitch spacing, stack thickness, layout overlaps), each with a fix and usually a machine-readable fixAction.",
            json!({}),
            &[],
        ),
        tool(
            "test_in_3d",
            "Sew the pattern up in 3D for a few seconds (separately from the live view) and report what goes wrong: seams left open, stitches or panels overloaded, layers passing through each other, overstretched or buckled leather, hardware that misses, a bag that will not stand or tips. Each issue has a title, message, fix, severity, pieceIds and where it is (at, atPattern).",
            json!({"seconds": {"type": "number", "description": "Seconds to simulate (default 4, at most 30)."}}),
            &[],
        ),
        tool(
            "sim_pull",
            "Grab the leather in the 3D simulation at a vertex and pull it toward a point (mm), like dragging with the mouse; wholePiece moves the whole piece. Runs some frames, then lets go unless release is false.",
            json!({"vertex": {"type": "integer"}, "target": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3}, "radiusMm": {"type": "number"}, "wholePiece": {"type": "boolean"}, "frames": {"type": "integer"}, "release": {"type": "boolean"}}),
            &["vertex", "target"],
        ),
        tool(
            "select_pieces",
            "Select one or more pieces (the first is the main one), like Shift+click.",
            json!({"pieceIds": {"type": "array", "items": {"type": "string"}}}),
            &["pieceIds"],
        ),
        tool(
            "clipboard",
            "Copy, cut or paste pieces (with their holes, hardware, marks, tooling and the seams between them). Optionally select pieceIds first.",
            json!({"op": {"type": "string", "enum": ["copy", "cut", "paste"]}, "pieceIds": {"type": "array", "items": {"type": "string"}}}),
            &["op"],
        ),
        tool(
            "merge_pieces",
            "Merge pieces into one: along the seam between them, or as one outline where they overlap or touch.",
            json!({"pieceIds": {"type": "array", "items": {"type": "string"}}}),
            &[],
        ),
        tool(
            "arrange_selection",
            "Align or space out selected pieces.",
            json!({"pieceIds": {"type": "array", "items": {"type": "string"}}, "align": {"type": "string", "enum": ["left", "centre", "right", "top", "middle", "bottom"]}, "distribute": {"type": "string", "enum": ["x", "y"]}}),
            &[],
        ),
        tool(
            "set_layout",
            "Show only the 3D window, only the pattern, or both.",
            json!({"layout": {"type": "string", "enum": ["3d", "pattern", "both"]}}),
            &["layout"],
        ),
        tool(
            "set_snap",
            "Turn grid snap on or off for the 2D pattern, optionally setting the grid size in mm.",
            json!({"on": {"type": "boolean"}, "gridMm": {"type": "number"}}),
            &[],
        ),
        tool(
            "add_tooling_design",
            "Add a ready-made leather tooling design to a piece: border (cut line, bevel and a stamp row), basketweave, floral, corner flourish, checkerboard, diamond or monogram (text = initials). at is the centre in piece mm; sizeMm 0 fits the piece.",
            json!({"pieceId": {"type": "string"}, "design": {"type": "string", "enum": ["border", "basketweave", "floral", "corner", "checkerboard", "diamond", "monogram"]}, "at": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}}, "sizeMm": {"type": "number"}, "insetMm": {"type": "number"}, "text": {"type": "string"}, "tool": {"type": "string"}}),
            &["pieceId", "design"],
        ),
        tool(
            "page_count",
            "How many pages the printed template takes, packed onto the fewest pages and as drawn.",
            json!({"page": {"type": "string", "enum": ["letter", "a4"]}}),
            &[],
        ),
        tool(
            "look_from",
            "Turn the 3D camera to look from a direction (x, y, z toward the camera; z up, front is -y), like clicking the ViewCube.",
            json!({"x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"}}),
            &[],
        ),
        tool(
            "delete_item",
            "Delete a fold, hole, hardware, mark, join, laminate or material by id.",
            json!({"kind": {"type": "string", "enum": ["fold", "hole", "hardware", "mark", "join", "laminate", "material"]}, "pieceId": {"type": "string"}, "id": {"type": "string"}}),
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
            "Select something in the app (kind none|piece|edge|vertex|hole|fold|hardware|mark|join).",
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
