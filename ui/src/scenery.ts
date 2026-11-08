// The 3D window's surroundings, modelled on Fusion 360: a light studio gradient that keeps dark
// leather easy to read, a ground grid with red and green axes, and a ViewCube in the corner that
// turns the view to a face, edge or corner when clicked.

import * as THREE from "three";
import { icon } from "./icons";

/** Light grey-blue at the top to near white at the horizon, like Fusion's default canvas. */
export function studioBackground(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 512;
  const g = c.getContext("2d")!;
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, "#9fb0c2");
  grd.addColorStop(0.55, "#d9e0e7");
  grd.addColorStop(1, "#f3f5f7");
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Ground grid: 10 mm minor lines, 50 mm major lines, red x and green y axes through the origin. */
export function groundGrid(): THREE.Group {
  const group = new THREE.Group();
  const size = 3000;
  const minor = new THREE.GridHelper(size, size / 10, 0xc4ccd5, 0xc4ccd5);
  const major = new THREE.GridHelper(size, size / 50, 0x9aa5b1, 0x9aa5b1);
  for (const [g, o] of [[minor, 0.35], [major, 0.6]] as [THREE.GridHelper, number][]) {
    g.rotation.x = Math.PI / 2;
    const m = g.material as THREE.Material;
    m.transparent = true;
    m.opacity = o;
    m.depthWrite = false;
    group.add(g);
  }
  const axis = (a: THREE.Vector3, b: THREE.Vector3, color: number) => {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
    line.position.z = 0.05;
    group.add(line);
  };
  axis(new THREE.Vector3(-size / 2, 0, 0), new THREE.Vector3(size / 2, 0, 0), 0xd0453b);
  axis(new THREE.Vector3(0, -size / 2, 0), new THREE.Vector3(0, size / 2, 0), 0x3f9a4a);
  group.renderOrder = -1;
  return group;
}

function faceTexture(label: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, "#f4f6f8");
  grd.addColorStop(1, "#dde3e9");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#8995a2";
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = "#3b4652";
  g.font = "600 24px 'Segoe UI', Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface ViewCube {
  /** Call every frame with the main camera and its orbit target. */
  sync(camera: THREE.Camera, target: THREE.Vector3): void;
}

/**
 * A ViewCube in the top-right corner of `host`. Clicking a face, edge or corner calls `turn` with
 * the direction to look from (unit vector from the target toward the camera, z up).
 */
export function createViewCube(host: HTMLElement, turn: (dir: THREE.Vector3) => void, home: () => void): ViewCube {
  const size = 104;
  const wrap = document.createElement("div");
  wrap.className = "viewcube";
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  const homeBtn = document.createElement("button");
  homeBtn.className = "viewcube-home";
  homeBtn.title = "Turn back to the usual view";
  homeBtn.type = "button";
  homeBtn.setAttribute("aria-label", "Home view");
  // The label shows in Simple mode, where no button is a bare picture.
  homeBtn.append(icon("home", 16), Object.assign(document.createElement("span"), { className: "vc-label", textContent: "Home view" }));
  homeBtn.addEventListener("click", home);
  wrap.appendChild(homeBtn);
  host.appendChild(wrap);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(size, size);
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 20);
  // Built y-up, then turned so its local +y is world +z (the app is z-up).
  const labels = ["RIGHT", "LEFT", "TOP", "BOTTOM", "FRONT", "BACK"];
  const mats = labels.map((l) => new THREE.MeshBasicMaterial({ map: faceTexture(l) }));
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mats);
  cube.rotation.x = Math.PI / 2;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: 0x6b7784 }));
  cube.add(edges);
  scene.add(cube);
  // A compass ring under the cube.
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.45, 1.6, 48), new THREE.MeshBasicMaterial({ color: 0x8a96a3, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  ring.position.z = -1.05;
  scene.add(ring);
  const hover = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), new THREE.MeshBasicMaterial({ color: 0x3d8bd9, transparent: true, opacity: 0.55 }));
  hover.visible = false;
  scene.add(hover);
  const ray = new THREE.Raycaster();
  const dirAt = (ev: MouseEvent): THREE.Vector3 | null => {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const hit = ray.intersectObject(cube, false)[0];
    if (!hit) return null;
    // World-space point on the cube (-1..1): a coordinate near the rim picks an edge or corner.
    const p = hit.point;
    const snap = (v: number) => (v > 0.6 ? 1 : v < -0.6 ? -1 : 0);
    const d = new THREE.Vector3(snap(p.x), snap(p.y), snap(p.z));
    if (d.lengthSq() === 0) return null;
    return d.normalize();
  };
  canvas.addEventListener("mousemove", (ev) => {
    const d = dirAt(ev);
    hover.visible = !!d;
    if (d) hover.position.copy(d).multiplyScalar(1.15);
    canvas.style.cursor = d ? "pointer" : "default";
  });
  canvas.addEventListener("mouseleave", () => (hover.visible = false));
  canvas.addEventListener("click", (ev) => {
    const d = dirAt(ev);
    if (d) turn(d);
  });
  return {
    sync(camera, target) {
      const dir = camera.position.clone().sub(target).normalize();
      cam.position.copy(dir).multiplyScalar(6);
      cam.up.copy(camera.up);
      cam.lookAt(0, 0, 0);
      renderer.render(scene, cam);
    },
  };
}
