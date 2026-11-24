// 3D view of the polygon (prototype): the surface model draped with the IGN
// aerial photo, cut along the polygon like a scale model.
//
// - Grids: MNS and MNT over the polygon's bounding box, at the finest step of
//   POLY_STEPS (0.5 x 2^k, see polygon.js) that keeps at most VIEW_MAX_SIDE
//   cells per side, so the mesh stays light on a phone.
// - Texture: the HR orthophoto over the same bounding box, from the same
//   WMS-R; in EPSG:4326 its pixels are linear in lat / lon like the grid, so
//   texture coordinates are plain fractions of the bounding box.
// - Mesh: one vertex per cell centre, a triangle wherever its three vertices
//   are inside the polygon and usable. Walls hang from every border edge
//   down to a common base: soil (base to MNT), then above ground (MNT to MNS).
// - Axes: x east, y up, z south, in metres, origin at the north-west corner.
//
// Loaded on demand (dynamic import) since three.js weighs ~750 kB. Uses the
// globals of script.js (fetchGrid, unusableCells, layers, constants) and
// polygon.js (POLY_STEPS, polygonGrid helpers).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const VIEW_MAX_SIDE = 512;          // cells per side of the 3D grid
const PHOTO_MAX_SIDE = 2048;        // px per side of the orthophoto
const PHOTO_LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS';
const SOIL_COLOR = 0xb08968;
const ABOVE_COLOR = 0x9b87f5;       // light tint of the polygon violet

let view = null;                    // current scene, see openPolygon3D

export function openPolygon3D(pts) {
    closePolygon3D();
    const modal = document.getElementById('polygon3dModal');
    const status = document.getElementById('polygon3dStatus');
    status.textContent = 'Chargement du relief et de la photo...';
    status.hidden = false;
    showModal('polygon3dModal');

    const controller = new AbortController();
    view = { controller };
    const grid = viewGrid(pts);
    const photo = photoSize(grid);

    Promise.all([
        fetchGridRetrying(MNT_LAYER, grid.bbox, grid.cols, grid.rows, controller.signal),
        fetchGridRetrying(MNS_LAYER, grid.bbox, grid.cols, grid.rows, controller.signal),
        loadPhoto(grid.bbox, photo.w, photo.h, controller.signal)
    ]).then(([mnt, mns, texture]) => {
        if (controller.signal.aborted || modal.style.display === 'none') { texture.dispose(); return; }
        status.hidden = true;
        buildScene(pts, grid, mnt, mns, texture);
    }).catch(err => {
        if (controller.signal.aborted) return;
        status.textContent = `Erreur : ${err.message}`;
        log(`Erreur vue 3D: ${err.message}`, 'error');
    });
}

export function closePolygon3D() {
    if (!view) return;
    view.controller.abort();
    if (view.renderer) {
        view.renderer.setAnimationLoop(null);
        window.removeEventListener('resize', view.onResize);
        view.scene.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (obj.material.map) obj.material.map.dispose();
                obj.material.dispose();
            }
        });
        view.controls.dispose();
        view.renderer.dispose();
        view.renderer.domElement.remove();
    }
    view = null;
}

// Grid of the 3D view: polygonGrid's layout at the finest allowed step with at
// most VIEW_MAX_SIDE cells per side.
function viewGrid(pts) {
    const north = Math.max(...pts.map(p => p.lat));
    const south = Math.min(...pts.map(p => p.lat));
    const west = Math.min(...pts.map(p => p.lon));
    const east = Math.max(...pts.map(p => p.lon));
    const cosLat = Math.cos((north + south) / 2 * Math.PI / 180);
    const widthM = (east - west) * M_PER_DEG_LAT * cosLat;
    const heightM = (north - south) * M_PER_DEG_LAT;
    const step = POLY_STEPS.find(s => Math.max(widthM, heightM) / s <= VIEW_MAX_SIDE)
        ?? Math.max(widthM, heightM) / VIEW_MAX_SIDE;
    const dLat = step / M_PER_DEG_LAT;
    const dLon = step / (M_PER_DEG_LAT * cosLat);
    const cols = Math.max(2, Math.ceil((east - west) / dLon));
    const rows = Math.max(2, Math.ceil((north - south) / dLat));
    return {
        north, west, dLat, dLon, step, cols, rows,
        bbox: [north - rows * dLat, west, north, west + cols * dLon],
        widthM: cols * step, heightM: rows * step
    };
}

function photoSize(grid) {
    const scale = PHOTO_MAX_SIDE / Math.max(grid.widthM, grid.heightM);
    // Not finer than the 20 cm of the orthophoto.
    const k = Math.min(scale, 5);
    return { w: Math.max(2, Math.round(grid.widthM * k)), h: Math.max(2, Math.round(grid.heightM * k)) };
}

// The photo goes through fetchWithDeadline (script.js) like the grids, so a
// stuck request is retried instead of leaving the view on "Chargement".
function loadPhoto(bbox, w, h, signal) {
    const params = new URLSearchParams({
        SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap',
        LAYERS: PHOTO_LAYER, STYLES: '', CRS: 'EPSG:4326',
        BBOX: bbox.map(v => v.toFixed(8)).join(','),
        WIDTH: String(w), HEIGHT: String(h), FORMAT: 'image/jpeg'
    });
    const download = attempt => fetchWithDeadline(`${IGN_WMS_URL}?${params}`, signal, response => {
        if (!response.ok || !(response.headers.get('content-type') || '').startsWith('image/')) {
            throw new Error('orthophoto indisponible');
        }
        return response.blob();
    }).catch(err => {
        if (signal.aborted || attempt >= POLY_RETRIES) throw err;
        return download(attempt + 1);
    });
    return download(0).then(blob => {
        const objectUrl = URL.createObjectURL(blob);
        return new THREE.TextureLoader().loadAsync(objectUrl)
            .finally(() => URL.revokeObjectURL(objectUrl));
    }).then(texture => {
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
    });
}

function buildScene(pts, grid, mnt, mns, texture) {
    const { cols, rows, step } = grid;
    const n = cols * rows;
    const badT = unusableCells(mnt, cols, rows);
    const badS = unusableCells(mns, cols, rows);

    // Usable cells inside the polygon.
    const keep = new Uint8Array(n);
    for (let r = 0; r < rows; r++) {
        for (const [c0, c1] of polygonRowSpans(pts, grid, r)) {
            for (let c = c0; c < c1; c++) {
                const k = r * cols + c;
                keep[k] = !badT[k] && !badS[k] ? 1 : 0;
            }
        }
    }

    let base = Infinity, top = -Infinity;
    for (let k = 0; k < n; k++) {
        if (!keep[k]) continue;
        if (mnt[k] < base) base = mnt[k];
        if (mns[k] > top) top = mns[k];
    }
    if (base === Infinity) {
        const status = document.getElementById('polygon3dStatus');
        status.textContent = 'Aucune donnée d\'altitude dans ce polygone.';
        status.hidden = false;
        return;
    }
    base -= Math.max(2, 0.1 * (top - base));

    // Surface mesh: every cell centre is a vertex; unused ones are harmless.
    const positions = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const k = r * cols + c;
            positions[3 * k] = (c + 0.5) * step;
            positions[3 * k + 2] = (r + 0.5) * step;
            uvs[2 * k] = (c + 0.5) / cols;
            uvs[2 * k + 1] = 1 - (r + 0.5) / rows;
        }
    }
    const index = [];
    const edgeCount = new Map(); // edges used once are the border of the mesh
    const addTri = (a, b, c) => {
        index.push(a, b, c);
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
            const key = p < q ? p * n + q : q * n + p;
            edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        }
    };
    for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
            const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
            // Counter-clockwise seen from above (y up, z south): normals up.
            if (keep[a] && keep[b] && keep[d]) addTri(a, d, b);
            if (keep[b] && keep[d] && keep[e]) addTri(b, d, e);
        }
    }
    const border = [];
    for (const [key, count] of edgeCount) {
        if (count === 1) border.push([Math.floor(key / n), key % n]);
    }

    const surfaceGeo = new THREE.BufferGeometry();
    surfaceGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    surfaceGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    surfaceGeo.setIndex(index);
    texture.anisotropy = 8;
    const surface = new THREE.Mesh(surfaceGeo, new THREE.MeshLambertMaterial({ map: texture }));

    // Walls: two quads per border edge, soil then above ground. The border
    // is a staircase of cell edges, so lighting each edge would stripe the
    // walls; each edge takes instead the shade of the nearest polygon side,
    // drawn unlit.
    const wallPos = new Float32Array(border.length * 2 * 6 * 3);
    const wallCol = new Float32Array(border.length * 2 * 6 * 3);
    const shades = polygonSideShades(pts, grid);
    const soil = new THREE.Color(SOIL_COLOR), above = new THREE.Color(ABOVE_COLOR);
    border.forEach(([p, q], e) => {
        const mx = (positions[3 * p] + positions[3 * q]) / 2;
        const mz = (positions[3 * p + 2] + positions[3 * q + 2]) / 2;
        const shade = shades.at(mx, mz);
        for (let v = 0; v < 12; v++) {
            const col = v < 6 ? soil : above;
            wallCol.set([col.r * shade, col.g * shade, col.b * shade], 3 * (12 * e + v));
        }
    });
    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.BufferAttribute(wallPos, 3));
    wallGeo.setAttribute('color', new THREE.BufferAttribute(wallCol, 3));
    const walls = new THREE.Mesh(wallGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));

    // Scene, camera, light.
    const container = document.getElementById('polygon3dCanvas');
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf6f7fb);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8d7b68, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(-1, 2, -0.5); // from the north-west, high
    scene.add(sun, surface, walls);

    const span = Math.max(grid.widthM, grid.heightM);
    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, span / 1000, span * 20);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.05; // stay above the model

    view = {
        ...view, renderer, scene, camera, controls,
        grid, mnt, mns, keep, base, border, positions, surfaceGeo, wallGeo,
        exaggeration: Number(document.getElementById('polygon3dExag').value),
        model: document.querySelector('#polygon3dModal [data-model].active').dataset.model
    };
    view.onResize = () => {
        renderer.setSize(container.clientWidth, container.clientHeight);
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', view.onResize);

    updateHeights();
    resetCamera();
    const modal = document.getElementById('polygon3dModal');
    renderer.setAnimationLoop(() => {
        // The window can be closed by a click on its backdrop (script.js).
        if (modal.style.display === 'none') { closePolygon3D(); return; }
        controls.update();
        renderer.render(scene, camera);
    });
    document.getElementById('polygon3dInfo').textContent =
        `Relief au pas de ${String(step).replace('.', ',')} m, orthophoto IGN. ` +
        'Parois : sol en brun (socle au MNT), sursol en violet (MNT au MNS).';
}

// Shade of the walls along each side of the polygon, from its outward normal
// and a horizontal light from the south-west (the default camera looks from
// the south): at(x, z) gives the shade of the side nearest to that point.
const WALL_LIGHT = [-0.6, 0.8]; // x east, z south, normalised
function polygonSideShades(pts, grid) {
    const local = pts.map(p => [
        (p.lon - grid.west) / grid.dLon * grid.step,
        (grid.north - p.lat) / grid.dLat * grid.step
    ]);
    const inside = (x, z) => {
        let hit = false;
        for (let i = 0, j = local.length - 1; i < local.length; j = i++) {
            const [xi, zi] = local[i], [xj, zj] = local[j];
            if ((zi > z) !== (zj > z) && x < xi + (z - zi) * (xj - xi) / (zj - zi)) hit = !hit;
        }
        return hit;
    };
    const sides = local.map((a, i) => {
        const b = local[(i + 1) % local.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        let n = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (inside(mid[0] + n[0] * 0.5, mid[1] + n[1] * 0.5)) n = [-n[0], -n[1]];
        const shade = 0.75 + 0.25 * (n[0] * WALL_LIGHT[0] + n[1] * WALL_LIGHT[1]);
        return { a, b, shade };
    });
    const dist2 = (x, z, a, b) => {
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
        return (x - a[0] - t * dx) ** 2 + (z - a[1] - t * dz) ** 2;
    };
    return {
        at(x, z) {
            let best = sides[0], bestD = Infinity;
            for (const side of sides) {
                const d = dist2(x, z, side.a, side.b);
                if (d < bestD) { bestD = d; best = side; }
            }
            return best.shade;
        }
    };
}

// Heights of the surface and walls, from the chosen model and exaggeration.
function updateHeights() {
    const { grid, mnt, mns, keep, base, border, positions, surfaceGeo, wallGeo, exaggeration } = view;
    const topZ = view.model === 'mns' ? mns : mnt;
    const y = z => (z - base) * exaggeration;
    for (let k = 0; k < keep.length; k++) positions[3 * k + 1] = keep[k] ? y(topZ[k]) : 0;
    surfaceGeo.attributes.position.needsUpdate = true;
    surfaceGeo.computeVertexNormals();
    surfaceGeo.computeBoundingSphere();

    const w = wallGeo.attributes.position.array;
    const xz = k => [positions[3 * k], positions[3 * k + 2]];
    let o = 0;
    const quad = (p, q, yp0, yq0, yp1, yq1) => {
        const [px, pz] = xz(p), [qx, qz] = xz(q);
        w.set([px, yp0, pz, qx, yq0, qz, qx, yq1, qz, px, yp0, pz, qx, yq1, qz, px, yp1, pz], o);
        o += 18;
    };
    for (const [p, q] of border) {
        quad(p, q, 0, 0, y(mnt[p]), y(mnt[q]));
        quad(p, q, y(mnt[p]), y(mnt[q]), y(topZ[p]), y(topZ[q]));
    }
    wallGeo.attributes.position.needsUpdate = true;
    wallGeo.computeBoundingSphere();
}

function resetCamera() {
    const { grid, camera, controls } = view;
    // Farther back in a portrait frame, whose horizontal field is narrower.
    const span = Math.max(grid.widthM, grid.heightM) * Math.max(1, 1 / camera.aspect);
    const cy = view.surfaceGeo.boundingSphere.center.y;
    controls.target.set(grid.widthM / 2, cy, grid.heightM / 2);
    // From the south, 35 degrees above the horizon.
    camera.position.set(grid.widthM / 2, cy + span * 0.75, grid.heightM / 2 + span * 1.1);
    controls.update();
}

export function setPolygon3DModel(model) {
    if (!view || !view.renderer) return;
    view.model = model;
    document.querySelectorAll('#polygon3dModal [data-model]').forEach(b => {
        b.classList.toggle('active', b.dataset.model === model);
    });
    updateHeights();
}

export function setPolygon3DExaggeration(value) {
    document.getElementById('polygon3dExagValue').textContent = `×${Number(value).toFixed(1).replace('.', ',')}`;
    if (!view || !view.renderer) return;
    view.exaggeration = Number(value);
    updateHeights();
}

export function resetPolygon3DView() {
    if (view && view.renderer) resetCamera();
}
