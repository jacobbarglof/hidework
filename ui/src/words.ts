// One list of plain words for Simple mode. The property panel is built by several files; after it
// is drawn, headings, field names and button names that match an entry exactly are swapped for
// the plain version, so the same thing is always called the same thing.

const PLAIN: Record<string, string> = {
  // headings
  "Pattern piece": "This piece",
  Project: "Your project",
  Simulation: "3D test",
  "Materials & cost": "Leather and cost",
  "3D arrangement": "How it is placed in 3D",
  "Holes & hardware": "Holes",
  "Set hardware": "Rivets, snaps and buckles",
  "Surface work": "Stamping and decoration",
  "Bag form (3D)": "Bag shape for the 3D view",
  "Glued layers": "Glue two pieces together",
  Laminate: "Glue two pieces together",
  Laminates: "Glue two pieces together",
  Construction: "Kind of seam",
  Bonding: "Glue on this seam",
  Join: "Seam",
  Joins: "Seams",
  "Fold line": "Fold",
  "Physical properties": "How the leather behaves (advanced)",
  Fabric: "Leather",
  Fabrics: "Leathers",
  // field names
  "Cut ×": "How many to cut",
  "Grain °": "Grain direction, degrees",
  Allowance: "Seam allowance",
  "From edge": "Stitches from the edge",
  "Iron, mm": "Stitch spacing, mm",
  "Hole, mm": "Stitch hole size, mm",
  "Slit, mm": "Lacing slit size, mm",
  "Place on": "Where it goes in 3D",
  "Shift across": "Move across",
  "Shift down": "Move down",
  "Out from form": "Distance out from the bag",
  "Cutting waste, %": "Extra leather for waste, %",
  "Glue band, mm": "Width of the glue, mm",
  Seam: "Kind of seam",
  "Glued to": "Glued onto",
  // buttons
  "Glue face to face": "Glue these two together",
  Lining: "Add a lining",
  "Remove seam": "Remove this seam",
  "Delete piece": "Delete this piece",
  "Delete point": "Delete this corner point",
  "Fabric test…": "Test how it bends…",
  Skive: "Thinned",
  "Stitch line": "Stitching line",
};

/** Swap jargon for plain words inside `root` (headings, labels, buttons, table headings). */
export function plainWords(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("h2, .field-label, button, th, .back, summary").forEach((el) => {
    // Only elements whose whole text is one known phrase, so sentences are never cut up.
    if (el.childElementCount) return;
    const t = el.textContent?.trim() ?? "";
    const p = PLAIN[t];
    if (p) el.textContent = p;
  });
}
