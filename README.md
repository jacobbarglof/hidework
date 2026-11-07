# Hidework

Open-source desktop software for designing leather goods (wallets, bags, journal covers, straps) and printing true-scale templates.

Phase 1 (this version) is the pattern bench:

- Draw pieces with straight and curved edges, in millimetres or inches.
- Mark stitched edges. Hidework places stitch holes at your pricking iron's spacing, spread evenly so every run starts and ends on a hole.
- **Fold compensation.** Add a fold and say how much sits inside it (cards, inner layers). The outer layer gets `π × (contents + leather thickness) ÷ 2` of extra length so it closes flat. Leather thickness comes from the material (1 oz = 1/64 in).
- **Seam checks.** Join two edges that sew together. Hidework compares their stitch-line lengths and hole counts.
- Punched holes for snaps, rivets and straps; cut counts; grain direction; optional seam allowance.
- Export a tiled, true-scale PDF (Letter or A4, with test squares and trim frames) or a single SVG for laser cutters.

Material simulation (drape, stiffness by tannage and weight) is planned for phase 2.

## Run it

Needs Rust (stable), Node 20+, and on Windows the MSVC build tools and WebView2.

```bash
npm install
npm run tauri dev
```

Build an installer with `npm run tauri build`.

## Layout

- `crates/hidework-core` - the pattern model, geometry, fold compensation, stitching and PDF/SVG export. Pure Rust, no UI. `cargo test -p hidework-core`.
- `src-tauri` - the desktop shell (Tauri 2) exposing the core as commands.
- `ui` - the interface (TypeScript, Canvas 2D, no framework).

Export a template without the app:

```bash
cargo run -p hidework-core --example export -- card-wallet out-dir letter
```

## License

Dual-licensed under MIT or Apache-2.0, at your option. Bundled fonts (Cinzel, Cinzel Decorative, EB Garamond) are under the SIL Open Font License.
