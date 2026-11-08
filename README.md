# Hidework

Open-source desktop software for designing leather goods (wallets, bags, journal covers, belts and straps) and thick materials like waxed canvas: draft the pattern, test how it drapes in different hides and weights, then print, laser-cut or 3D-print the template.

## What it does

**Easy to use**
- Opens on a welcome page that asks "What would you like to make?" with large cards by kind of item, plus pick up where you left off, start from a blank page, and bring in my own pattern. Simple mode is on by default and shows only the everyday tools; Full mode shows everything.
- Text size from 100% to 200%, and leather, light and high-contrast themes. Every button has a plain-English label and a tooltip that says what it does.
- A workbench laid out like Fusion 360: workspaces (Pattern, Sew, Hardware & Finish, Simulate, Output), compact toolbar groups whose CREATE ▾ style lists hold every command (pin any of them to the toolbar), File, Edit, View and Help menus, an S key command search at the mouse, a right-click marking menu for whatever is under the mouse, floating dialogs for tools such as Round corner and Punch, and a history timeline of undo steps. Simple mode keeps one short row of labelled buttons. Plus a Rhino-style command line: type a command name or its short alias and press Enter.
- Every command has a keyboard shortcut; press F1 or `?` to see them all. Cut, copy, paste, duplicate, undo and redo work on pieces. Shift-click to select several pieces, then merge, align or space them.
- Snap to grid (optional), and views showing only the 3D model, only the pattern, or both.
- Saves automatically, and offers to bring back your work after a crash.
- **Pattern checker**: one button checks the whole pattern and says in plain words what is wrong and how to fix it, often with a "Fix it" button. It covers seams that don't match, holes too close to an edge, fasteners that miss each other, stitch spacing, how thick each stack is, and pieces that overlap. **Test in 3D** sews the pattern up and reports open seams, overloaded stitches, layers passing through each other, overstretched leather, and bags that tip or will not stand.

**Pattern bench**
- Pieces with straight and curved edges, numeric corners, mirror, flip, rotate, duplicate, nudge; millimetres or inches.
- **Drawing a piece**: rectangle, rounded rectangle, circle, oval, slot, strap end, any shape point by point (drag while clicking for a curve) and mirror half (draw one half beside a centre line; the other half is copied). Each tool says in plain words what to click next and shows its size as you draw; type exact sizes as in Rhino (120 Enter for the width, 80 Enter for the height). Esc drops the shape being drawn, Backspace takes back the last point. In Simple mode they sit under one "Draw a piece" button.
- **Reshaping a piece**: drag a corner or a whole edge, drag the round handle in the middle of an edge to bend it, double-click an edge to add a point, Delete removes one. A selected piece shows each edge's length; click an edge to type its exact length or angle in the box beside it.
- **Smart snap** (F10): points jump to other pieces' corners, edge middles and edges, line up level or straight above other points with a guide line, offer the same length as another edge, and keep to 15° steps while Shift is held. A small marker and a word show what caught; Alt places freely.
- Stitched edges with holes at your pricking iron's spacing, spread evenly so every run starts and ends on a hole.
- **Fold compensation**: a fold adds `π × (contents + leather thickness) ÷ 2` so the outer layer wraps what sits inside.
- **Seam checks**: join edges that sew together; Hidework compares stitch-line lengths and hole counts.
- Punched holes and oblong slots (buckle tongues, strap slots), skive zones per edge, seam allowance, grain direction, cut counts, template notes.
- Generators: straps and belts (tip shape, hole run, folded buckle end with tongue slot and rivets), gussets sized from an edge's stitch line (auto-joined), linings inset from a piece.
- Measure tool that snaps to corners and holes.
- Bill of materials: hide area per material in ft² with cutting waste, cost from price per ft², seam length, thread estimate (4× seam), stitch holes, hardware list.
- **51 templates** to start from and change: card holders and wallets (bifold, trifold, long wallet, coin pouch), passport, notebook, journal and checkbook covers, an A4 folio, phone, tablet and laptop sleeves, glasses, earbud and pen cases, knife sheath and axe mask, belt pouch, key fob and key case, luggage tag, bookmark, coaster, drink sleeve, bottle carrier, plant hanger, valet tray, mouse pad, desk mat, tool roll, apron, watch strap, dog collar, guitar and camera straps, wrist cuff, hat band, belts and the bag builder's bags.
- **Import**: open SVG (Inkscape, Illustrator), DXF (inches or mm, including curves, splines and blocks) or vector PDF at true size. Outer shapes become pieces, circles become holes, a dotted line just inside an edge becomes stitching, and lines across a piece become folds.
- **Trace a photo** of a paper pattern: set the scale with two points you measured, or with the four corners of a sheet of Letter or A4 paper, which also straightens a photo taken at an angle.
- **Hide layout**: draw your hide (or pick a preset), mark scars, brands, thin spots and the backbone, and Hidework nests the pieces on it along the grain, avoiding flaws, and prices the job.

**Stitching, lacing and seams**
- Twelve stitch types: saddle, machine lockstitch, running, back, cross, baseball, whip, blanket, and whip, single-loop, double-loop and cross lacing (slits instead of holes, lace instead of thread). One to four rows per piece.
- Thread and lace catalogue (braided polyester, waxed linen, bonded nylon, goat, kangaroo and calf lace) with breaking strengths, used for seam strength and the thread or lace length to buy.
- Seam constructions: edge to edge, turned (stitching hidden inside), lapped, butt, welted, piped, bound and zipper. A seam with no edges on one side sews a piece onto another's face (patch pockets, tabs).
- Bonding: contact cement, water-based contact cement, PVA and double-sided tape; the template shows the band to glue, the bill of materials the area and grams. Laminates glue whole pieces face to face (linings, stiffeners, doubled straps).
- Edge finishes: raw, burnished, painted, turned (folded, with its turn allowance added to the cut line and a skive zone) and bound; decorative crease lines.

**Hardware and surface work**
- 23 kinds of hardware: double-cap and copper rivets, Chicago screws, line 20 and 24 snaps, magnetic snaps, turn locks, Sam Browne studs, grommets and eyelets, bag feet, D, O and square rings, buckles, swivel clasps, key rings, zippers, name plates and conchos. Each adds the holes, slits or window it needs, its weight, and a 3D model in brass, nickel, gunmetal, copper or black; fasteners that meet through two layers hold them together in the simulation.
- Stamps, tooling (floral, geometric, basketweave, border, pebble), embossing, engraving, paint and lettering, drawn onto the leather in 3D and marked on the template; perforation adds a staggered grid of holes.
- **Tooling menu**: draw borders, basket weave, floral and corner designs, checkerboard and diamond fills, monograms and lettering onto a piece; each prints on the template as a guide.
- Pattern tools: round a corner like a corner punch, cut a dart.

**Bags**
- A bag builder makes a complete tote, boxed tote, messenger with a flap, bucket bag or zip pouch from its width, height and depth, with the leather, seam construction, glue, stitch, edge finish, handles or shoulder strap, closure, pocket and feet you choose. Every seam matches and every rivet goes through both layers.
- 3D arrangement like CLO's arrangement points: pieces start on a bag form (front, back, sides, bottom, top, a gusset wrapping the sides and bottom, a body wrapping all round, a back panel running over into a flap, handles and shoulder straps arching over), then the seams pull them together and the bag stands, slumps or hangs according to the leather.

**Layout (modelled on CLO3D)**
- Menu bar (File, Edit, Pattern, Sewing, 3D, Fabric, Help) with a Simulate switch (Space).
- Library dock: starter patterns and piece shapes, fabric presets, hardware, objects, props.
- 3D window and 2D pattern window side by side with their own toolbars and a resizable split. The 3D window has a light studio background, a ground grid with red and green axes, and a ViewCube like Fusion 360: click a face, edge or corner to turn the view.
- Object browser (Pieces, Fabrics, Seams, Scene) above a property editor for whatever is selected.

**Live 3D simulation**
- Every piece becomes a leather shell with real thickness, folded at its fold lines (the fold allowance becomes the bend radius), sewn along its seams and fastened where rivet or snap holes coincide.
- Textured PBR rendering: procedural grain (smooth, pebbled, nubuck, canvas weave), suede flesh side, burnished cut edges, saddle-stitch thread, brass hardware, studio lighting, soft shadows and ambient occlusion.
- Live: change the pattern while the 3D model is up and it updates in place, keeping its shape, position and the camera, and carries on simulating.
- Interact like CLO: grab and pull the leather with the mouse (hold Shift to move the whole piece), pin it (I), hang weights (W), drop objects such as a phone, cards, a notebook or a bottle (O), rest it on a table edge, pedestal or hook bar.
- Readout: load, peak stitch force against stitch strength, pull at pins against tear-out, panel stress, sag, and an estimated carrying capacity (safety factor 2) once the piece is pinned or hung. Stress map colours the leather by how close it is to its limit. Strength values are estimates until calibrated.
- Solver: XPBD (extended position-based dynamics) with 16 substeps per frame; one calibrated implicit bending solve (envelope Cholesky) for every piece, sewn or not, so leather keeps its stiffness at any mesh resolution and matches the 41.5° cantilever test; seams join exact points on the stitch lines; rivets and screws clamp a ring round the cap. Leather rests on the floor with Coulomb friction and can lift off and slide. Self-contact uses a spatial hash with point-triangle and edge-edge tests that remember which side each layer is on, so layers do not pass through each other. A guard undoes any frame that blows up. Contact search and per-piece bending use a few threads, and a model at rest sleeps until something changes, so a bag at the default resolution (900) runs at about real time on a laptop CPU.
- GPU backend (experimental, not used by the app yet): `crates/hidework-gpu` runs the solver in WGSL compute shaders through wgpu, with a CPU fallback. It matches the CPU on bending within 0.3°, but it predates the November solver rewrite and is slower than the CPU on integrated graphics, so the app keeps the CPU solver.

**Fabric test (phase 2 bench)**
- Simulates a piece under gravity in up to four materials or thicknesses side by side, in 3D: over a table edge (cantilever, ASTM D1388 style), over a round pedestal (Cusick drape), or hanging from an edge.
- Solver: projective dynamics with a prefactored banded Cholesky; isometric (Bergou) bending with stiffness from flexural rigidity `D = E t³ / 12`, so 7 oz is (7/3)³ ≈ 12.7× stiffer than 3 oz of the same hide. Grain anisotropy and bias softness (for canvas) included. Checked against the textbook result that a strip overhanging twice its bending length droops to 41.5°.
- Material library: veg-tan (firm, soft), chrome-tan, oil-tan pull-up, goatskin (veg, kid), deerskin, lambskin, horse shell, waxed and duck canvas. **These physics are starting estimates**, not lab data. Calibrate any material with a strip test: enter the overhang at which a strip's tip touches a 41.5° line.
- Reports bending length, flexural rigidity, droop angle, drape coefficient, tip drop and mass.

**Output**
- Tiled true-scale PDF (Letter or A4) with 1-inch and 25 mm test squares, trim frames and page map; print at Actual size. Printing packs the pieces onto the fewest sheets of paper automatically and keeps every piece on one sheet when it fits.
- Tooling designs print as guide lines; lettering prints as text.
- SVG sheet.
- **Laser-cut the template**: colour-coded SVG (red cut, blue score folds, black engrave names) with kerf compensation, or a layered DXF (CUT, HOLES, SCORE, TEXT) in millimetres.
- **3D-print a stencil**: watertight STL plate of each piece with every stitch hole and punch through it, to mark or prick through.

## AI control (MCP)

`hidework-mcp` is a Model Context Protocol server (stdio). It finds the running app through `~/.hidework/control.json` (loopback-only port and a random token written by the app), starting Hidework if needed, and exposes 66 tools: project files, every ribbon command by name, the pattern checker and the 3D test, pulling the leather in 3D, multi-select, cut/copy/paste, merging, arranging, layout and snap, tooling designs, page counts, pieces, vertices, edges and finishes, folds, holes and slots, seams with their construction and glue, stitch types, hardware, surface work, straps, gussets, linings, laminates, corner rounding and darts, the bag builder and 3D arrangement, materials and calibration, the craft catalogue, bill of materials, the live 3D simulation (simulate, pins, weights, objects, props, status), the fabric test, exports, selection, camera views and undo. Tools that change the pattern return a screenshot of the canvas (or the 3D view) automatically; pass `screenshot: false` to skip.

Register it with Claude Code:

```bash
claude mcp add hidework -- C:\Programs\Hidework\target\release\hidework-mcp.exe
```

Any MCP client works the same way: run the executable over stdio. Set `HIDEWORK_APP` if `hidework.exe` is not next to `hidework-mcp.exe`.

## Install

Windows: run `Hidework_<version>_x64-setup.exe`. It installs for the current user (no administrator needed), adds Hidework to the Start menu and the desktop, opens `.hidework` files when you double-click them, and puts `hidework-mcp.exe` next to the app. Help › Connect an AI agent shows the exact command for your install. An `.msi` is also built for managed installs.

## Build it

Needs Rust (stable), Node 20+, and on Windows the MSVC build tools and WebView2.

```bash
npm install
npm run tauri dev
```

Build the installers with `npx tauri build`; they land in `target/release/bundle/nsis` and `target/release/bundle/msi`.

To work on the interface in an ordinary browser, start the dev bridge (it answers the app's commands over HTTP) and the Vite server:

```bash
cargo run --manifest-path tools/devbridge/Cargo.toml
npm run dev
```

## Layout

- `crates/hidework-core`: pattern model, geometry, fold compensation, stitching, generators, bill of materials, physics, meshing, drape solver, PDF/SVG/DXF/STL export. Pure Rust. `cargo test -p hidework-core`.
- `crates/hidework-mcp`: the MCP server.
- `crates/hidework-gpu`: experimental wgpu compute backend for the cloth solver (not wired into the app). `cargo test -p hidework-gpu`.
- `ui/src/hardware/`: detailed 3D hardware, stitches and edges. `ui/gallery.html` is a dev-only gallery of every hardware kind (`npm run dev`, then `/gallery.html`).
- `src-tauri`: the desktop shell (Tauri 2) and the local control channel.
- `ui`: the interface (TypeScript; Canvas 2D for the pattern, three.js for the 3D window and fabric test).
- `tools/devbridge`: a small HTTP server that answers the app's commands so the interface runs in a browser during development.
- `docs/research-2026-11-feature-survey.md`: what comparable software offers and how Hidework prioritised it. `docs/feature-gaps-2026-11.md`: what is still missing and the plan for it. `docs/usability-2026-11`: screenshots from the ease-of-use review.

Export a template without the app:

```bash
cargo run -p hidework-core --example export -- card-wallet out-dir letter
```

## License

Dual-licensed under MIT or Apache-2.0, at your option. Bundled fonts (Cinzel, Cinzel Decorative, EB Garamond) are under the SIL Open Font License; three.js is MIT. Import uses roxmltree, lopdf and image (MIT or Apache-2.0).
