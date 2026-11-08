//! Turns the designed pattern into what gets cut: fold compensation, stitch lines and holes,
//! seam allowance, per-edge measurements and join checks.

use crate::geom::{clip_axis_line, flatten_cubic, offset_closed, offset_variable, point_at, v, Rect, Vec2};
use crate::model::{fold_allowance_mm, Adhesive, EdgeKind, EdgeRef, HardwarePlacement, Hole, Mark, MarkKind, Orientation, Piece, Project, StitchKind};
use serde::Serialize;

const EPS: f64 = 1e-7;
/// Two joined edges match when their stitch lines (or edges) differ by no more than this.
pub const JOIN_TOLERANCE_MM: f64 = 0.5;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedProject {
    pub pieces: Vec<ComputedPiece>,
    pub joins: Vec<JoinReport>,
    pub warnings: Vec<String>,
    /// Union of every piece's cut outline on the sheet.
    pub bounds: Option<Rect>,
}

/// All coordinates are piece-local and fold-compensated; add the piece position for the sheet.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedPiece {
    pub id: String,
    /// Finished outline after fold compensation.
    pub outline: Vec<Vec2>,
    /// For segment `i` (outline[i] to outline[i+1]): the design edge it came from, or none for
    /// fold allowance inserted at a vertex.
    pub outline_edges: Vec<Option<usize>>,
    /// Cutting line (finished outline plus seam allowance).
    pub cut: Vec<Vec2>,
    /// Where each design vertex and control point ends up after compensation.
    pub vertices: Vec<Vec2>,
    pub controls: Vec<Option<[Vec2; 2]>>,
    pub stitch_runs: Vec<StitchRun>,
    pub folds: Vec<FoldGeom>,
    pub holes: Vec<Hole>,
    /// Inner boundary of each skive zone, as polylines.
    pub skive: Vec<Vec<Vec2>>,
    /// Inner boundary of each glued band (where to spread cement), as polylines.
    pub glue: Vec<Vec<Vec2>>,
    /// Decorative crease lines.
    pub creases: Vec<Vec<Vec2>>,
    /// Stamps, tooling and other surface work, in compensated coordinates.
    pub marks: Vec<Mark>,
    /// Hardware placements, in compensated coordinates.
    pub hardware: Vec<HardwarePlacement>,
    pub edges: Vec<EdgeReport>,
    pub thickness_mm: f64,
    pub material_name: String,
    pub bounds: Rect,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StitchRun {
    pub points: Vec<Vec2>,
    pub closed: bool,
    pub holes: Vec<Vec2>,
    /// Actual hole spacing after spreading holes evenly over the run.
    pub spacing_mm: f64,
    pub kind: StitchKind,
    /// 0 for the row nearest the edge.
    pub row: u32,
    /// Laced through slits rather than stitched through holes.
    pub lace: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldGeom {
    pub id: String,
    pub orientation: Orientation,
    /// Compensated coordinate where the fold allowance starts (y or x).
    pub at: f64,
    /// Where it starts in the coordinates this fold sees (after earlier folds, before later
    /// ones). Undo folds in reverse order with this to map a point back to design coordinates.
    pub stage_at: f64,
    pub shift_mm: f64,
    pub start: Vec<[Vec2; 2]>,
    pub end: Vec<[Vec2; 2]>,
    pub center: Vec<[Vec2; 2]>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeReport {
    pub length_mm: f64,
    pub stitch_length_mm: f64,
    pub hole_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinReport {
    pub id: String,
    pub a_length_mm: f64,
    pub b_length_mm: f64,
    pub a_stitch_mm: f64,
    pub b_stitch_mm: f64,
    pub a_holes: usize,
    pub b_holes: usize,
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Copy)]
struct ResolvedFold {
    o: Orientation,
    at: f64,
    shift: f64,
}

impl ResolvedFold {
    fn side(&self, p: Vec2) -> f64 {
        match self.o {
            Orientation::Horizontal => p.y - self.at,
            Orientation::Vertical => p.x - self.at,
        }
    }
    fn vector(&self) -> Vec2 {
        match self.o {
            Orientation::Horizontal => v(0.0, self.shift),
            Orientation::Vertical => v(self.shift, 0.0),
        }
    }
    fn map(&self, p: Vec2) -> Vec2 {
        if self.side(p) > EPS {
            p + self.vector()
        } else {
            p
        }
    }
}

fn map_all(folds: &[ResolvedFold], p: Vec2) -> Vec2 {
    folds.iter().fold(p, |p, f| f.map(p))
}

pub fn compute(project: &Project) -> ComputedProject {
    let mut warnings = Vec::new();
    let mut pieces = Vec::new();
    for piece in &project.pieces {
        if piece.vertices.len() < 3 || piece.edges.len() != piece.vertices.len() {
            warnings.push(format!("{}: needs at least 3 corners and one edge per corner", piece.name));
            continue;
        }
        let (thickness, material_name) = match project.material(&piece.material_id) {
            Some(m) => (m.thickness_mm, m.name.clone()),
            None => {
                warnings.push(format!("{}: no material chosen, assuming 1 mm", piece.name));
                (1.0, String::from("No material"))
            }
        };
        pieces.push(compute_piece(piece, thickness, material_name));
    }
    let joins = project
        .joins
        .iter()
        .filter_map(|j| {
            let a = side_report(&pieces, &j.a)?;
            if j.onto_face() {
                let name = project.piece(&j.b.piece_id)?.name.clone();
                return Some(JoinReport {
                    id: j.id.clone(),
                    a_length_mm: a.length,
                    b_length_mm: 0.0,
                    a_stitch_mm: a.stitch,
                    b_stitch_mm: 0.0,
                    a_holes: a.holes,
                    b_holes: 0,
                    ok: true,
                    message: format!("Sewn onto the face of {name}: {:.1} mm, {} holes", if a.stitch > 0.0 { a.stitch } else { a.length }, a.holes),
                });
            }
            let b = side_report(&pieces, &j.b)?;
            Some(join_report(&j.id, a, b))
        })
        .collect();
    // Glue bands along glued seams, on both sides.
    for j in &project.joins {
        if j.glue == Adhesive::None {
            continue;
        }
        for side in [&j.a, &j.b] {
            let Some(pc) = project.piece(&side.piece_id) else { continue };
            let Some(cp) = pieces.iter_mut().find(|c| c.id == side.piece_id) else { continue };
            let w = if j.glue_width_mm > 0.0 { j.glue_width_mm } else { (2.0 * pc.stitch.margin_mm).max(6.0) };
            let bands = edge_bands(&cp.outline, &cp.outline_edges, &side.edges, w);
            cp.glue.extend(bands);
        }
    }
    let mut bounds = Rect::empty();
    for (cp, p) in pieces.iter().zip(project.pieces.iter().filter(|p| pieces_contains(&pieces, &p.id))) {
        bounds.union(&cp.bounds.translated(p.position));
    }
    ComputedProject { pieces, joins, warnings, bounds: if bounds.is_empty() { None } else { Some(bounds) } }
}

fn pieces_contains(pieces: &[ComputedPiece], id: &str) -> bool {
    pieces.iter().any(|c| c.id == id)
}

fn flatten(piece: &Piece) -> (Vec<Vec2>, Vec<Option<usize>>) {
    let n = piece.vertices.len();
    let mut pts: Vec<Vec2> = Vec::new();
    let mut tags: Vec<Option<usize>> = Vec::new();
    let push = |p: Vec2, t: Option<usize>, pts: &mut Vec<Vec2>, tags: &mut Vec<Option<usize>>| {
        if pts.last().is_some_and(|l| l.dist(p) < 1e-9) {
            *tags.last_mut().unwrap() = t;
        } else {
            pts.push(p);
            tags.push(t);
        }
    };
    for i in 0..n {
        let a = piece.vertices[i];
        let b = piece.vertices[(i + 1) % n];
        push(a, Some(i), &mut pts, &mut tags);
        if let EdgeKind::Cubic { c1, c2 } = piece.edges[i].kind {
            let curve = flatten_cubic(a, c1, c2, b);
            for &p in &curve[..curve.len() - 1] {
                push(p, Some(i), &mut pts, &mut tags);
            }
        }
    }
    if pts.len() > 1 && pts[0].dist(*pts.last().unwrap()) < 1e-9 {
        pts.pop();
        tags.pop();
    }
    (pts, tags)
}

fn class(d: f64) -> i32 {
    if d > EPS {
        1
    } else if d < -EPS {
        -1
    } else {
        0
    }
}

/// Insert a fold allowance into a flattened outline. Vertices on the far side move by the
/// allowance; a vertex sitting on the fold line splits so the allowance belongs to no edge, and
/// an edge crossing the fold keeps the allowance as part of itself.
fn apply_fold(pts: &[Vec2], tags: &[Option<usize>], f: &ResolvedFold) -> (Vec<Vec2>, Vec<Option<usize>>) {
    let n = pts.len();
    let sh = f.vector();
    let sd: Vec<f64> = pts.iter().map(|&p| f.side(p)).collect();
    let neighbor = |i: usize, step: isize| -> i32 {
        for k in 1..n {
            let j = ((i as isize + step * k as isize).rem_euclid(n as isize)) as usize;
            let c = class(sd[j]);
            if c != 0 {
                return c;
            }
        }
        -1
    };
    let mut op = Vec::with_capacity(n + 4);
    let mut ot = Vec::with_capacity(n + 4);
    for i in 0..n {
        let a = pts[i];
        let t = tags[i];
        let ca = class(sd[i]);
        if ca == 0 {
            match (neighbor(i, -1), neighbor(i, 1)) {
                (-1, 1) => {
                    op.extend([a, a + sh]);
                    ot.extend([None, t]);
                }
                (1, -1) => {
                    op.extend([a + sh, a]);
                    ot.extend([None, t]);
                }
                (1, 1) => {
                    op.push(a + sh);
                    ot.push(t);
                }
                _ => {
                    op.push(a);
                    ot.push(t);
                }
            }
        } else {
            op.push(if ca > 0 { a + sh } else { a });
            ot.push(t);
        }
        let j = (i + 1) % n;
        let cb = class(sd[j]);
        if ca != 0 && cb != 0 && ca != cb {
            let p = a + (pts[j] - a) * (sd[i] / (sd[i] - sd[j]));
            if ca < 0 {
                op.extend([p, p + sh]);
            } else {
                op.extend([p + sh, p]);
            }
            ot.extend([t, t]);
        }
    }
    (op, ot)
}

fn compute_piece(piece: &Piece, thickness: f64, material_name: String) -> ComputedPiece {
    // Resolve fold positions into the coordinates each fold sees after the earlier ones.
    let mut folds: Vec<ResolvedFold> = Vec::new();
    for f in &piece.folds {
        let mut at = f.position;
        for r in &folds {
            if r.o == f.orientation && at - r.at > EPS {
                at += r.shift;
            }
        }
        folds.push(ResolvedFold { o: f.orientation, at, shift: fold_allowance_mm(f.contents_mm, thickness) });
    }

    let (mut pts, mut tags) = flatten(piece);
    for f in &folds {
        let (p, t) = apply_fold(&pts, &tags, f);
        pts = p;
        tags = t;
    }
    let m = pts.len();

    let vertices = piece.vertices.iter().map(|&p| map_all(&folds, p)).collect();
    let controls = piece
        .edges
        .iter()
        .map(|e| match e.kind {
            EdgeKind::Cubic { c1, c2 } => Some([map_all(&folds, c1), map_all(&folds, c2)]),
            EdgeKind::Line => None,
        })
        .collect();

    let mut edges = vec![EdgeReport::default(); piece.edges.len()];
    for i in 0..m {
        if let Some(e) = tags[i] {
            edges[e].length_mm += pts[i].dist(pts[(i + 1) % m]);
        }
    }

    // Stitching.
    let stitched: Vec<bool> = tags.iter().map(|t| t.is_some_and(|e| piece.edges[e].stitched)).collect();
    let mut runs: Vec<Vec<usize>> = Vec::new();
    let all = stitched.iter().all(|&s| s);
    if all {
        runs.push((0..m).collect());
    } else if let Some(start) = stitched.iter().position(|&s| !s) {
        let mut cur = Vec::new();
        for k in 1..=m {
            let i = (start + k) % m;
            if stitched[i] {
                cur.push(i);
            } else if !cur.is_empty() {
                runs.push(std::mem::take(&mut cur));
            }
        }
        if !cur.is_empty() {
            runs.push(cur);
        }
    }
    let pitch = piece.stitch.pitch_mm.max(0.5);
    let lace = crate::craft::stitch_info(piece.stitch.kind).lace;
    let rows = piece.stitch.rows.clamp(1, 4);
    let gap = if piece.stitch.row_gap_mm > 0.0 { piece.stitch.row_gap_mm } else { 4.0 };
    let mut stitch_runs = Vec::new();
    for row in 0..rows {
    let inset = if runs.is_empty() { Vec::new() } else { offset_closed(&pts, piece.stitch.margin_mm + gap * row as f64) };
    for run in &runs {
        let mut line: Vec<Vec2> = run.iter().map(|&i| inset[i]).collect();
        line.push(inset[(run[run.len() - 1] + 1) % m]);
        let mut ranges: Vec<(usize, f64, f64)> = Vec::new();
        let mut s = 0.0;
        for (k, &i) in run.iter().enumerate() {
            let l = line[k].dist(line[k + 1]);
            if let Some(e) = tags[i] {
                if row == 0 {
                    edges[e].stitch_length_mm += l;
                }
                match ranges.iter_mut().find(|r| r.0 == e) {
                    Some(r) => r.2 = s + l,
                    None => ranges.push((e, s, s + l)),
                }
            }
            s += l;
        }
        let total = s;
        let (count, spacing, offsets): (usize, f64, Vec<f64>) = if all {
            let n = ((total / pitch).round() as usize).max(3);
            let sp = total / n as f64;
            (n, sp, (0..n).map(|k| k as f64 * sp).collect())
        } else {
            let n = ((total / pitch).round() as usize).max(1);
            let sp = total / n as f64;
            (n + 1, sp, (0..=n).map(|k| k as f64 * sp).collect())
        };
        debug_assert_eq!(count, offsets.len());
        if row == 0 {
            for &(e, a, b) in &ranges {
                edges[e].hole_count += offsets.iter().filter(|&&o| o >= a - 1e-6 && o <= b + 1e-6).count();
            }
        }
        let holes = offsets.iter().map(|&o| point_at(&line, o)).collect();
        if all {
            line.pop();
        }
        stitch_runs.push(StitchRun { points: line, closed: all, holes, spacing_mm: spacing, kind: piece.stitch.kind, row, lace });
    }
    }

    // Cut line: seam allowance everywhere plus a turn allowance on turned (folded) edges.
    let out: Vec<f64> = tags.iter().map(|t| -(piece.seam_allowance_mm + t.map_or(0.0, |e| piece.edges[e].turn_allowance()))).collect();
    let cut = if out.iter().any(|&d| d != 0.0) { offset_variable(&pts, &out) } else { pts.clone() };

    // Fold lines, carried through any later folds.
    let fold_geoms = folds
        .iter()
        .enumerate()
        .map(|(k, f)| {
            let carry = |c: f64| {
                let mut c = c;
                for later in &folds[k + 1..] {
                    if later.o == f.o && c - later.at > EPS {
                        c += later.shift;
                    }
                }
                c
            };
            let horizontal = f.o == Orientation::Horizontal;
            let at = carry(f.at);
            let end = carry(f.at + f.shift);
            FoldGeom {
                id: piece.folds[k].id.clone(),
                orientation: f.o,
                at,
                stage_at: f.at,
                shift_mm: f.shift,
                start: clip_axis_line(&pts, at, horizontal),
                end: clip_axis_line(&pts, end, horizontal),
                center: clip_axis_line(&pts, (at + end) / 2.0, horizontal),
            }
        })
        .collect();

    // Punched holes, then the holes hardware and perforation need.
    let mut design_holes = piece.holes.clone();
    for hw in &piece.hardware {
        design_holes.extend(crate::craft::hardware_holes(hw));
    }
    for mk in &piece.marks {
        if mk.kind == MarkKind::Perforate {
            design_holes.extend(perforation(mk));
        }
    }
    let holes = design_holes.into_iter().map(|h| Hole { center: map_all(&folds, h.center), ..h }).collect();
    let marks = piece.marks.iter().map(|mk| Mark { center: map_all(&folds, mk.center), ..mk.clone() }).collect();

    let mut skive = Vec::new();
    let mut creases = Vec::new();
    for (e, edge) in piece.edges.iter().enumerate() {
        // A turned edge is skived across its turn allowance.
        let turn = edge.turn_allowance();
        if edge.skive_mm > 0.0 || turn > 0.0 {
            let w = if edge.skive_mm > 0.0 { edge.skive_mm } else { turn };
            skive.extend(edge_bands(&pts, &tags, &[e], w));
        }
        if edge.crease {
            let d = (piece.stitch.margin_mm * 0.55).clamp(1.0, 2.5);
            creases.extend(edge_bands(&pts, &tags, &[e], d));
        }
    }

    ComputedPiece {
        skive,
        glue: Vec::new(),
        creases,
        marks,
        hardware: piece.hardware.iter().map(|hw| HardwarePlacement { at: map_all(&folds, hw.at), ..hw.clone() }).collect(),
        id: piece.id.clone(),
        bounds: Rect::of(&cut),
        outline: pts,
        outline_edges: tags,
        cut,
        vertices,
        controls,
        stitch_runs,
        folds: fold_geoms,
        holes,
        edges,
        thickness_mm: thickness,
        material_name,
    }
}

/// Polylines `d` inside the outline along the given edges, one per contiguous stretch.
pub fn edge_bands(pts: &[Vec2], tags: &[Option<usize>], edges: &[usize], d: f64) -> Vec<Vec<Vec2>> {
    let m = pts.len();
    if m < 3 || d == 0.0 {
        return vec![];
    }
    let ins = offset_closed(pts, d);
    let on = |i: usize| tags[i].is_some_and(|e| edges.contains(&e));
    let start = (0..m).find(|&i| !on(i));
    let mut out = Vec::new();
    let mut line: Vec<Vec2> = Vec::new();
    let order: Vec<usize> = match start {
        Some(s) => (1..=m).map(|k| (s + k) % m).collect(),
        None => {
            let mut l: Vec<Vec2> = ins.clone();
            l.push(ins[0]);
            return vec![l];
        }
    };
    for i in order {
        if on(i) {
            if line.is_empty() {
                line.push(ins[i]);
            }
            line.push(ins[(i + 1) % m]);
        } else if line.len() > 1 {
            out.push(std::mem::take(&mut line));
        } else {
            line.clear();
        }
    }
    if line.len() > 1 {
        out.push(line);
    }
    out
}

/// Holes filling a perforation mark: `pattern` is "spacing" or "spacing/diameter" in mm.
fn perforation(mk: &Mark) -> Vec<Hole> {
    let mut it = mk.pattern.split('/').map(|s| s.trim().parse::<f64>().ok());
    let spacing = it.next().flatten().unwrap_or(6.0).max(1.5);
    let dia = it.next().flatten().unwrap_or(2.0).clamp(0.5, spacing * 0.9);
    let (c, s) = (mk.angle_deg.to_radians().cos(), mk.angle_deg.to_radians().sin());
    let (nx, ny) = (((mk.size.x / spacing).floor() as i64).max(0), ((mk.size.y / spacing).floor() as i64).max(0));
    let mut out = Vec::new();
    for iy in 0..=ny {
        for ix in 0..=nx {
            // Staggered rows look like real perforated leather.
            let stagger = if iy % 2 == 1 { spacing / 2.0 } else { 0.0 };
            let x = -mk.size.x / 2.0 + (mk.size.x - nx as f64 * spacing) / 2.0 + ix as f64 * spacing + stagger;
            let y = -mk.size.y / 2.0 + (mk.size.y - ny as f64 * spacing) / 2.0 + iy as f64 * spacing;
            if x > mk.size.x / 2.0 + 1e-9 {
                continue;
            }
            let k = out.len();
            out.push(Hole {
                id: format!("{}#{k}", mk.id),
                center: mk.center + v(x * c - y * s, x * s + y * c),
                diameter_mm: dia,
                label: if k == 0 { "Perforation".into() } else { String::new() },
                length_mm: 0.0,
                angle_deg: 0.0,
            });
        }
    }
    out
}

struct SideReport {
    length: f64,
    stitch: f64,
    holes: usize,
}

fn side_report(pieces: &[ComputedPiece], r: &EdgeRef) -> Option<SideReport> {
    let cp = pieces.iter().find(|c| c.id == r.piece_id)?;
    let mut out = SideReport { length: 0.0, stitch: 0.0, holes: 0 };
    for &e in &r.edges {
        let er = cp.edges.get(e)?;
        out.length += er.length_mm;
        out.stitch += er.stitch_length_mm;
        out.holes += er.hole_count;
    }
    Some(out)
}

fn join_report(id: &str, a: SideReport, b: SideReport) -> JoinReport {
    let stitched = a.stitch > 0.0 && b.stitch > 0.0;
    let (ok, message) = if stitched {
        let diff = (a.stitch - b.stitch).abs();
        if diff <= JOIN_TOLERANCE_MM && a.holes == b.holes {
            (true, format!("Stitch lines match: {:.1} mm, {} holes each", a.stitch, a.holes))
        } else if diff > JOIN_TOLERANCE_MM {
            (false, format!("Stitch lines differ by {:.1} mm ({:.1} vs {:.1})", diff, a.stitch, b.stitch))
        } else {
            if a.holes.abs_diff(b.holes) == 1 {
                // A hole on a corner counts for both edges that meet there.
                (true, format!("Stitch lines match: {:.1} mm, {} and {} holes (one is shared at a corner)", a.stitch, a.holes, b.holes))
            } else {
                (false, format!("Same length but {} vs {} holes: check the pricking iron spacing", a.holes, b.holes))
            }
        }
    } else {
        let diff = (a.length - b.length).abs();
        if diff <= JOIN_TOLERANCE_MM {
            (true, format!("Edges match: {:.1} mm", a.length))
        } else {
            (false, format!("Edges differ by {:.1} mm ({:.1} vs {:.1})", diff, a.length, b.length))
        }
    };
    JoinReport {
        id: id.to_string(),
        a_length_mm: a.length,
        b_length_mm: b.length,
        a_stitch_mm: a.stitch,
        b_stitch_mm: b.stitch,
        a_holes: a.holes,
        b_holes: b.holes,
        ok,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn rect_piece(w: f64, h: f64, stitched: bool) -> Piece {
        Piece {
            id: "p".into(),
            name: "Panel".into(),
            material_id: "m".into(),
            position: v(0.0, 0.0),
            vertices: vec![v(0.0, 0.0), v(w, 0.0), v(w, h), v(0.0, h)],
            edges: (0..4).map(|_| Edge::line(stitched)).collect(),
            cut_count: 1,
            seam_allowance_mm: 0.0,
            stitch: StitchSettings::default(),
            folds: vec![],
            holes: vec![],
            grain_deg: 0.0,
            notes: String::new(),
            hardware: vec![],
            marks: vec![],
            place: None,
        }
    }

    #[test]
    fn fold_across_rectangle_adds_allowance_to_side_edges() {
        let mut p = rect_piece(100.0, 120.0, false);
        p.folds.push(Fold { id: "f".into(), orientation: Orientation::Horizontal, position: 60.0, contents_mm: 4.0 });
        let c = compute_piece(&p, 1.2, "Goat".into());
        let a = fold_allowance_mm(4.0, 1.2);
        assert!((c.bounds.height() - (120.0 + a)).abs() < 1e-6);
        // The side edges cross the fold, so each one carries the allowance.
        assert!((c.edges[1].length_mm - (120.0 + a)).abs() < 1e-6);
        assert!((c.edges[0].length_mm - 100.0).abs() < 1e-6);
        assert_eq!(c.folds[0].center.len(), 1);
        assert!((c.folds[0].center[0][0].y - (60.0 + a / 2.0)).abs() < 1e-6);
    }

    #[test]
    fn closed_stitch_loop_on_square() {
        let p = rect_piece(50.0, 50.0, true);
        let c = compute_piece(&p, 1.0, "x".into());
        assert_eq!(c.stitch_runs.len(), 1);
        let r = &c.stitch_runs[0];
        assert!(r.closed);
        // Inset square is 44 mm a side, 176 mm around; 3.85 mm pitch gives 46 holes.
        assert_eq!(r.holes.len(), 46);
        assert!((r.spacing_mm - 176.0 / 46.0).abs() < 1e-9);
    }

    #[test]
    fn open_run_puts_holes_at_both_ends() {
        let mut p = rect_piece(80.0, 40.0, false);
        p.edges[2].stitched = true; // bottom edge
        let c = compute_piece(&p, 1.0, "x".into());
        let r = &c.stitch_runs[0];
        assert!(!r.closed);
        assert!((r.points[0].x - 77.0).abs() < 1e-9 && (r.points[0].y - 37.0).abs() < 1e-9);
        assert_eq!(c.edges[2].hole_count, r.holes.len());
        assert!((c.edges[2].stitch_length_mm - 74.0).abs() < 1e-9);
    }

    #[test]
    fn seam_allowance_grows_the_cut_line() {
        let mut p = rect_piece(50.0, 50.0, false);
        p.seam_allowance_mm = 5.0;
        let c = compute_piece(&p, 1.0, "x".into());
        assert!((c.bounds.width() - 60.0).abs() < 1e-9);
    }
}
