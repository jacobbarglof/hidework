# Feature survey: comparable software (2026-11-07)

Desk research across leather/footwear CAD (Lectra Modaris and Versalis, Gerber AccuMark and Taurus, Romans, Teseo, Icad3D+, Comelz Caligola), garment CAD (Seamly2D/Valentina, CLO3D, Marvelous Designer, Browzwear, Optitex, Tukatech, Style3D) and the general tools leatherworkers use (Inkscape, Illustrator, Fusion 360, LightBurn, Deepnest). Several vendor pages were thin or gated; items marked "unverified" came from prior knowledge, not a source read during the survey.

## What the field offers

- **Drawing**: lines, arcs, Beziers, offsets; parametric drafting from measurement tables (Seamly2D/Valentina, Modaris); constraint solving (Fusion 360).
- **Editing**: mirror, fold/unfold on a line, rotate, split, merge (Modaris, CLO, Seamly2D).
- **Checking**: seam walking (edge lengths and notches that sew together; Optitex, AccuMark, CLO, unverified); piece area and perimeter.
- **Pattern marks**: seam allowance as a separate cut line, notches, grainline, labels (Seamly2D).
- **Leather-specific**: skive zones; lining and reinforcement derived by inset; hide flaw and quality-zone mapping with nesting (Lectra Versalis, Gerber Taurus II, 3 to 10% yield gains claimed); hide consumption and costing (Lectra Diamino/Formaris, Quick Offer; Icad3D+).
- **General vector tools have no stitch-hole tool**: Inkscape users fake it with Pattern Along Path or dashed strokes.
- **Output**: tiled PDF, DXF AAMA/ASTM, SVG (Valentina). Print-at-actual-size with a test square is the standard advice. LightBurn bundles SVGnest; Deepnest (MIT) nests DXF/SVG on arbitrary sheets but has no flaw zones.
- **3D**: Romans RCS 3D Bag and Style3D model leather thickness, stiffness and grain. In CLO, thickness is visual only, with a separate collision thickness.

## How 3D tools take material physics

- CLO Fabric Kit: 220 x 30 mm swatches in warp, weft and bias; weight, thickness, a cantilever bending test (overhang read off a ruler) and a stretch curve. Parameters: stretch, shear, bending (warp/weft/bias), buckling, density, friction, damping.
- Optitex FTU: tension meter for stretch and shear, stiffness tester for bending, 25 x 200 mm specimens.
- Browzwear FAB: hardware analyzer; materials travel in U3M (zip of PBR textures plus physics.json).
- Cusick drape is used to validate simulations rather than as an input.

## Ranking used for Hidework

Must: tiled true-scale PDF; precise drawing with numeric entry; stitch-hole tool with iron pitch; thickness-driven fold allowance; seam walking with hole counts; SVG/DXF with layers; grain and labels.
Should: material library in mm and oz; area, cost and bill of materials; mirror and lining/reinforcement derivation; skive zones; parametric sizing; hardware library.
Nice: hide nesting with flaw zones; 3D fold-up preview; material physics entry with a strip test; AAMA DXF; projector mode.
