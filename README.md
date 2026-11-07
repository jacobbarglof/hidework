# Hidework

Open-source desktop software for designing leather goods (wallets, bags, journal covers, belts and straps) and thick materials like waxed canvas: draft the pattern, test how it drapes in different hides and weights, then print, laser-cut or 3D-print the template.

## What it does

**Pattern bench**
- Pieces with straight and curved edges, numeric corners, mirror, flip, rotate, duplicate, nudge; millimetres or inches.
- Stitched edges with holes at your pricking iron's spacing, spread evenly so every run starts and ends on a hole.
- **Fold compensation**: a fold adds `π × (contents + leather thickness) ÷ 2` so the outer layer wraps what sits inside.
- **Seam checks**: join edges that sew together; Hidework compares stitch-line lengths and hole counts.
- Punched holes and oblong slots (buckle tongues, strap slots), skive zones per edge, seam allowance, grain direction, cut counts, template notes.
- Generators: straps and belts (tip shape, hole run, folded buckle end with tongue slot and rivets), gussets sized from an edge's stitch line (auto-joined), linings inset from a piece.
- Measure tool that snaps to corners and holes.
- Bill of materials: hide area per material in ft² with cutting waste, cost from price per ft², seam length, thread estimate (4× seam), stitch holes, hardware list.
- Starter templates: fold-over card wallet, belt, A5 journal cover.

**Layout (modelled on CLO3D)**
- Menu bar (File, Edit, Pattern, Sewing, 3D, Fabric, Help) with a Simulate switch (Space).
- Library dock: starter patterns and piece shapes, fabric presets, hardware, objects, props.
- 3D window and 2D pattern window side by side with their own toolbars and a resizable split.
- Object browser (Pieces, Fabrics, Seams, Scene) above a property editor for whatever is selected.

**Live 3D simulation**
- Every piece becomes a leather shell with real thickness, folded at its fold lines (the fold allowance becomes the bend radius), sewn along its seams and fastened where rivet or snap holes coincide.
- Textured PBR rendering: procedural grain (smooth, pebbled, nubuck, canvas weave), suede flesh side, burnished cut edges, saddle-stitch thread, brass hardware, studio lighting, soft shadows and ambient occlusion.
- Interact like CLO: drag the leather (G), pin it (I), hang weights (W), drop objects such as a phone, cards, a notebook or a bottle (O), rest it on a table edge, pedestal or hook bar.
- Readout: load, peak stitch force against stitch strength, pull at pins against tear-out, panel stress, sag, and an estimated carrying capacity (safety factor 2) once the piece is pinned or hung. Stress map colours the leather by how close it is to its limit. Strength values are estimates until calibrated.
- Solver: projective dynamics with isometric bending, seams as springs between matching stitch holes, contact with props, objects and itself.

**Fabric test (phase 2 bench)**
- Simulates a piece under gravity in up to four materials or thicknesses side by side, in 3D: over a table edge (cantilever, ASTM D1388 style), over a round pedestal (Cusick drape), or hanging from an edge.
- Solver: projective dynamics with a prefactored banded Cholesky; isometric (Bergou) bending with stiffness from flexural rigidity `D = E t³ / 12`, so 7 oz is (7/3)³ ≈ 12.7× stiffer than 3 oz of the same hide. Grain anisotropy and bias softness (for canvas) included. Checked against the textbook result that a strip overhanging twice its bending length droops to 41.5°.
- Material library: veg-tan (firm, soft), chrome-tan, oil-tan pull-up, goatskin (veg, kid), deerskin, lambskin, horse shell, waxed and duck canvas. **These physics are starting estimates**, not lab data. Calibrate any material with a strip test: enter the overhang at which a strip's tip touches a 41.5° line.
- Reports bending length, flexural rigidity, droop angle, drape coefficient, tip drop and mass. No self-collision yet.

**Output**
- Tiled true-scale PDF (Letter or A4) with 1-inch and 25 mm test squares, trim frames and page map; print at Actual size.
- SVG sheet.
- **Laser-cut the template**: colour-coded SVG (red cut, blue score folds, black engrave names) with kerf compensation, or a layered DXF (CUT, HOLES, SCORE, TEXT) in millimetres.
- **3D-print a stencil**: watertight STL plate of each piece with every stitch hole and punch through it, to mark or prick through.

## AI control (MCP)

`hidework-mcp` is a Model Context Protocol server (stdio). It finds the running app through `~/.hidework/control.json` (loopback-only port and a random token written by the app), starting Hidework if needed, and exposes 40 tools: project files, pieces, vertices, edges, folds, holes and slots, seams, straps, gussets, linings, materials and calibration, bill of materials, the live 3D simulation (simulate, pins, weights, objects, props, status), the fabric test, exports, selection, camera views and undo. Tools that change the pattern return a screenshot of the canvas (or the 3D view) automatically; pass `screenshot: false` to skip.

Register it with Claude Code:

```bash
claude mcp add hidework -- C:\Programs\Hidework\target\release\hidework-mcp.exe
```

Any MCP client works the same way: run the executable over stdio. Set `HIDEWORK_APP` if `hidework.exe` is not next to `hidework-mcp.exe`.

## Run it

Needs Rust (stable), Node 20+, and on Windows the MSVC build tools and WebView2.

```bash
npm install
npm run tauri dev
```

Build an installer with `npm run tauri build`.

## Layout

- `crates/hidework-core`: pattern model, geometry, fold compensation, stitching, generators, bill of materials, physics, meshing, drape solver, PDF/SVG/DXF/STL export. Pure Rust. `cargo test -p hidework-core`.
- `crates/hidework-mcp`: the MCP server.
- `src-tauri`: the desktop shell (Tauri 2) and the local control channel.
- `ui`: the interface (TypeScript; Canvas 2D for the pattern, three.js for the 3D window and fabric test).
- `docs/research-2026-11-feature-survey.md`: what comparable software offers and how Hidework prioritised it.

Export a template without the app:

```bash
cargo run -p hidework-core --example export -- card-wallet out-dir letter
```

## License

Dual-licensed under MIT or Apache-2.0, at your option. Bundled fonts (Cinzel, Cinzel Decorative, EB Garamond) are under the SIL Open Font License; three.js is MIT.
