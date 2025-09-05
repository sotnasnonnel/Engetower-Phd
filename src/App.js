import React, { useEffect, useRef, useState, useMemo } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from 'xlsx';


// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------
export default function App3DAnnotations() {
  // Refs Three.js & live state
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const isPlacingRef = useRef(false);
  const modelGroupRef = useRef(null);
  const isolationMapRef = useRef(new Map());
  const isIsolationModeRef = useRef(false);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  // State
  const [modelInfo, setModelInfo] = useState({ name: "", size: 0 });
  const [modelGroup, setModelGroup] = useState(null);
  const [pinsGroup] = useState(() => new THREE.Group());
  const [annotations, setAnnotations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [isPlacing, setIsPlacing] = useState(false);
  const [mtlHint, setMtlHint] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isolatedUuid, setIsolatedUuid] = useState(null);
  const [isIsolationMode, setIsIsolationMode] = useState(false);

  // NEW: minimizar apenas a sidebar
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Sync refs
  useEffect(() => { isPlacingRef.current = isPlacing; }, [isPlacing]);
  useEffect(() => { modelGroupRef.current = modelGroup; }, [modelGroup]);
  useEffect(() => { isIsolationModeRef.current = isIsolationMode; }, [isIsolationMode]);

  // Init viewer (once) - tablet friendly
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f7f8);
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

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x667788, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(5, 10, 7);
    scene.add(dir);

    // Grid
    const grid = new THREE.GridHelper(20, 20, 0xdddddd, 0xeeeeee);
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    scene.add(grid);

    // Pins group
    pinsGroup.name = "__pins__";
    scene.add(pinsGroup);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.rotateSpeed = 0.7;
    controls.panSpeed = 0.9;
    controls.zoomSpeed = 0.9;
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controlsRef.current = controls;

    // Resize
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

    // Click for placing pins + isolation
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

      // Isolar peça somente se o Modo isolamento estiver ativo
      const root = getPieceRoot(hit.object);
      if (isIsolationModeRef.current) {
        applyIsolation(root);
      }

      if (!isPlacingRef.current) return; // só cria anotação no modo de marcação

      const id = uuidv4();
      const normal =
        hit.face && hit.object
          ? hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
          : new THREE.Vector3(0, 1, 0);
      const pieceName =
        (root && root.name) ||
        ((hit.object.parent && hit.object.parent.name) || hit.object.name) ||
        "";
      const ann = {
        id,
        position: [hit.point.x, hit.point.y, hit.point.z],
        normal: [normal.x, normal.y, normal.z],
        objectName: pieceName,
        issueType: DEFAULT_ISSUES[0],
        severity: DEFAULT_SEVERITIES[1],
        status: DEFAULT_STATUSES[0],
        note: "",
        createdAt: new Date().toISOString(),
      };
      addPin(ann);
      setAnnotations((prev) => [ann, ...prev]);
      setSelectedId(id);
    };
    renderer.domElement.addEventListener("click", onClick, { passive: true });

    // Loop
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
      if (renderer.domElement?.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
    };
  }, [pinsGroup, raycaster]);

  // Load OBJ/MTL
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
        if (child.isMesh) {
          child.castShadow = false;
          child.receiveShadow = false;
          if (child.material) {
            child.material.side = THREE.FrontSide;
            child.material.needsUpdate = true;
          }
        }
      });

      // clear previous model & pins
      if (modelGroup) sceneRef.current.remove(modelGroup);
      setAnnotations([]);
      clearPins();
      clearIsolation();

      sceneRef.current.add(group);
      setModelGroup(group);
      modelGroupRef.current = group;
      setModelInfo({ name: objFile.name, size: objFile.size });

      // Enquadrar o modelo carregado
      fitCameraToObject(cameraRef.current, group, controlsRef.current, 1.3);

      // Pegar dica do MTL referenciado no OBJ (se houver)
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

  // Pins
  function clearPins() {
    [...pinsGroup.children].forEach((c) => pinsGroup.remove(c));
  }
  function addPin(ann) {
    const colorBySeverity = { Baixa: 0x66cc66, Média: 0xffcc66, Alta: 0xff9966, Crítica: 0xff5555 };
    const geo = new THREE.SphereGeometry(0.02, 16, 16);
    const mat = new THREE.MeshStandardMaterial({ color: colorBySeverity[ann.severity] || 0x0070f3 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(ann.position[0], ann.position[1], ann.position[2]);
    mesh.userData.annotationId = ann.id;
    pinsGroup.add(mesh);
  }

  // Isolation helpers
  function getPieceRoot(obj) {
    let cur = obj;
    const root = modelGroupRef.current;
    while (cur && cur.parent && cur.parent !== root) cur = cur.parent;
    return cur || obj;
  }
  function clearIsolation() {
    const map = isolationMapRef.current;
    if (!map.size) return;
    map.forEach((saved, mesh) => {
      if (!mesh || !saved) return;
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
    targetRoot.traverse((n) => { if (n.isMesh) keep.add(n); });
    modelGroupRef.current.traverse((n) => {
      if (!n.isMesh) return;
      if (!map.has(n)) map.set(n, { material: n.material, visible: n.visible });
      if (keep.has(n)) return;
      const faded = n.material.clone();
      faded.transparent = true;
      faded.opacity = 0.1;
      faded.depthWrite = false;
      n.material = faded;
    });
    setIsolatedUuid(targetRoot.uuid);
  }

  // Encontrar a peça da anotação (por nome ou proximidade)
  function findPieceForAnnotation(ann) {
    if (!modelGroupRef.current || !ann) return null;

    // 1) tenta por nome exato
    if (ann.objectName) {
      let byName = null;
      modelGroupRef.current.traverse((n) => {
        if (!byName && n.name && n.name === ann.objectName) byName = n;
      });
      if (byName) return getPieceRoot(byName);
    }

    // 2) fallback por proximidade
    if (ann.position && ann.position.length === 3) {
      const target = new THREE.Vector3(ann.position[0], ann.position[1], ann.position[2]);
      let best = { node: null, dist: Infinity };
      modelGroupRef.current.traverse((n) => {
        if (!n.isMesh) return;
        const box = new THREE.Box3().setFromObject(n);
        const center = box.getCenter(new THREE.Vector3());
        const d = center.distanceTo(target);
        if (d < best.dist) best = { node: n, dist: d };
      });
      if (best.node) return getPieceRoot(best.node);
    }

    return null;
  }

  // Update pin visuals
  useEffect(() => {
    pinsGroup.children.forEach((mesh) => {
      const id = mesh.userData.annotationId;
      const ann = annotations.find((a) => a.id === id);
      if (!ann) return;
      const colorBySeverity = { Baixa: 0x66cc66, Média: 0xffcc66, Alta: 0xff9966, Crítica: 0xff5555 };
      mesh.material.color.set(colorBySeverity[ann.severity] || 0x0070f3);
      mesh.scale.setScalar(selectedId === id ? 1.6 : 1.0);
    });
  }, [annotations, selectedId, pinsGroup]);

  // Annotation actions
  function onSelectAnnotation(id) {
    setSelectedId(id);

    const ann = annotations.find((a) => a.id === id);

    // 1) Isolar a peça da anotação apenas se Modo isolamento estiver ativo
    if (isIsolationModeRef.current && ann) {
      const pieceRoot = findPieceForAnnotation(ann);
      if (pieceRoot) applyIsolation(pieceRoot);
    }

    // 2) Focar câmera no pin/posição da anotação (sempre)
    const controls = controlsRef.current;
    const cam = cameraRef.current;
    const dist = cam.position.distanceTo(controls.target);

    let targetPos = null;
    const pin = pinsGroup.children.find((m) => m.userData.annotationId === id);
    if (pin) targetPos = pin.position.clone();
    else if (ann && ann.position) targetPos = new THREE.Vector3(ann.position[0], ann.position[1], ann.position[2]);

    if (targetPos) {
      controls.target.copy(targetPos);
      const dir = cam.position.clone().sub(controls.target).normalize();
      cam.position.copy(controls.target.clone().add(dir.multiplyScalar(dist)));
      controls.update();
    }
  }
  function onDeleteAnnotation(id) {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    const idx = pinsGroup.children.findIndex((m) => m.userData.annotationId === id);
    if (idx >= 0) pinsGroup.remove(pinsGroup.children[idx]);
    if (selectedId === id) setSelectedId(null);
  }
  function onUpdateAnnotation(id, patch) {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  // Export/Import/Screenshot
  function onExportJSON() {
    const payload = { model: modelInfo.name, exportedAt: new Date().toISOString(), annotations };
    downloadBlob(JSON.stringify(payload, null, 2), (modelInfo.name || "modelo") + ".anotacoes.json", "application/json");
  }

  // XLSX (Excel) — IMPORT DINÂMICO
  async function onExportXLSX() {
    if (!annotations.length) {
      alert("Nenhuma anotação para exportar!");
      return;
    }

    // carrega a lib apenas quando precisar
    const { utils, write, book_new, book_append_sheet } = await import('xlsx').then(mod => ({
      utils: mod.utils,
      write: mod.write,
      book_new: mod.utils.book_new,
      book_append_sheet: mod.utils.book_append_sheet,
    }));

    const rows = annotations.map((ann, idx) => ({
      "#": idx + 1,
      ID: ann.id,
      Modelo: modelInfo.name || "",
      "Criado em": new Date(ann.createdAt).toLocaleString(),
      Peça: ann.objectName || "",
      Tipo: ann.issueType || "",
      Severidade: ann.severity || "",
      Status: ann.status || "",
      Observações: ann.note || "",
      "Posição (x,y,z)": Array.isArray(ann.position) ? ann.position.map((n) => +n).join(", ") : "",
      "Normal (x,y,z)": Array.isArray(ann.normal) ? ann.normal.map((n) => +n).join(", ") : "",
    }));

    const ws = utils.json_to_sheet(rows, {
      header: ["#", "ID", "Modelo", "Criado em", "Peça", "Tipo", "Severidade", "Status", "Observações", "Posição (x,y,z)", "Normal (x,y,z)"],
    });

    ws["!cols"] = [
      { wch: 4 }, { wch: 38 }, { wch: 28 }, { wch: 22 }, { wch: 22 },
      { wch: 22 }, { wch: 12 }, { wch: 16 }, { wch: 60 }, { wch: 26 }, { wch: 26 },
    ];

    const wb = book_new();
    book_append_sheet(wb, ws, "Anotações");

    const ab = write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([ab], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const filename = (modelInfo.name || "modelo") + ".anotacoes.xlsx";
    downloadBlob(blob, filename, blob.type);
  }

  function onImportJSON(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        if (!Array.isArray(data.annotations)) throw new Error("JSON inválido");
        setAnnotations(data.annotations);
        clearPins();
        data.annotations.forEach(addPin);
        alert("Anotações importadas: " + data.annotations.length);
      } catch (e) {
        alert("Falha ao ler JSON de anotações.");
      }
    };
    fr.readAsText(file);
  }

  function onScreenshot() {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.domElement.toBlob((blob) => { if (blob) downloadBlob(blob, "screenshot.png", "image/png"); });
  }

  // Persistence by model
  useEffect(() => {
    if (!modelInfo.name) return;
    const key = "ann:" + modelInfo.name;
    const saved = localStorage.getItem(key);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        if (Array.isArray(data)) {
          setAnnotations(data);
          clearPins();
          data.forEach(addPin);
        }
      } catch {
        // ignore
      }
    }
  }, [modelInfo.name]);

  useEffect(() => {
    if (!modelInfo.name) return;
    const key = "ann:" + modelInfo.name;
    localStorage.setItem(key, JSON.stringify(annotations));
  }, [annotations, modelInfo.name]);

  // UI helpers
  function handleFilesChosen(files) {
    const arr = Array.from(files || []);
    const obj = arr.find((f) => f.name.toLowerCase().endsWith(".obj"));
    const mtl = arr.find((f) => f.name.toLowerCase().endsWith(".mtl"));
    if (!obj) {
      alert("Selecione um arquivo .obj (e opcionalmente .mtl).");
      return;
    }
    handleLoadOBJFromFiles(obj, mtl || null);
  }

  // ---------------------------------------------------------------------------
  // UI (responsive / tablet-friendly)
  // ---------------------------------------------------------------------------
  return (
    <div className="w-full h-screen flex flex-col bg-white text-gray-900">
      {/* App Bar */}
      <div className="flex items-center gap-2 px-4 py-3 md:py-4 border-b border-gray-200 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60">
        <div className="font-semibold text-lg md:text-xl">Gerenciador 3D — Torres de Luz</div>
        <div className="ml-auto flex items-center gap-2 md:gap-3">
          {/* Arquivo */}
          <label className="px-4 py-2 md:px-5 md:py-3 rounded-2xl bg-gray-900 text-white text-sm md:text-base font-semibold active:scale-[.98]">
            Carregar OBJ/MTL
            <input
              type="file"
              accept=".obj,.mtl"
              className="hidden"
              multiple
              onChange={(e) => handleFilesChosen(e.target.files)}
            />
          </label>

          <button
            onClick={() => modelGroupRef.current && fitCameraToObject(cameraRef.current, modelGroupRef.current, controlsRef.current, 1.25)}
            className="px-4 py-2 md:px-5 md:py-3 rounded-2xl bg-gray-100 hover:bg-gray-200 text-sm md:text-base font-semibold"
          >
            Enquadrar
          </button>

          <button
            onClick={() => {
              setIsIsolationMode((v) => {
                const next = !v;
                if (!next) clearIsolation(); // ao desligar o modo, limpa qualquer isolamento
                return next;
              });
            }}
            className={`px-4 py-2 md:px-5 md:py-3 rounded-2xl text-sm md:text-base font-semibold ${
              isIsolationMode ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'
            }`}
            title="Isolar peças ao clicar/Localizar"
          >
            {isIsolationMode ? 'Modo isolamento: ON' : 'Modo isolamento: OFF'}
          </button>

          <button
            onClick={() => setIsPlacing((v) => !v)}
            className={`px-4 py-2 md:px-5 md:py-3 rounded-2xl text-sm md:text-base font-semibold ${isPlacing ? 'bg-emerald-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}
            title="Toque no modelo para marcar"
          >
            {isPlacing ? 'Marcando…' : 'Adicionar anotação'}
          </button>

          {isolatedUuid && (
            <button
              onClick={() => clearIsolation()}
              className="px-4 py-2 md:px-5 md:py-3 rounded-2xl bg-white border text-sm md:text-base font-semibold hover:bg-gray-50"
            >
              Sair do isolamento
            </button>
          )}
        </div>
      </div>

      {/* Sub bar */}
      <div className="px-4 py-2 text-xs md:text-sm text-gray-600 border-b border-gray-100">
        {modelInfo.name ? (
          <span><span className="font-medium">Modelo:</span> {modelInfo.name} · {humanFileSize(modelInfo.size)}</span>
        ) : 'Carregue um arquivo .obj (e .mtl) para começar'}
      </div>

      {/* Main content */}
      <div
        className={`flex-1 grid grid-cols-1 h-[calc(100vh-112px)]
        ${sidebarCollapsed
          ? 'lg:grid-cols-[minmax(0,1fr)_0px]'
          : 'lg:grid-cols-[minmax(0,1fr)_420px]'}`
        }
      >
        {/* Viewer */}
        <div className="relative">
          <div ref={mountRef} className="absolute inset-0" />

          {/* Dica de gestos */}
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 bg-white/80 backdrop-blur rounded-2xl shadow px-3 py-2 text-[11px] md:text-xs text-gray-700">
            Gesto: 1 dedo gira · 2 dedos move/zoom
          </div>

          {/* FABs */}
          <div className="absolute bottom-4 right-4 flex flex-col gap-3">
            <button
              onClick={() => modelGroupRef.current && fitCameraToObject(cameraRef.current, modelGroupRef.current, controlsRef.current, 1.25)}
              className="min-w-[48px] h-12 md:h-14 px-4 rounded-2xl shadow bg-gray-900 text-white text-sm md:text-base font-semibold active:scale-[.98]"
            >
              Fit
            </button>
            {isolatedUuid && (
              <button
                onClick={clearIsolation}
                className="min-w-[48px] h-12 md:h-14 px-4 rounded-2xl shadow bg-white border text-sm md:text-base font-semibold active:scale-[.98]"
              >
                Mostrar tudo
              </button>
            )}
            <button onClick={onScreenshot} className="min-w-[48px] h-12 md:h-14 px-4 rounded-2xl shadow bg-white border text-sm md:text-base font-semibold active:scale-[.98]">Screenshot</button>
          </div>

          {loading && (
            <div className="absolute inset-0 grid place-items-center bg-white/60 z-30">
              <div className="animate-pulse text-sm bg-white rounded-2xl px-4 py-3 shadow border">Carregando modelo…</div>
            </div>
          )}
        </div>

        {/* Side panel */}
        {!sidebarCollapsed && (
          <div className="border-t lg:border-t-0 lg:border-l border-gray-200 bg-gray-50 h-full flex flex-col min-h-0">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-start gap-3">
                <div>
                  <div className="text-lg font-semibold">Anotações</div>
                  <div className="text-xs text-gray-600">Marque não conformidades e gere relatórios</div>
                </div>

                {/* Botão '>>' para minimizar a sidebar */}
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="ml-1 px-2 py-1 rounded-2xl border bg-white text-xs font-semibold hover:bg-gray-50"
                  title="Minimizar painel"
                >
                  &gt;&gt;
                </button>
              </div>

              <div className="flex gap-2">
                <button onClick={onExportJSON} className="px-3 py-2 rounded-2xl text-sm font-semibold bg-gray-900 text-white hover:bg-black">
                  Exportar JSON
                </button>
                <button onClick={onExportXLSX} className="px-3 py-2 rounded-2xl text-sm font-semibold bg-white border hover:bg-gray-50">
                  Exportar XLSX
                </button>
              </div>
            </div>

            {mtlHint && (
              <div className="mx-4 mt-3 mb-0 text-[12px] bg-amber-50 border border-amber-200 text-amber-900 rounded-2xl p-3">
                O OBJ referencia um material: <span className="font-mono">{mtlHint}</span>. Para cores/texturas completas, adicione o arquivo .mtl.
              </div>
            )}

            <div className="p-4">
              <label className="block text-xs font-medium text-gray-700 mb-1">Importar anotações (JSON)</label>
              <input
                type="file"
                accept="application/json"
                onChange={(e) => e.target.files?.[0] && onImportJSON(e.target.files[0])}
                className="block text-sm"
              />
            </div>

            <div className="px-4 pb-3 text-xs text-gray-600">{annotations.length} anotação(ões)</div>

            <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-3 min-h-0">
              {annotations.map((ann) => (
                <div key={ann.id} className={`rounded-2xl border ${selectedId === ann.id ? "border-gray-900" : "border-gray-200"} bg-white shadow-sm p-3`}>
                  <div className="flex items-center justify-between gap-2">
                    <button onClick={() => onSelectAnnotation(ann.id)} className="text-left">
                      <div className="text-sm font-semibold">{ann.issueType}</div>
                      <div className="text-[11px] text-gray-600">{new Date(ann.createdAt).toLocaleString()}</div>
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-gray-100">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: ann.severity === "Crítica" ? "#ff5555" : ann.severity === "Alta" ? "#ff9966" : ann.severity === "Média" ? "#ffcc66" : "#66cc66" }}
                        />
                        {ann.severity}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-gray-100">{ann.status}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className="block text-[11px] text-gray-600">Tipo</label>
                      <select value={ann.issueType} onChange={(e) => onUpdateAnnotation(ann.id, { issueType: e.target.value })} className="mt-1 w-full rounded-2xl border-gray-300 text-sm">
                        {DEFAULT_ISSUES.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-gray-600">Severidade</label>
                      <select value={ann.severity} onChange={(e) => onUpdateAnnotation(ann.id, { severity: e.target.value })} className="mt-1 w-full rounded-2xl border-gray-300 text-sm">
                        {DEFAULT_SEVERITIES.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-gray-600">Status</label>
                      <select value={ann.status} onChange={(e) => onUpdateAnnotation(ann.id, { status: e.target.value })} className="mt-1 w-full rounded-2xl border-gray-300 text-sm">
                        {DEFAULT_STATUSES.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-gray-600">Peça</label>
                      <input value={ann.objectName || ""} onChange={(e) => onUpdateAnnotation(ann.id, { objectName: e.target.value })} className="mt-1 w-full rounded-2xl border-gray-300 text-sm px-3 py-2" placeholder="Ex: Braço, Base, Travessa" />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-[11px] text-gray-600">Observações</label>
                      <textarea value={ann.note} onChange={(e) => onUpdateAnnotation(ann.id, { note: e.target.value })} className="mt-1 w-full rounded-2xl border-gray-300 text-sm px-3 py-2" rows={3} placeholder="Descreva o problema, medições, etc." />
                    </div>
                    <div className="col-span-2 flex items-center justify-between">
                      <button onClick={() => onSelectAnnotation(ann.id)} className="px-3 py-2 rounded-2xl text-sm font-semibold bg-gray-100 hover:bg-gray-200">Localizar no modelo</button>
                      <button onClick={() => onDeleteAnnotation(ann.id)} className="px-3 py-2 rounded-2xl text-sm font-semibold bg-red-50 text-red-600 hover:bg-red-100">Excluir</button>
                    </div>
                  </div>
                </div>
              ))}

              {annotations.length === 0 && (
                <div className="text-sm text-gray-600 bg-white border border-dashed border-gray-300 rounded-2xl p-4">
                  Nenhuma anotação ainda. Ative <span className="font-semibold">Adicionar anotação</span> e toque no modelo para marcar.
                </div>
              )}
            </div>

            <div className="p-3 text-[11px] text-gray-500 border-t">
              Dica: 1 dedo gira · 2 dedos move/zoom. O isolamento ativa ao tocar em uma peça; use "Sair do isolamento" para retornar.
            </div>
          </div>
        )}
      </div>

      {/* Botão flutuante para reabrir a sidebar quando minimizada */}
      {sidebarCollapsed && (
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="hidden lg:flex fixed right-3 top-20 z-40 px-3 py-2 rounded-2xl border bg-white shadow text-sm font-semibold hover:bg-gray-50"
          title="Mostrar painel de anotações"
        >
          &lt;&lt;
        </button>
      )}
    </div>
  );
}
