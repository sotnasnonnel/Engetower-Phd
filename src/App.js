// App3DAnnotations.jsx
import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

/* =========================
   Supabase (preencha os seus)
   ========================= */
const SUPABASE_URL = "https://hkhqoxigwkuhrccwaght.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhraHFveGlnd2t1aHJjY3dhZ2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2MTg1NzQsImV4cCI6MjA3MzE5NDU3NH0.mJJGbu2BrR6aLlov2yjbGnBjWJVKeGHtdXGwK_e9M7A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* =========================
   Config / Constantes
   ========================= */
const ENGE_JSON_PATH = "/dados_engeviewer_completo.json"; // coloque em public/
const ENGE_GLOBAL_KEY = "__enge_index_cache__";

const DEFAULT_SEVERITIES = ["Baixa", "Média", "Alta", "Crítica"];
const DEFAULT_STATUSES = ["Aberto", "Em andamento", "Resolvido", "Ignorado"];
const DEFAULT_ISSUES = [
  "Parafuso faltando",
  "Peça desalinhada",
  "Oxidação",
  "Cabos frouxos",
  "Base fora de prumo",
  "Outro",
];
const STATUS_COLORS = {
  Aberto: 0xff5555,
  "Em andamento": 0xffcc66,
  Resolvido: 0x66cc66,
  Ignorado: 0x999999,
};

/* =========================
   Utils
   ========================= */
const norm = (v) => (v == null ? "" : String(v).trim());

function humanFileSize(bytes) {
  const thresh = 1024;
  if (Math.abs(bytes) < thresh) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let u = -1;
  do {
    bytes /= thresh;
    ++u;
  } while (Math.abs(bytes) >= thresh && u < units.length - 1);
  return bytes.toFixed(1) + " " + units[u];
}

function downloadBlob(data, filename, mimeType) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// torna persistível sem fotos base64 pesadas
const makePersistableAnnotations = (anns) =>
  (anns || []).map((a) => ({
    ...a,
    photos: (a.photos || []).map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      createdAt: p.createdAt,
    })),
  }));

function persistAnnotations(key, anns) {
  try {
    localStorage.setItem(key, JSON.stringify(makePersistableAnnotations(anns)));
  } catch (_) {
    try {
      localStorage.setItem(key, JSON.stringify(makePersistableAnnotations(anns.slice(0, 50))));
    } catch {}
  }
}

function readPersistedAnnotations(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.annotations)) return data.annotations;
    return null;
  } catch {
    return null;
  }
}

/* =========================
   Índice ENGE (carrega 1x)
   ========================= */
const pickMeta = (row) => ({
  type: row?.type ?? "",
  component: row?.component ?? "",
  profile: row?.profile ?? "",
  position: row?.position ?? "",
  handle: row?.handle ?? "",
  quadrant: row?.quadrant ?? "",
  lt_id: row?.lt_id ?? "",
  tower_id: row?.tower_id ?? "",
});

function extractKey(row) {
  return (
    row?.upld ??
    row?.upId ??
    row?.UPLD ??
    row?.UPID ??
    row?.upid ??
    row?.uplId ??
    null
  );
}

async function loadEngeIndexOnce() {
  if (window[ENGE_GLOBAL_KEY]) return window[ENGE_GLOBAL_KEY];

  const res = await fetch(ENGE_JSON_PATH, { cache: "force-cache" });
  if (!res.ok) throw new Error("Falha ao carregar dados_engeviewer_completo.json");
  const data = await res.json();

  const index = new Map();
  const components = new Set();

  if (Array.isArray(data)) {
    for (const row of data) {
      const k = extractKey(row);
      if (!k) continue;
      const key = norm(k);
      if (!index.has(key)) index.set(key, pickMeta(row));
      if (row?.component) components.add(String(row.component));
    }
  }

  const payload = { index, components: [...components].sort((a, b) => a.localeCompare(b)) };
  window[ENGE_GLOBAL_KEY] = payload;
  return payload;
}

/* =========================
   Upload de foto → Supabase
   ========================= */
async function uploadPhoto(file, pieceId) {
  const safeName = file.name?.replace(/\s+/g, "_") || "photo.jpg";
  const path = `${pieceId}/${Date.now()}-${safeName}`;
  const { error } = await supabase.storage.from("photos").upload(path, file, { upsert: false });
  if (error) throw error;
  const { data: pub } = supabase.storage.from("photos").getPublicUrl(path);
  return pub?.publicUrl;
}

/* =====================================================
   Componente principal
   ===================================================== */
export default function App3DAnnotations() {
  // viewer
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  // estados
  const [modelInfo, setModelInfo] = useState({ name: "", size: 0 });
  const [modelGroup, setModelGroup] = useState(null);
  const [pinsGroup] = useState(() => new THREE.Group());
  const [annotations, setAnnotations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [isPlacing, setIsPlacing] = useState(false);
  const [isIsolationMode, setIsIsolationMode] = useState(false);
  const [isolatedUuid, setIsolatedUuid] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [mtlHint, setMtlHint] = useState(null);
  const [showTutorial, setShowTutorial] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);

  // índice ENGE (mapeamento upld -> meta) e filtro
  const [engeIndex, setEngeIndex] = useState(null); // Map
  const [componentOptions, setComponentOptions] = useState([]); // string[]
  const [componentFilter, setComponentFilter] = useState("");

  // photo viewer
  const [photoViewer, setPhotoViewer] = useState({ open: false, url: "", name: "" });

  // refs vivas
  const isPlacingRef = useRef(false);
  const modelGroupRef = useRef(null);
  const isIsolationModeRef = useRef(false);
  const annotationsRef = useRef(annotations);
  useEffect(() => (isPlacingRef.current = isPlacing), [isPlacing]);
  useEffect(() => (modelGroupRef.current = modelGroup), [modelGroup]);
  useEffect(() => (isIsolationModeRef.current = isIsolationMode), [isIsolationMode]);
  useEffect(() => (annotationsRef.current = annotations), [annotations]);

  /* ----- carregar índice ENGE apenas 1x ----- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { index, components } = await loadEngeIndexOnce();
        if (!alive) return;
        setEngeIndex(index);
        setComponentOptions(components);
      } catch (e) {
        console.error("Erro carregando índice Engeviewer:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ----- helpers 3D / cores ----- */
  const colorizePiece = useCallback((object, color) => {
    if (!object) return;
    object.traverse((child) => {
      if (child.isMesh) {
        if (!child.userData.originalMaterial) child.userData.originalMaterial = child.material;
        child.material = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.7,
          metalness: 0.1,
        });
        child.material.needsUpdate = true;
      }
    });
  }, []);

  const restoreOriginalColor = useCallback((object) => {
    if (!object) return;
    object.traverse((child) => {
      if (child.isMesh && child.userData.originalMaterial) {
        child.material = child.userData.originalMaterial;
        child.material.needsUpdate = true;
      }
    });
  }, []);

  const colorizePieceByStatus = useCallback(
    (pieceName, status) => {
      if (!modelGroupRef.current) return;
      let targetPiece = null;
      modelGroupRef.current.traverse((child) => {
        if (child.name === pieceName && child.isMesh) targetPiece = child;
      });
      if (targetPiece) {
        const color = STATUS_COLORS[status] || 0x0070f3;
        colorizePiece(targetPiece, color);
      }
    },
    [colorizePiece]
  );

  const restorePieceColor = useCallback(
    (pieceName) => {
      if (!modelGroupRef.current) return;
      let targetPiece = null;
      modelGroupRef.current.traverse((child) => {
        if (child.name === pieceName && child.isMesh) targetPiece = child;
      });
      if (targetPiece) restoreOriginalColor(targetPiece);
    },
    [restoreOriginalColor]
  );

  /* ----- viewer init (sem sombra dura) ----- */
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 10000);
    camera.position.set(3, 2, 4);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.domElement.style.touchAction = "none";
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(5, 10, 7);
    scene.add(dir);

    const grid = new THREE.GridHelper(20, 20, 0x233344, 0x1a2a38);
    grid.material.opacity = 0.25;
    grid.material.transparent = true;
    scene.add(grid);

    pinsGroup.name = "__pins__";
    scene.add(pinsGroup);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.rotateSpeed = 0.7;
    controls.panSpeed = 0.9;
    controls.zoomSpeed = 0.9;
    controlsRef.current = controls;

    const onResize = () => {
      requestAnimationFrame(() => {
        if (!mount || !cameraRef.current || !rendererRef.current) return;
        const w = mount.clientWidth;
        const h = mount.clientHeight;
        rendererRef.current.setSize(w, h);
        cameraRef.current.aspect = w / h;
        cameraRef.current.updateProjectionMatrix();
      });
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    const getPieceRoot = (obj) => {
      let cur = obj;
      const root = modelGroupRef.current;
      while (cur && cur.parent && cur.parent !== root) cur = cur.parent;
      return cur || obj;
    };
    const applyIsolation = (targetRoot) => {
      if (!modelGroupRef.current) return;
      const keep = new Set();
      targetRoot.traverse((n) => n.isMesh && keep.add(n));
      modelGroupRef.current.traverse((n) => {
        if (!n.isMesh) return;
        if (keep.has(n)) colorizePiece(n, 0x3399ff);
        else {
          const faded = n.material.clone();
          faded.transparent = true;
          faded.opacity = 0.1;
          faded.depthWrite = false;
          n.material = faded;
        }
      });
      setIsolatedUuid(targetRoot.uuid);
    };

    const onClick = (event) => {
      if (!modelGroupRef.current || !cameraRef.current || !rendererRef.current) return;
      const rect = rendererRef.current.domElement.getBoundingClientRect();
      const mx = (event.clientX - rect.left) / rect.width;
      const my = (event.clientY - rect.top) / rect.height;
      const mouse = new THREE.Vector2(mx * 2 - 1, -(my * 2 - 1));
      raycaster.setFromCamera(mouse, cameraRef.current);
      const intersects = raycaster.intersectObjects(modelGroupRef.current.children, true);
      if (intersects.length === 0) return;
      const hit = intersects[0];

      const root = getPieceRoot(hit.object);
      if (isIsolationModeRef.current) applyIsolation(root);
      if (!isPlacingRef.current) return;

      const id = uuidv4();
      const normal =
        hit.face && hit.object
          ? hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
          : new THREE.Vector3(0, 1, 0);

      // chave crua (upld) do OBJ
      const objectKeyRaw = root?.name || hit.object.name || "";
      const objectKey = norm(objectKeyRaw);

      // mapeia pelo índice ENGE
      let displayName = objectKey;
      let meta = null;
      if (engeIndex && engeIndex.has(objectKey)) {
        meta = engeIndex.get(objectKey);
        if (meta?.type) displayName = String(meta.type);
      }

      // evita duplicidade por peça exibida
      if (annotationsRef.current.some((a) => a.objectKey === objectKey)) {
        alert("Já existe uma anotação para esta peça. Edite a anotação existente.");
        return;
      }

      const ann = {
        id,
        position: [hit.point.x, hit.point.y, hit.point.z],
        normal: [normal.x, normal.y, normal.z],
        objectKey, // upld (nome do mesh no OBJ)
        objectName: displayName, // mostrado (type se houver; senão, upld)
        meta, // {lt_id, handle, position, profile, quadrant, component, tower_id, type}
        issueType: DEFAULT_ISSUES[0],
        severity: DEFAULT_SEVERITIES[1],
        status: DEFAULT_STATUSES[0],
        note: "",
        photos: [],
        createdAt: new Date().toISOString(),
      };

      addPin(ann);
      setAnnotations((prev) => [ann, ...prev]);
      setSelectedId(id);
      colorizePieceByStatus(objectKey, ann.status);
    };
    renderer.domElement.addEventListener("click", onClick, { passive: true });

    let rafId;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      renderer.domElement.removeEventListener("click", onClick);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement?.parentElement?.removeChild(renderer.domElement);
    };
  }, [colorizePiece, colorizePieceByStatus, engeIndex]);

  /* ----- load OBJ/MTL ----- */
  async function handleLoadOBJFromFiles(objFile, mtlFile) {
    setLoading(true);
    try {
      const objText = await objFile.text();
      const loader = new OBJLoader();

      if (mtlFile) {
        const mtlText = await mtlFile.text();
        const mtlLoader = new MTLLoader();
        const materials = mtlLoader.parse(mtlText, "");
        materials.preload();
        loader.setMaterials(materials);
      }

      const group = loader.parse(objText);
      group.name = objFile.name.toLowerCase().endsWith(".obj") ? objFile.name.slice(0, -4) : objFile.name;
      group.traverse((child) => {
        if (child.isMesh && child.material) {
          child.castShadow = false;
          child.receiveShadow = false;
          child.material.side = THREE.FrontSide;
          child.material.needsUpdate = true;
        }
      });

      if (modelGroup) sceneRef.current.remove(modelGroup);
      setAnnotations([]);
      clearPins();
      clearIsolation();

      sceneRef.current.add(group);
      setModelGroup(group);
      modelGroupRef.current = group;
      setModelInfo({ name: objFile.name, size: objFile.size });

      fitCameraToObject(cameraRef.current, group, controlsRef.current, 1.3);

      const firstMtllib = objText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.toLowerCase().startsWith("mtllib "));
      const hinted = firstMtllib ? firstMtllib.slice(7).trim() : null;
      setMtlHint(!mtlFile && hinted ? hinted : null);
    } catch (e) {
      console.error(e);
      alert("Falha ao carregar o OBJ. Verifique o arquivo.");
    } finally {
      setLoading(false);
    }
  }

  /* ----- pins & isolation helpers ----- */
  function clearPins() {
    [...pinsGroup.children].forEach((c) => pinsGroup.remove(c));
  }
  function addPin(ann) {
    const color = STATUS_COLORS[ann.status] || 0x0070f3;
    const geo = new THREE.SphereGeometry(0.02, 16, 16);
    const mat = new THREE.MeshStandardMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(ann.position[0], ann.position[1], ann.position[2]);
    mesh.userData.annotationId = ann.id;
    pinsGroup.add(mesh);
  }
  function clearIsolation() {
    if (!modelGroupRef.current) return;
    modelGroupRef.current.traverse((n) => {
      if (!n.isMesh || !n.userData?.originalMaterial) return;
      n.material = n.userData.originalMaterial;
      n.material.needsUpdate = true;
    });
    setIsolatedUuid(null);
  }
  function findPieceForAnnotation(ann) {
    if (!modelGroupRef.current || !ann) return null;
    const name = ann.objectKey || ann.objectName;
    if (name) {
      let byName = null;
      modelGroupRef.current.traverse((n) => {
        if (!byName && n.name && n.name === name) byName = n;
      });
      if (byName) return byName;
    }
    return null;
  }
  function fitCameraToObject(camera, object, controls, offset = 1.25) {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z);
    const fitHeightDistance = maxSize / (2 * Math.tan((Math.PI * camera.fov) / 360));
    const fitWidthDistance = fitHeightDistance / camera.aspect;
    const distance = offset * Math.max(fitHeightDistance, fitWidthDistance);
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(center);
    camera.near = Math.max(0.1, distance / 100);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    camera.position.copy(center.clone().add(dir.multiplyScalar(distance)));
    controls.update();
  }

  /* ----- update visuals pins ----- */
  useEffect(() => {
    pinsGroup.children.forEach((mesh) => {
      const id = mesh.userData.annotationId;
      const ann = annotations.find((a) => a.id === id);
      if (!ann) return;
      const color = STATUS_COLORS[ann.status] || 0x0070f3;
      mesh.material.color.set(color);
      mesh.scale.setScalar(selectedId === id ? 1.6 : 1.0);
    });
  }, [annotations, selectedId, pinsGroup]);

  /* ----- ações ----- */
  function onSelectAnnotation(id) {
    setSelectedId(id);
    const ann = annotations.find((a) => a.id === id);
    if (!ann) return;

    if (isIsolationModeRef.current) {
      const piece = findPieceForAnnotation(ann);
      if (piece) {
        // aplica isolamento simples (destaca selecionada e esmaece outras)
        modelGroupRef.current.traverse((n) => {
          if (!n.isMesh) return;
          if (n === piece || piece.parent === n || n.parent === piece) colorizePiece(n, 0x3399ff);
          else {
            const faded = n.material.clone();
            faded.transparent = true;
            faded.opacity = 0.1;
            faded.depthWrite = false;
            n.material = faded;
          }
        });
        setIsolatedUuid(piece.uuid);
      }
    }

    if (ann.objectKey) colorizePieceByStatus(ann.objectKey, ann.status);

    const controls = controlsRef.current;
    const cam = cameraRef.current;
    const dist = cam.position.distanceTo(controls.target);
    let targetPos = null;
    const pin = pinsGroup.children.find((m) => m.userData.annotationId === id);
    if (pin) targetPos = pin.position.clone();
    else if (ann.position) targetPos = new THREE.Vector3(ann.position[0], ann.position[1], ann.position[2]);

    if (targetPos) {
      controls.target.copy(targetPos);
      const dir = cam.position.clone().sub(controls.target).normalize();
      cam.position.copy(controls.target.clone().add(dir.multiplyScalar(dist)));
      controls.update();
    }
  }

  function onDeleteAnnotation(id) {
    const ann = annotations.find((a) => a.id === id);
    if (ann?.objectKey) restorePieceColor(ann.objectKey);
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    const idx = pinsGroup.children.findIndex((m) => m.userData.annotationId === id);
    if (idx >= 0) pinsGroup.remove(pinsGroup.children[idx]);
    if (selectedId === id) setSelectedId(null);
  }

  function onUpdateAnnotation(id, patch) {
    setAnnotations((prev) => {
      const updated = prev.map((a) => (a.id === id ? { ...a, ...patch } : a));
      if (patch.status) {
        const ann = updated.find((a) => a.id === id);
        if (ann?.objectKey) colorizePieceByStatus(ann.objectKey, patch.status);
      }
      return updated;
    });
  }

  async function handleAddPhoto(annotationId, file) {
    try {
      const url = await uploadPhoto(file, annotationId);
      if (!url) throw new Error("URL pública não retornada.");
      setAnnotations((prev) =>
        prev.map((a) =>
          a.id === annotationId
            ? {
                ...a,
                photos: [
                  ...(a.photos || []),
                  { id: uuidv4(), name: file.name, url, createdAt: new Date().toISOString() },
                ],
              }
            : a
        )
      );
      alert("Foto enviada com sucesso!");
    } catch (err) {
      console.error("Erro ao enviar foto:", err);
      alert("Falha ao enviar a foto. Veja o console para detalhes.");
    }
  }

  /* ----- remap com índice quando ele chega (para anotações antigas/localStorage) ----- */
  function remapWithIndex(arr, idx) {
    if (!idx) return arr;
    return (arr || []).map((a) => {
      const key = norm(a.objectKey || a.objectName || "");
      const m = idx.get(key);
      if (m) {
        return { ...a, objectKey: key, objectName: m.type || key, meta: { ...m } };
      }
      return { ...a, objectKey: key };
    });
  }
  useEffect(() => {
    if (!engeIndex || !annotations.length) return;
    setAnnotations((prev) => remapWithIndex(prev, engeIndex));
  }, [engeIndex]); // eslint-disable-line

  /* ----- export / import / screenshot ----- */
  function onExportJSON() {
    const payload = { model: modelInfo.name, exportedAt: new Date().toISOString(), annotations };
    downloadBlob(JSON.stringify(payload, null, 2), (modelInfo.name || "modelo") + ".anotacoes.json", "application/json");
  }

  async function onExportXLSX() {
    if (!annotations.length) return alert("Nenhuma anotação para exportar!");
    const rows = filteredAnnotations.map((ann, idx) => ({
      "#": idx + 1,
      ID: ann.id,
      Modelo: modelInfo.name || "",
      "Criado em": new Date(ann.createdAt).toLocaleString(),
      "Peça (exibida)": ann.objectName || "",
      upld: ann.objectKey || "",
      Tipo: ann.issueType || "",
      Severidade: ann.severity || "",
      Status: ann.status || "",
      Componente: ann.meta?.component || "",
      Handle: ann.meta?.handle || "",
      Posição: ann.meta?.position || "",
      Perfil: ann.meta?.profile || "",
      Quadrante: ann.meta?.quadrant ?? "",
      "LT ID": ann.meta?.lt_id ?? "",
      "Tower ID": ann.meta?.tower_id ?? "",
      Observações: ann.note || "",
      Fotos: (ann.photos || []).map((p) => p.url).join("\n"),
      "Posição (x,y,z)": Array.isArray(ann.position) ? ann.position.map((n) => +n).join(", ") : "",
      "Normal (x,y,z)": Array.isArray(ann.normal) ? ann.normal.map((n) => +n).join(", ") : "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Anotações");
    const ab = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([ab], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    downloadBlob(blob, (modelInfo.name || "modelo") + ".anotacoes.xlsx", blob.type);
  }

  function onImportJSON(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        if (!Array.isArray(data.annotations)) throw new Error("JSON inválido");
        setAnnotations(remapWithIndex(data.annotations, engeIndex));
        clearPins();
        data.annotations.forEach(addPin);
        data.annotations.forEach((ann) => {
          const key = ann.objectKey || ann.objectName;
          if (key) colorizePieceByStatus(key, ann.status);
        });
        alert("Anotações importadas: " + data.annotations.length);
      } catch {
        alert("Falha ao ler JSON de anotações.");
      }
    };
    fr.readAsText(file);
  }

  function onScreenshot() {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.domElement.toBlob((blob) => blob && downloadBlob(blob, "screenshot.png", "image/png"));
  }

  /* ----- persistência por modelo ----- */
  useEffect(() => {
    if (!modelInfo.name) return;
    const key = "ann:" + modelInfo.name;
    const saved = readPersistedAnnotations(key);
    if (saved) {
      clearPins();
      const remapped = remapWithIndex(saved, engeIndex);
      setAnnotations(remapped);
      remapped.forEach(addPin);
      remapped.forEach((a) => a.objectKey && colorizePieceByStatus(a.objectKey, a.status));
    }
  }, [modelInfo.name, engeIndex]); // eslint-disable-line

  useEffect(() => {
    if (!modelInfo.name) return;
    persistAnnotations("ann:" + modelInfo.name, annotations);
  }, [annotations, modelInfo.name]);

  /* ----- filtro por component ----- */
  const filteredAnnotations = useMemo(
    () =>
      annotations.filter((a) => !componentFilter || (a.meta?.component || "") === componentFilter),
    [annotations, componentFilter]
  );

  /* ----- UI helpers ----- */
  function handleFilesChosen(files) {
    const arr = Array.from(files || []);
    const obj = arr.find((f) => f.name.toLowerCase().endsWith(".obj"));
    const mtl = arr.find((f) => f.name.toLowerCase().endsWith(".mtl"));
    if (!obj) return alert("Selecione um arquivo .obj (e opcionalmente .mtl).");
    handleLoadOBJFromFiles(obj, mtl || null);
  }

  /* =========================
     UI
     ========================= */
  return (
    <div className="w-full h-screen flex flex-col bg-[#0b0f14] text-white overflow-hidden">
      {/* App Bar */}
      <div className="sticky top-0 z-20 bg-[#0d131a]/90 backdrop-blur border-b border-white/10">
        <div className="flex items-center gap-3 p-3">
          <label className="px-4 py-2 rounded-lg bg-[#26405d] hover:bg-[#31587f] transition cursor-pointer">
            📁 Carregar Modelo
            <input type="file" accept=".obj,.mtl" className="hidden" multiple onChange={(e) => handleFilesChosen(e.target.files)} />
          </label>

          <button
            onClick={() => setIsPlacing((v) => !v)}
            className={`px-4 py-2 rounded-lg transition ${
              isPlacing ? "bg-[#00a49a] text-black" : "bg-[#18212b] hover:bg-[#1b2631] border border-white/10"
            }`}
            title="Toque no modelo para marcar"
          >
            {isPlacing ? "📍 Marcando…" : "📌 Anotar"}
          </button>

          <button
            onClick={() => setIsIsolationMode((v) => !v)}
            className={`px-4 py-2 rounded-lg transition ${
              isIsolationMode ? "bg-[#b85236]" : "bg-[#18212b] hover:bg-[#1b2631] border border-white/10"
            }`}
            title="Isolar peças ao clicar"
          >
            {isIsolationMode ? "🔍 Isolando" : "🔍 Isolar"}
          </button>

          <button
            onClick={() =>
              modelGroupRef.current &&
              fitCameraToObject(cameraRef.current, modelGroupRef.current, controlsRef.current, 1.25)
            }
            className="px-4 py-2 rounded-lg bg-[#18212b] hover:bg-[#1b2631] border border-white/10"
            title="Enquadrar modelo"
          >
            🎯 Enquadrar
          </button>

          <div className="ml-auto text-sm text-white/80">
            {modelInfo.name ? (
              <>
                <span className="font-medium">Modelo:</span> {modelInfo.name} · {humanFileSize(modelInfo.size)}
              </>
            ) : (
              "Carregue um arquivo .obj (e .mtl) para começar"
            )}
          </div>
        </div>
      </div>

      {/* Área 3D */}
      <div className="flex-1 relative">
        <div ref={mountRef} className="absolute inset-0" />
        {/* FABs */}
        <div className="absolute bottom-6 right-6 flex flex-col gap-3">
          <button
            onClick={onScreenshot}
            className="w-14 h-14 rounded-full bg-[#18212b] border border-white/10 hover:bg-[#1b2631] grid place-items-center"
          >
            📸
          </button>
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="w-14 h-14 rounded-full bg-[#18212b] border border-white/10 hover:bg-[#1b2631] grid place-items-center"
          >
            {sidebarCollapsed ? "📋" : "✕"}
          </button>
        </div>

        {loading && (
          <div className="absolute inset-0 grid place-items-center bg-black/60 z-30">
            <div className="animate-pulse text-base bg-[#0f141a] rounded-xl shadow px-6 py-4 border border-white/10">
              Carregando modelo…
            </div>
          </div>
        )}

        {/* Photo Viewer */}
        {photoViewer.open && (
          <div className="absolute inset-0 z-40 bg-black/90 grid place-items-center p-4">
            <button
              onClick={() => setPhotoViewer({ open: false, url: "", name: "" })}
              className="absolute top-4 right-4 bg-white/10 text-white backdrop-blur px-4 py-2 rounded-full border border-white/20"
            >
              Fechar ✕
            </button>
            <img
              src={photoViewer.url}
              alt={photoViewer.name || "Foto"}
              className="max-h-[90vh] max-w-[92vw] object-contain rounded-xl shadow-2xl"
            />
            {photoViewer.name && (
              <div className="absolute bottom-5 left-1/2 -translate-x-1/2 text-white/90 text-sm bg-white/10 backdrop-blur px-3 py-1 rounded-full">
                {photoViewer.name}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div
        className={`absolute right-0 top-0 bottom-0 w-full max-w-md bg-[#0f141a] border-l border-white/10 z-30 transform transition-transform duration-300 ${
          sidebarCollapsed ? "translate-x-full" : "translate-x-0"
        }`}
      >
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Anotações</div>
            <div className="text-xs text-white/60">{filteredAnnotations.length} item(s)</div>
          </div>
          <div className="flex gap-2">
            <button onClick={onExportJSON} className="px-3 py-2 rounded bg-[#18212b] border border-white/10 hover:bg-[#1b2631] text-sm">
              JSON
            </button>
            <button onClick={onExportXLSX} className="px-3 py-2 rounded bg-[#00a49a] text-black hover:brightness-95 text-sm">
              Excel
            </button>
            <button onClick={() => setSidebarCollapsed(true)} className="px-3 py-2 rounded bg-[#18212b] border border-white/10 hover:bg-[#1b2631]">
              ✕
            </button>
          </div>
        </div>

        {/* Import */}
        <div className="p-4 border-b border-white/10">
          <label className="block text-sm text-white/80 mb-2">Importar anotações (JSON)</label>
          <input
            type="file"
            accept="application/json"
            onChange={(e) => e.target.files?.[0] && onImportJSON(e.target.files[0])}
            className="block w-full text-sm p-2 bg-[#0b0f14] border border-white/10 rounded"
          />
        </div>

        {/* Filtro por component */}
        <div className="p-4 border-b border-white/10">
          <label className="block text-sm text-white/80 mb-2">Filtrar por Component</label>
          <select
            value={componentFilter}
            onChange={(e) => setComponentFilter(e.target.value)}
            className="w-full rounded bg-[#0b0f14] border border-white/10 text-sm p-2"
          >
            <option value="">— Todos —</option>
            {componentOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {/* Lista */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {filteredAnnotations.map((ann) => (
            <div
              key={ann.id}
              className={`rounded-xl border ${selectedId === ann.id ? "border-[#00a49a]" : "border-white/10"} bg-[#0b0f14] p-4`}
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <button onClick={() => onSelectAnnotation(ann.id)} className="text-left flex-1">
                  <div className="text-base font-semibold">{ann.issueType}</div>
                  <div className="text-xs text-white/70">Peça (exibida): {ann.objectName || "-"}</div>
                  <div className="text-[11px] text-white/50">upld: {ann.objectKey || "-"}</div>
                  <div className="text-xs text-white/50 mt-1">{new Date(ann.createdAt).toLocaleString()}</div>
                </button>
                <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-[#18212b]">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: `#${(STATUS_COLORS[ann.status] || 0x0070f3).toString(16).padStart(6, "0")}` }}
                  />
                  {ann.status}
                </span>
              </div>

              {/* Metadados do ENGE */}
              <div className="grid grid-cols-2 gap-3 mb-3 text-xs">
                <div><span className="text-white/60">Component:</span> {ann.meta?.component || "-"}</div>
                <div><span className="text-white/60">Handle:</span> {ann.meta?.handle || "-"}</div>
                <div><span className="text-white/60">Posição:</span> {ann.meta?.position || "-"}</div>
                <div><span className="text-white/60">Perfil:</span> {ann.meta?.profile || "-"}</div>
                <div><span className="text-white/60">Quadrante:</span> {ann.meta?.quadrant ?? "-"}</div>
                <div><span className="text-white/60">LT ID:</span> {ann.meta?.lt_id ?? "-"}</div>
                <div><span className="text-white/60">Tower ID:</span> {ann.meta?.tower_id ?? "-"}</div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-white/70 mb-1">Tipo</label>
                  <select
                    value={ann.issueType}
                    onChange={(e) => onUpdateAnnotation(ann.id, { issueType: e.target.value })}
                    className="w-full rounded border border-white/10 bg-[#0f141a] text-sm p-2"
                  >
                    {DEFAULT_ISSUES.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-white/70 mb-1">Severidade</label>
                  <select
                    value={ann.severity}
                    onChange={(e) => onUpdateAnnotation(ann.id, { severity: e.target.value })}
                    className="w-full rounded border border-white/10 bg-[#0f141a] text-sm p-2"
                  >
                    {DEFAULT_SEVERITIES.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-white/70 mb-1">Status</label>
                  <select
                    value={ann.status}
                    onChange={(e) => onUpdateAnnotation(ann.id, { status: e.target.value })}
                    className="w-full rounded border border-white/10 bg-[#0f141a] text-sm p-2"
                  >
                    {DEFAULT_STATUSES.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Peça exibida somente leitura (vem do índice) */}
                <div>
                  <label className="block text-xs text-white/70 mb-1">Peça (exibida)</label>
                  <input
                    value={ann.objectName || ""}
                    readOnly
                    className="w-full rounded border border-white/10 bg-[#0f141a] text-sm p-2 opacity-80"
                  />
                  <div className="text-[11px] text-white/40 mt-1">upld: {ann.objectKey || "-"}</div>
                </div>

                {/* Upload foto */}
                <div className="col-span-2">
                  <label className="block text-xs text-white/70 mb-1">Adicionar foto</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleAddPhoto(ann.id, file);
                      e.currentTarget.value = "";
                    }}
                    className="block w-full text-sm p-2 bg-[#0b0f14] border border-white/10 rounded"
                  />
                </div>

                {/* Thumbs */}
                {ann.photos?.length > 0 && (
                  <div className="col-span-2">
                    <div className="text-sm text-white/70 mb-2">Fotos ({ann.photos.length})</div>
                    <div className="grid grid-cols-4 gap-2">
                      {ann.photos.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setPhotoViewer({ open: true, url: p.url, name: p.name })}
                          className="aspect-square overflow-hidden rounded border border-white/10"
                          title={p.name}
                        >
                          <img
                            src={p.url}
                            alt={p.name}
                            className="w-full h-full object-cover"
                            onError={(ev) => {
                              ev.currentTarget.src =
                                "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTIwIiBoZWlnaHQ9IjkwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iOTAiIGZpbGw9IiMxMzEzMTMiLz48dGV4dCB4PSI2MCIgeT0iNDUiIGZvbnQtc2l6ZT0iMTIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IiNmZmYiPkVycm88L3RleHQ+PC9zdmc+";
                            }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="col-span-2">
                  <label className="block text-xs text-white/70 mb-1">Observações</label>
                  <textarea
                    value={ann.note}
                    onChange={(e) => onUpdateAnnotation(ann.id, { note: e.target.value })}
                    className="w-full rounded border border-white/10 bg-[#0f141a] text-sm p-2"
                    rows={3}
                    placeholder="Adicione detalhes…"
                  />
                </div>

                <div className="col-span-2 flex items-center justify-between mt-2">
                  <button
                    onClick={() => onSelectAnnotation(ann.id)}
                    className="px-4 py-2 rounded bg-[#26405d] hover:brightness-110 text-sm"
                  >
                    Localizar
                  </button>
                  <button
                    onClick={() => onDeleteAnnotation(ann.id)}
                    className="px-4 py-2 rounded bg-[#b85236] hover:brightness-110 text-sm"
                  >
                    Excluir
                  </button>
                </div>
              </div>
            </div>
          ))}
          {filteredAnnotations.length === 0 && (
            <div className="text-sm text-white/70 bg-[#0b0f14] border border-dashed border-white/10 rounded-xl p-6 text-center">
              Nenhuma anotação. Ative <b>Anotar</b> e toque no modelo para marcar.
            </div>
          )}
        </div>

        {/* Legenda */}
        <div className="p-4 border-t border-white/10 bg-[#0d131a]">
          <div className="text-xs text-white/70 mb-2">Legenda de status</div>
          <div className="grid grid-cols-2 gap-2">
            {DEFAULT_STATUSES.map((s) => (
              <div key={s} className="flex items-center gap-2 text-sm">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{
                    backgroundColor: `#${STATUS_COLORS[s].toString(16).padStart(6, "0")}`,
                    border: STATUS_COLORS[s] === 0xffffff ? "1px solid #ccc" : "none",
                  }}
                />
                <span className="text-white/80">{s}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Importante: tutorial opcional */}
      {showTutorial && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-40 p-6">
          <div className="bg-[#0f141a] border border-white/10 rounded-2xl p-6 max-w-lg">
            <h2 className="text-xl font-bold mb-3">Bem-vindo!</h2>
            <ul className="list-disc pl-6 space-y-2 text-white/80">
              <li>Use <b>Carregar Modelo</b> e selecione .obj (e .mtl) se tiver.</li>
              <li>Ative <b>Anotar</b> e toque no modelo para criar uma anotação.</li>
              <li>O nome exibido da peça vira o <b>type</b> do seu JSON quando encontrar o <b>upld</b>.</li>
            </ul>
            <button onClick={() => setShowTutorial(false)} className="mt-4 px-4 py-2 rounded bg-[#26405d]">
              Entendi
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
