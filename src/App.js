import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

/* ===========================
   Supabase
=========================== */
const SUPABASE_URL = "https://hkhqoxigwkuhrccwaght.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhraHFveGlnd2t1aHJjY3dhZ2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2MTg1NzQsImV4cCI6MjA3MzE5NDU3NH0.mJJGbu2BrR6aLlov2yjbGnBjWJVKeGHtdXGwK_e9M7A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ===========================
   Tema (paleta)
=========================== */
const THEME = {
  bgApp: "#0f1720",
  primary: "#26405d",
  action1: "#00a49a", // Anotar / confirmar
  action2: "#b85236", // Isolar
  action3: "#c35e1e", // Exportar
  text: "#e5eef7",
  textDim: "#a9b8c7",
  border: "#1f3144",
};

/* Alturas fixas para layout (evita sobreposição) */
const HEADER_H = 72;
const SUBBAR_H = 40;

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

/* Utils */
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
function humanFileSize(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
const makePersistableAnnotations = (anns) =>
  (anns || []).map((a) => ({
    ...a,
    photos: (a.photos || []).map((p) => ({ id: p.id, name: p.name, url: p.url, createdAt: p.createdAt })),
  }));
function persistAnnotations(key, anns) {
  try {
    localStorage.setItem(key, JSON.stringify(makePersistableAnnotations(anns)));
  } catch {}
}
function readPersistedAnnotations(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (Array.isArray(d)) return d;
    if (d?.annotations) return d.annotations;
    return null;
  } catch {
    return null;
  }
}
async function uploadPhoto(file, pieceId) {
  const safe = (file.name || "foto.jpg").replace(/\s+/g, "_");
  const path = `${pieceId}/${Date.now()}-${safe}`;
  const { error } = await supabase.storage.from("photos").upload(path, file, { upsert: false });
  if (error) throw error;
  const { data: pub } = supabase.storage.from("photos").getPublicUrl(path);
  return pub?.publicUrl;
}

/* ===========================
   Componente
=========================== */
export default function App3DAnnotations() {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const modelGroupRef = useRef(null);
  const isolationMapRef = useRef(new Map());
  const isPlacingRef = useRef(false);
  const isIsolationModeRef = useRef(false);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  const [modelInfo, setModelInfo] = useState({ name: "", size: 0 });
  const [modelGroup, setModelGroup] = useState(null);
  const [pinsGroup] = useState(() => new THREE.Group());
  const [annotations, setAnnotations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [isPlacing, setIsPlacing] = useState(false);
  const [isolationMode, setIsolationMode] = useState(false);
  const [isolatedUuid, setIsolatedUuid] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [mtlHint, setMtlHint] = useState(null);
  const [photoViewer, setPhotoViewer] = useState({ open: false, url: "", name: "" });

  const annotationsRef = useRef(annotations);
  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);
  useEffect(() => {
    isPlacingRef.current = isPlacing;
  }, [isPlacing]);
  useEffect(() => {
    isIsolationModeRef.current = isolationMode;
  }, [isolationMode]);
  useEffect(() => {
    modelGroupRef.current = modelGroup;
  }, [modelGroup]);

  /* Cores peça */
  const colorizePiece = useCallback((obj, color) => {
    if (!obj) return;
    obj.traverse((ch) => {
      if (ch.isMesh) {
        if (!ch.userData.originalMaterial) ch.userData.originalMaterial = ch.material;
        ch.material = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
        ch.material.needsUpdate = true;
      }
    });
  }, []);
  const restoreOriginalColor = useCallback((obj) => {
    if (!obj) return;
    obj.traverse((ch) => {
      if (ch.isMesh && ch.userData.originalMaterial) {
        ch.material = ch.userData.originalMaterial;
        ch.material.needsUpdate = true;
      }
    });
  }, []);
  const colorizePieceByStatus = useCallback(
    (pieceName, status) => {
      const root = modelGroupRef.current;
      if (!root) return;
      let t = null;
      root.traverse((ch) => {
        if (ch.isMesh && ch.name === pieceName) t = ch;
      });
      if (t) colorizePiece(t, STATUS_COLORS[status] || 0x0070f3);
    },
    [colorizePiece]
  );
  const restorePieceColor = useCallback(
    (pieceName) => {
      const root = modelGroupRef.current;
      if (!root) return;
      let t = null;
      root.traverse((ch) => {
        if (ch.isMesh && ch.name === pieceName) t = ch;
      });
      if (t) restoreOriginalColor(t);
    },
    [restoreOriginalColor]
  );

  /* Viewer THREE – sem sombras */
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b1220");
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 10000);
    camera.position.set(3, 2, 4);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = false; // <<< sem sombras
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(5, 10, 7);
    scene.add(dir);

    const grid = new THREE.GridHelper(20, 20, 0x233647, 0x1b2a38);
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    scene.add(grid);

    pinsGroup.name = "__pins__";
    scene.add(pinsGroup);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.9;
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controlsRef.current = controls;

    const onResize = () => {
      if (!rendererRef.current || !cameraRef.current) return;
      const w = mount.clientWidth,
        h = mount.clientHeight;
      rendererRef.current.setSize(w, h);
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(() => requestAnimationFrame(onResize));
    ro.observe(mount);

    const onClick = (ev) => {
      if (!modelGroupRef.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const mx = (ev.clientX - rect.left) / rect.width,
        my = (ev.clientY - rect.top) / rect.height;
      const mouse = new THREE.Vector2(mx * 2 - 1, -(my * 2 - 1));
      raycaster.setFromCamera(mouse, cameraRef.current);
      const hit = raycaster.intersectObjects(modelGroupRef.current.children, true)[0];
      if (!hit) return;
      const root = getPieceRoot(hit.object);
      if (isIsolationModeRef.current) applyIsolation(root);
      if (!isPlacingRef.current) return;

      const normal =
        hit.face && hit.object
          ? hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
          : new THREE.Vector3(0, 1, 0);

      const pieceName = (root && root.name) || hit.object.name || "";
      if (annotationsRef.current.some((a) => a.objectName === pieceName)) {
        alert("Já existe uma anotação para esta peça.");
        return;
      }
      const id = uuidv4();
      const ann = {
        id,
        position: [hit.point.x, hit.point.y, hit.point.z],
        normal: [normal.x, normal.y, normal.z],
        objectName: pieceName,
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
      colorizePieceByStatus(pieceName, ann.status);
    };
    renderer.domElement.addEventListener("click", onClick, { passive: true });

    let raf;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener("click", onClick);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement?.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
    };
  }, []);

  /* Load OBJ/MTL */
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
      group.traverse((ch) => {
        if (ch.isMesh) {
          ch.castShadow = false;
          ch.receiveShadow = false;
          if (ch.material) {
            ch.material.side = THREE.FrontSide;
            ch.material.needsUpdate = true;
          }
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

      const firstMtllib = objText.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().startsWith("mtllib "));
      setMtlHint(!mtlFile && firstMtllib ? firstMtllib.slice(7).trim() : null);
    } catch (e) {
      console.error(e);
      alert("Falha ao carregar o OBJ.");
    } finally {
      setLoading(false);
    }
  }

  /* Pinos & isolamento */
  function clearPins() {
    [...pinsGroup.children].forEach((c) => pinsGroup.remove(c));
  }
  function addPin(ann) {
    const color = STATUS_COLORS[ann.status] || 0x0070f3;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 16), new THREE.MeshStandardMaterial({ color }));
    mesh.position.set(ann.position[0], ann.position[1], ann.position[2]);
    mesh.userData.annotationId = ann.id;
    pinsGroup.add(mesh);
  }
  function getPieceRoot(obj) {
    let cur = obj,
      root = modelGroupRef.current;
    while (cur && cur.parent && cur.parent !== root) cur = cur.parent;
    return cur || obj;
  }
  function clearIsolation() {
    const map = isolationMapRef.current;
    if (!map.size) return;
    map.forEach((saved, mesh) => {
      if (saved.material) {
        mesh.material.dispose?.();
        mesh.material = saved.material;
      }
      if (typeof saved.visible === "boolean") mesh.visible = saved.visible;
    });
    map.clear();
    setIsolatedUuid(null);
  }
  function applyIsolation(targetRoot) {
    if (!modelGroupRef.current) return;
    clearIsolation();
    const map = isolationMapRef.current;
    const keep = new Set();
    targetRoot.traverse((n) => {
      if (n.isMesh) keep.add(n);
    });
    modelGroupRef.current.traverse((n) => {
      if (!n.isMesh) return;
      if (!map.has(n)) map.set(n, { material: n.material, visible: n.visible });
      if (keep.has(n)) {
        colorizePiece(n, 0x3399ff);
      } else {
        const faded = n.material.clone();
        faded.transparent = true;
        faded.opacity = 0.12;
        faded.depthWrite = false;
        n.material = faded;
      }
    });
    setIsolatedUuid(targetRoot.uuid);
  }
  function findPieceForAnnotation(ann) {
    if (!modelGroupRef.current || !ann) return null;
    if (ann.objectName) {
      let byName = null;
      modelGroupRef.current.traverse((n) => {
        if (!byName && n.name === ann.objectName) byName = n;
      });
      if (byName) return getPieceRoot(byName);
    }
    if (ann.position?.length === 3) {
      const target = new THREE.Vector3(...ann.position);
      let best = { node: null, dist: Infinity };
      modelGroupRef.current.traverse((n) => {
        if (!n.isMesh) return;
        const c = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3());
        const d = c.distanceTo(target);
        if (d < best.dist) best = { node: n, dist: d };
      });
      if (best.node) return getPieceRoot(best.node);
    }
    return null;
  }

  useEffect(() => {
    pinsGroup.children.forEach((mesh) => {
      const id = mesh.userData.annotationId;
      const ann = annotations.find((a) => a.id === id);
      if (!ann) return;
      mesh.material.color.set(STATUS_COLORS[ann.status] || 0x0070f3);
      mesh.scale.setScalar(selectedId === id ? 1.6 : 1.0);
    });
  }, [annotations, selectedId, pinsGroup]);

  function onSelectAnnotation(id) {
    setSelectedId(id);
    const ann = annotations.find((a) => a.id === id);
    if (isIsolationModeRef.current && ann) {
      const root = findPieceForAnnotation(ann);
      if (root) applyIsolation(root);
    }
    if (ann?.objectName) colorizePieceByStatus(ann.objectName, ann.status);

    const controls = controlsRef.current,
      cam = cameraRef.current;
    const dist = cam.position.distanceTo(controls.target);
    let targetPos = null;
    const pin = pinsGroup.children.find((m) => m.userData.annotationId === id);
    if (pin) targetPos = pin.position.clone();
    else if (ann?.position) targetPos = new THREE.Vector3(...ann.position);
    if (targetPos) {
      controls.target.copy(targetPos);
      const dir = cam.position.clone().sub(controls.target).normalize();
      cam.position.copy(controls.target.clone().add(dir.multiplyScalar(dist)));
      controls.update();
    }
  }
  function onDeleteAnnotation(id) {
    const ann = annotations.find((a) => a.id === id);
    if (ann?.objectName) restorePieceColor(ann.objectName);
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    const idx = pinsGroup.children.findIndex((m) => m.userData.annotationId === id);
    if (idx >= 0) pinsGroup.remove(pinsGroup.children[idx]);
    if (selectedId === id) setSelectedId(null);
  }
  function onUpdateAnnotation(id, patch) {
    setAnnotations((prev) => {
      const up = prev.map((a) => (a.id === id ? { ...a, ...patch } : a));
      if (patch.status) {
        const ann = up.find((a) => a.id === id);
        if (ann?.objectName) colorizePieceByStatus(ann.objectName, patch.status);
      }
      return up;
    });
  }
  async function handleAddPhoto(annotationId, file) {
    try {
      const url = await uploadPhoto(file, annotationId);
      setAnnotations((prev) =>
        prev.map((a) =>
          a.id === annotationId
            ? { ...a, photos: [...(a.photos || []), { id: uuidv4(), name: file.name, url, createdAt: new Date().toISOString() }] }
            : a
        )
      );
      alert("Foto enviada com sucesso!");
    } catch (err) {
      console.error(err);
      alert("Falha ao enviar a foto. Veja o console.");
    }
  }

  function onExportJSON() {
    const payload = { model: modelInfo.name, exportedAt: new Date().toISOString(), annotations };
    downloadBlob(JSON.stringify(payload, null, 2), (modelInfo.name || "modelo") + ".anotacoes.json", "application/json");
  }
  async function onExportXLSX() {
    if (!annotations.length) {
      alert("Nenhuma anotação para exportar!");
      return;
    }
    const rows = annotations.map((ann, i) => ({
      "#": i + 1,
      ID: ann.id,
      Modelo: modelInfo.name || "",
      "Criado em": new Date(ann.createdAt).toLocaleString(),
      Peça: ann.objectName || "",
      Tipo: ann.issueType || "",
      Severidade: ann.severity || "",
      Status: ann.status || "",
      Observações: ann.note || "",
      Fotos: (ann.photos || []).map((p) => p.url).join("\n"),
      "Posição (x,y,z)": ann.position?.map((n) => +n).join(", ") || "",
      "Normal (x,y,z)": ann.normal?.map((n) => +n).join(", ") || "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Anotações");
    const ab = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    downloadBlob(
      new Blob([ab], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      (modelInfo.name || "modelo") + ".anotacoes.xlsx"
    );
  }
  function onImportJSON(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        if (!Array.isArray(data.annotations)) throw new Error("JSON inválido");
        annotations.forEach((a) => a.objectName && restorePieceColor(a.objectName));
        setAnnotations(data.annotations);
        clearPins();
        data.annotations.forEach(addPin);
        data.annotations.forEach((a) => a.objectName && colorizePieceByStatus(a.objectName, a.status));
        alert("Anotações importadas: " + data.annotations.length);
      } catch {
        alert("Falha ao ler JSON.");
      }
    };
    fr.readAsText(file);
  }

  useEffect(() => {
    if (!modelInfo.name) return;
    const saved = readPersistedAnnotations("ann:" + modelInfo.name);
    if (saved) {
      clearPins();
      setAnnotations(saved);
      saved.forEach(addPin);
      saved.forEach((a) => a.objectName && colorizePieceByStatus(a.objectName, a.status));
    }
    // eslint-disable-next-line
  }, [modelInfo.name]);
  useEffect(() => {
    if (!modelInfo.name) return;
    persistAnnotations("ann:" + modelInfo.name, annotations);
    // eslint-disable-next-line
  }, [annotations, modelInfo.name]);

  function handleFilesChosen(files) {
    const arr = Array.from(files || []);
    const obj = arr.find((f) => f.name.toLowerCase().endsWith(".obj"));
    const mtl = arr.find((f) => f.name.toLowerCase().endsWith(".mtl"));
    if (!obj) {
      alert("Selecione um .obj (opcional .mtl).");
      return;
    }
    handleLoadOBJFromFiles(obj, mtl || null);
  }

  /* ===========================
     UI
  ============================ */
  return (
    <div style={{ background: THEME.bgApp }} className="w-full h-screen flex flex-col text-white overflow-hidden">
      {/* HEADER */}
      <header
        className="w-full flex-shrink-0"
        style={{ height: HEADER_H, background: THEME.primary, borderBottom: `1px solid ${THEME.border}` }}
      >
        <div className="h-full max-w-full mx-auto flex items-center gap-10 px-4">
          <div className="mr-auto">
            <div className="text-lg font-semibold" style={{ color: THEME.text }}>
              PHD Tech - 3D Inspector Pro
            </div>
            <div className="text-xs" style={{ color: THEME.textDim }}>
              Anotação e inspeção 3D
            </div>
          </div>

          {/* Carregar */}
          <label className="cursor-pointer">
            <div
              className="px-4 py-2 rounded-md font-medium"
              style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
            >
              ☁️ Carregar Modelo
            </div>
            <input type="file" accept=".obj,.mtl" className="hidden" multiple onChange={(e) => handleFilesChosen(e.target.files)} />
          </label>

          {/* Anotar */}
          <button
            onClick={() => setIsPlacing((v) => !v)}
            className="px-4 py-2 rounded-md font-medium"
            style={{
              background: isPlacing ? THEME.action1 : "#0b1622",
              border: `1px solid ${THEME.border}`,
              color: isPlacing ? "#062a27" : THEME.text,
            }}
            title="Toque no modelo para marcar"
          >
            {isPlacing ? "Marcando…" : "Anotar"}
          </button>

          {/* Isolar */}
          <button
            onClick={() => {
              setIsolationMode((v) => {
                const n = !v;
                if (!n) clearIsolation();
                return n;
              });
            }}
            className="px-4 py-2 rounded-md font-medium"
            style={{
              background: isolationMode ? THEME.action2 : "#0b1622",
              border: `1px solid ${THEME.border}`,
              color: isolationMode ? "#2b0d08" : THEME.text,
            }}
            title="Isolar peças ao clicar"
          >
            Isolar
          </button>

          {/* Enquadrar – agora no topo também */}
          <button
            onClick={() =>
              modelGroupRef.current && fitCameraToObject(cameraRef.current, modelGroupRef.current, controlsRef.current, 1.25)
            }
            className="px-4 py-2 rounded-md font-medium"
            style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
          >
            Enquadrar
          </button>
        </div>
      </header>

      {/* SUBBAR */}
      <div
        className="w-full flex-shrink-0 flex items-center px-4 text-sm"
        style={{ height: SUBBAR_H, background: "#0b1622", borderBottom: `1px solid ${THEME.border}`, color: THEME.textDim }}
      >
        {modelInfo.name ? (
          <span>
            <span style={{ color: THEME.text }}>Modelo:</span> {modelInfo.name} · {humanFileSize(modelInfo.size)}
          </span>
        ) : (
          "Carregue um arquivo .obj (e .mtl) para começar"
        )}
      </div>

      {/* MAIN STAGE */}
      <div className="relative flex-1">
        <div ref={mountRef} className="absolute inset-0" />

        <div
          className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 text-xs rounded"
          style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.textDim }}
        >
          1 dedo gira · 2 dedos move/zoom
        </div>

        {/* FABs (mantidos) */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-2">
          <button
            onClick={() =>
              modelGroupRef.current && fitCameraToObject(cameraRef.current, modelGroupRef.current, controlsRef.current, 1.25)
            }
            className="w-12 h-12 rounded-md font-semibold grid place-items-center"
            style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
          >
            🎯
          </button>
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="w-12 h-12 rounded-md font-semibold grid place-items-center"
            style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
          >
            {sidebarOpen ? "✕" : "📋"}
          </button>
        </div>

        {loading && (
          <div className="absolute inset-0 grid place-items-center" style={{ background: "rgba(0,0,0,.4)" }}>
            <div className="px-4 py-2 rounded-md" style={{ background: "#102031", border: `1px solid ${THEME.border}`, color: THEME.text }}>
              Carregando modelo…
            </div>
          </div>
        )}

        {/* Photo Viewer */}
        {photoViewer.open && (
          <div className="absolute inset-0 z-40 grid place-items-center" style={{ background: "rgba(0,0,0,.9)" }}>
            <button
              onClick={() => setPhotoViewer({ open: false, url: "", name: "" })}
              className="absolute top-4 right-4 px-3 py-1 rounded-md"
              style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
            >
              Fechar ✕
            </button>
            <img src={photoViewer.url} alt={photoViewer.name || "Foto"} className="max-h-[90vh] max-w-[92vw] object-contain rounded-md" />
            {photoViewer.name && (
              <div
                className="absolute bottom-5 left-1/2 -translate-x-1/2 px-2 py-1 text-xs rounded"
                style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.textDim }}
              >
                {photoViewer.name}
              </div>
            )}
          </div>
        )}
      </div>

      {/* SIDEBAR – agora com top calculado e rolável */}
      <div
        style={{
          position: "absolute",
          right: 0,
          top: HEADER_H + SUBBAR_H, // respeita header + subbar
          bottom: 0,
          width: "100%",
          maxWidth: "28rem",
          background: THEME.primary,
          borderLeft: `1px solid ${THEME.border}`,
          transform: sidebarOpen ? "translateX(0)" : "translateX(100%)",
          transition: "transform 300ms ease-out",
          display: "flex",
          flexDirection: "column",
          zIndex: 20,
        }}
      >
        {/* Cabeçalho do painel */}
        <div className="p-4" style={{ borderBottom: `1px solid ${THEME.border}` }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold" style={{ color: THEME.text }}>
                Anotações
              </div>
              <div className="text-xs" style={{ color: THEME.textDim }}>
                {annotations.length} item(s)
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={onExportJSON}
                className="px-3 py-2 rounded-md text-sm font-medium"
                style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
              >
                JSON
              </button>
              <button
                onClick={onExportXLSX}
                className="px-3 py-2 rounded-md text-sm font-medium"
                style={{ background: THEME.action3, color: "#2b1405" }}
              >
                Excel
              </button>
            </div>
          </div>

          {mtlHint && (
            <div
              className="mt-3 text-xs px-3 py-2 rounded-md"
              style={{ background: "#102031", border: `1px solid ${THEME.border}`, color: THEME.textDim }}
            >
              OBJ referencia: <span className="font-mono" style={{ color: THEME.text }}>{mtlHint}</span>
            </div>
          )}

          <div className="mt-3">
            <label className="block text-xs mb-1" style={{ color: THEME.textDim }}>
              Importar anotações (JSON)
            </label>
            <input
              type="file"
              accept="application/json"
              onChange={(e) => e.target.files?.[0] && onImportJSON(e.target.files[0])}
              className="block w-full text-sm px-3 py-2 rounded-md"
              style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
            />
          </div>
        </div>

        {/* Lista – área rolável */}
        <div className="p-4 space-y-3" style={{ flex: 1, overflowY: "auto" }}>
          {annotations.map((ann) => (
            <div key={ann.id} className="rounded-md p-3" style={{ background: "#0b1622", border: `1px solid ${THEME.border}` }}>
              <div className="flex items-start justify-between">
                <button onClick={() => onSelectAnnotation(ann.id)} className="text-left">
                  <div className="font-semibold" style={{ color: THEME.text }}>
                    {ann.issueType}
                  </div>
                  <div className="text-xs" style={{ color: THEME.textDim }}>
                    {ann.objectName || "Peça"}
                  </div>
                  <div className="text-xs" style={{ color: THEME.textDim }}>
                    {new Date(ann.createdAt).toLocaleString()}
                  </div>
                </button>
                <span
                  className="text-xs px-2 py-1 rounded-full"
                  style={{ background: "#122232", border: `1px solid ${THEME.border}`, color: THEME.text }}
                >
                  {ann.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3">
                <div>
                  <label className="block text-xs mb-1" style={{ color: THEME.textDim }}>
                    Tipo
                  </label>
                  <select
                    value={ann.issueType}
                    onChange={(e) => onUpdateAnnotation(ann.id, { issueType: e.target.value })}
                    className="w-full text-sm px-2 py-2 rounded-md"
                    style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
                  >
                    {DEFAULT_ISSUES.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: THEME.textDim }}>
                    Severidade
                  </label>
                  <select
                    value={ann.severity}
                    onChange={(e) => onUpdateAnnotation(ann.id, { severity: e.target.value })}
                    className="w-full text-sm px-2 py-2 rounded-md"
                    style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
                  >
                    {DEFAULT_SEVERITIES.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: THEME.textDim }}>
                    Status
                  </label>
                  <select
                    value={ann.status}
                    onChange={(e) => onUpdateAnnotation(ann.id, { status: e.target.value })}
                    className="w-full text-sm px-2 py-2 rounded-md"
                    style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
                  >
                    {DEFAULT_STATUSES.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: THEME.textDim }}>
                    Peça
                  </label>
                  <input
                    value={ann.objectName || ""}
                    onChange={(e) => onUpdateAnnotation(ann.id, { objectName: e.target.value })}
                    className="w-full text-sm px-2 py-2 rounded-md"
                    style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
                    placeholder="Ex: Braço, Base, Travessa"
                  />
                </div>

                {/* Upload foto */}
                <div className="col-span-2">
                  <label className="block text-xs mb-1" style={{ color: THEME.textDim }}>
                    Adicionar foto
                  </label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleAddPhoto(ann.id, f);
                      e.currentTarget.value = "";
                    }}
                    className="block w-full text-sm px-2 py-2 rounded-md"
                    style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
                  />
                </div>

                {/* Thumbs */}
                {ann.photos?.length > 0 && (
                  <div className="col-span-2">
                    <div className="text-xs mb-2" style={{ color: THEME.textDim }}>
                      Fotos ({ann.photos.length})
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {ann.photos.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setPhotoViewer({ open: true, url: p.url, name: p.name })}
                          className="aspect-square rounded-md overflow-hidden"
                          style={{ border: `1px solid ${THEME.border}` }}
                          title={p.name}
                        >
                          <img src={p.url} alt={p.name} className="w-full h-full object-cover" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="col-span-2">
                  <label className="block text-xs mb-1" style={{ color: THEME.textDim }}>
                    Observações
                  </label>
                  <textarea
                    value={ann.note}
                    onChange={(e) => onUpdateAnnotation(ann.id, { note: e.target.value })}
                    rows={3}
                    className="w-full text-sm px-2 py-2 rounded-md"
                    style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.text }}
                    placeholder="Adicione detalhes..."
                  />
                </div>

                <div className="col-span-2 flex items-center justify-between mt-1">
                  <button
                    onClick={() => onSelectAnnotation(ann.id)}
                    className="px-3 py-2 rounded-md text-sm font-medium"
                    style={{ background: THEME.action1, color: "#062a27" }}
                  >
                    Localizar
                  </button>
                  <button
                    onClick={() => onDeleteAnnotation(ann.id)}
                    className="px-3 py-2 rounded-md text-sm font-medium"
                    style={{ background: "#2a0b0b", border: `1px solid ${THEME.border}`, color: "#ff9a9a" }}
                  >
                    Excluir
                  </button>
                </div>
              </div>
            </div>
          ))}

          {annotations.length === 0 && (
            <div
              className="text-center text-sm px-4 py-6 rounded-md"
              style={{ background: "#0b1622", border: `1px solid ${THEME.border}`, color: THEME.textDim }}
            >
              Nenhuma anotação. Ative <span style={{ color: THEME.text }}>Anotar</span> e toque no modelo.
            </div>
          )}
        </div>

        {/* Legenda */}
        <div className="px-4 py-3" style={{ borderTop: `1px solid ${THEME.border}`, background: "#0b1622" }}>
          <div className="text-xs mb-2" style={{ color: THEME.textDim }}>
            Legenda de status
          </div>
          <div className="grid grid-cols-2 gap-2">
            {DEFAULT_STATUSES.map((s) => (
              <div key={s} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ background: "#" + STATUS_COLORS[s].toString(16).padStart(6, "0") }} />
                <span className="text-xs" style={{ color: THEME.text }}>
                  {s}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
