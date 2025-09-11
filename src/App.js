import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";

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

const STATUS_COLORS = {
  Aberto: 0xff5555, // Vermelho
  "Em andamento": 0xffcc66, // Amarelo/Laranja
  Resolvido: 0x66cc66, // Verde
  Ignorado: 0x999999, // Cinza
};

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [showTutorial, setShowTutorial] = useState(true);
  const [contextMenu, setContextMenu] = useState(null);

  // --- espelhos/refres de estado para usar nos handlers (sem recriar o viewer)
  const annotationsRef = useRef(annotations);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  useEffect(() => { isPlacingRef.current = isPlacing; }, [isPlacing]);
  useEffect(() => { modelGroupRef.current = modelGroup; }, [modelGroup]);
  useEffect(() => { isIsolationModeRef.current = isIsolationMode; }, [isIsolationMode]);

  // Função para colorir peças
  const colorizePiece = useCallback((object, color) => {
    if (!object) return;
    object.traverse((child) => {
      if (child.isMesh) {
        if (!child.userData.originalMaterial) {
          child.userData.originalMaterial = child.material;
        }
        const newMaterial = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.7,
          metalness: 0.1,
        });
        child.material = newMaterial;
        child.material.needsUpdate = true;
      }
    });
  }, []);

  // Restaurar cor original
  const restoreOriginalColor = useCallback((object) => {
    if (!object) return;
    object.traverse((child) => {
      if (child.isMesh && child.userData.originalMaterial) {
        child.material = child.userData.originalMaterial;
        child.material.needsUpdate = true;
      }
    });
  }, []);

  // Colorir peça por status (por nome)
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

  // Restaurar cor original por nome
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

  // Init viewer (once) - tablet friendly
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f7f8);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      55,
      mount.clientWidth / mount.clientHeight,
      0.1,
      10000
    );
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

    // Click para marcar/ isolar
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

      // Isolar peça somente se o Modo isolamento estiver ativo (usa ref)
      if (isIsolationModeRef.current) {
        applyIsolation(root);
      }

      // Se não estiver marcando, só isola (se ativo) e sai
      if (!isPlacingRef.current) return;

      const id = uuidv4();
      const normal =
        hit.face && hit.object
          ? hit.face.normal
              .clone()
              .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
          : new THREE.Vector3(0, 1, 0);
      const pieceName =
        (root && root.name) ||
        ((hit.object.parent && hit.object.parent.name) || hit.object.name) ||
        "";

      // Evita duplicidade por peça (usa ref)
      if (annotationsRef.current.some((a) => a.objectName === pieceName)) {
        alert("Já existe uma anotação para esta peça. Edite a anotação existente.");
        return;
      }

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

      // Colorir a peça com base no status
      colorizePieceByStatus(pieceName, ann.status);
    };
    renderer.domElement.addEventListener("click", onClick, { passive: true });

    // Context menu (long press)
    let longPressTimer;
    const onTouchStart = (event) => {
      if (event.touches.length !== 1) return;
      longPressTimer = setTimeout(() => {
        const rect = renderer.domElement.getBoundingClientRect();
        const touch = event.touches[0];
        const mx = (touch.clientX - rect.left) / rect.width;
        const my = (touch.clientY - rect.top) / rect.height;
        const mouse = new THREE.Vector2(mx * 2 - 1, -(my * 2 - 1));
        raycaster.setFromCamera(mouse, cameraRef.current);
        const intersects = raycaster.intersectObjects(modelGroupRef.current.children, true);
        if (intersects.length === 0) return;

        const hit = intersects[0];
        const root = getPieceRoot(hit.object);
        const pieceName = (root && root.name) || hit.object.name || "";

        // Evitar duplicidade usando ref
        if (annotationsRef.current.some((a) => a.objectName === pieceName)) {
          alert("Já existe uma anotação para esta peça. Edite a anotação existente.");
          return;
        }

        setContextMenu({
          x: touch.clientX,
          y: touch.clientY,
          pieceName: pieceName,
          position: [hit.point.x, hit.point.y, hit.point.z],
        });
      }, 500);
    };

    const onTouchEnd = () => {
      clearTimeout(longPressTimer);
    };

    renderer.domElement.addEventListener("touchstart", onTouchStart, { passive: true });
    renderer.domElement.addEventListener("touchend", onTouchEnd, { passive: true });
    renderer.domElement.addEventListener("touchmove", onTouchEnd, { passive: true });

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
      renderer.domElement.removeEventListener("touchstart", onTouchStart);
      renderer.domElement.removeEventListener("touchend", onTouchEnd);
      renderer.domElement.removeEventListener("touchmove", onTouchEnd);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement?.parentElement)
        renderer.domElement.parentElement.removeChild(renderer.domElement);
    };
  }, []); // <-- roda apenas uma vez (monta/desmonta)

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

      // Dica do MTL referenciado no OBJ (se houver)
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
    const color = STATUS_COLORS[ann.status] || 0x0070f3;
    const geo = new THREE.SphereGeometry(0.02, 16, 16);
    const mat = new THREE.MeshStandardMaterial({ color: color });
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
    targetRoot.traverse((n) => {
      if (n.isMesh) keep.add(n);
    });
    modelGroupRef.current.traverse((n) => {
      if (!n.isMesh) return;
      if (!map.has(n)) map.set(n, { material: n.material, visible: n.visible });
      if (keep.has(n)) {
        // Destaca a peça selecionada
        colorizePiece(n, 0x3399ff);
      } else {
        // Esmaece as outras
        const faded = n.material.clone();
        faded.transparent = true;
        faded.opacity = 0.1;
        faded.depthWrite = false;
        n.material = faded;
      }
    });
    setIsolatedUuid(targetRoot.uuid);
  }

  // Encontrar a peça da anotação (por nome ou proximidade)
  function findPieceForAnnotation(ann) {
    if (!modelGroupRef.current || !ann) return null;

    // 1) por nome exato
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

      const color = STATUS_COLORS[ann.status] || 0x0070f3;
      mesh.material.color.set(color);
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

    // 2) Colorir a peça de acordo com o status (mesmo sem isolamento)
    if (ann && ann.objectName) {
      colorizePieceByStatus(ann.objectName, ann.status);
    }

    // 3) Focar câmera no pin/posição da anotação (sempre)
    const controls = controlsRef.current;
    const cam = cameraRef.current;
    const dist = cam.position.distanceTo(controls.target);

    let targetPos = null;
    const pin = pinsGroup.children.find((m) => m.userData.annotationId === id);
    if (pin) targetPos = pin.position.clone();
    else if (ann && ann.position)
      targetPos = new THREE.Vector3(ann.position[0], ann.position[1], ann.position[2]);

    if (targetPos) {
      controls.target.copy(targetPos);
      const dir = cam.position.clone().sub(controls.target).normalize();
      cam.position.copy(controls.target.clone().add(dir.multiplyScalar(dist)));
      controls.update();
    }
  }

  function onDeleteAnnotation(id) {
    const ann = annotations.find((a) => a.id === id);

    // Restaurar cor original da peça antes de excluir
    if (ann && ann.objectName) {
      restorePieceColor(ann.objectName);
    }

    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    const idx = pinsGroup.children.findIndex((m) => m.userData.annotationId === id);
    if (idx >= 0) pinsGroup.remove(pinsGroup.children[idx]);
    if (selectedId === id) setSelectedId(null);
  }

  function onUpdateAnnotation(id, patch) {
    setAnnotations((prev) => {
      const updatedAnnotations = prev.map((a) => (a.id === id ? { ...a, ...patch } : a));

      // Se o status foi alterado, atualize a cor da peça
      if (patch.status) {
        const ann = updatedAnnotations.find((a) => a.id === id);
        if (ann && ann.objectName) {
          colorizePieceByStatus(ann.objectName, patch.status);
        }
      }

      return updatedAnnotations;
    });
  }

  function onAddAnnotationFromContextMenu(issueType) {
    if (!contextMenu) return;

    // Verificar duplicidade usando ref
    if (annotationsRef.current.some((a) => a.objectName === contextMenu.pieceName)) {
      alert("Já existe uma anotação para esta peça. Edite a anotação existente.");
      setContextMenu(null);
      return;
    }

    const id = uuidv4();
    const ann = {
      id,
      position: contextMenu.position,
      normal: [0, 1, 0],
      objectName: contextMenu.pieceName,
      issueType: issueType,
      severity: DEFAULT_SEVERITIES[1],
      status: DEFAULT_STATUSES[0],
      note: "",
      createdAt: new Date().toISOString(),
    };

    addPin(ann);
    setAnnotations((prev) => [ann, ...prev]);
    setSelectedId(id);
    setContextMenu(null);

    // Colorir a peça com base no status
    colorizePieceByStatus(contextMenu.pieceName, ann.status);
  }

  // Export/Import/Screenshot
  function onExportJSON() {
    const payload = { model: modelInfo.name, exportedAt: new Date().toISOString(), annotations };
    downloadBlob(
      JSON.stringify(payload, null, 2),
      (modelInfo.name || "modelo") + ".anotacoes.json",
      "application/json"
    );
  }

  async function onExportXLSX() {
    if (!annotations.length) {
      alert("Nenhuma anotação para exportar!");
      return;
    }

    try {
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
        "Posição (x,y,z)": Array.isArray(ann.position)
          ? ann.position.map((n) => +n).join(", ")
          : "",
        "Normal (x,y,z)": Array.isArray(ann.normal) ? ann.normal.map((n) => +n).join(", ") : "",
      }));

      const ws = XLSX.utils.json_to_sheet(rows, {
        header: [
          "#",
          "ID",
          "Modelo",
          "Criado em",
          "Peça",
          "Tipo",
          "Severidade",
          "Status",
          "Observações",
          "Posição (x,y,z)",
          "Normal (x,y,z)",
        ],
      });

      ws["!cols"] = [
        { wch: 4 },
        { wch: 38 },
        { wch: 28 },
        { wch: 22 },
        { wch: 22 },
        { wch: 22 },
        { wch: 12 },
        { wch: 16 },
        { wch: 60 },
        { wch: 26 },
        { wch: 26 },
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Anotações");

      const ab = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([ab], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const filename = (modelInfo.name || "modelo") + ".anotacoes.xlsx";
      downloadBlob(blob, filename, blob.type);
    } catch (e) {
      console.error("Erro ao exportar XLSX:", e);
      alert("Erro ao exportar para Excel. Verifique o console para mais detalhes.");
    }
  }

  function onImportJSON(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        if (!Array.isArray(data.annotations)) throw new Error("JSON inválido");

        // Restaurar cores das peças antes de importar novas anotações
        annotations.forEach((ann) => {
          if (ann.objectName) {
            restorePieceColor(ann.objectName);
          }
        });

        setAnnotations(data.annotations);
        clearPins();
        data.annotations.forEach(addPin);

        // Aplicar cores baseadas no status das novas anotações
        data.annotations.forEach((ann) => {
          if (ann.objectName) {
            colorizePieceByStatus(ann.objectName, ann.status);
          }
        });

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
    renderer.domElement.toBlob((blob) => {
      if (blob) downloadBlob(blob, "screenshot.png", "image/png");
    });
  }

  // Navigation between annotations
  function goToNextAnnotation() {
    if (annotations.length === 0) return;
    const currentIndex = annotations.findIndex((a) => a.id === selectedId);
    const nextIndex = (currentIndex + 1) % annotations.length;
    onSelectAnnotation(annotations[nextIndex].id);
  }

  function goToPrevAnnotation() {
    if (annotations.length === 0) return;
    const currentIndex = annotations.findIndex((a) => a.id === selectedId);
    const prevIndex = (currentIndex - 1 + annotations.length) % annotations.length;
    onSelectAnnotation(annotations[prevIndex].id);
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

          // Aplicar cores baseadas no status
          data.forEach((ann) => {
            if (ann.objectName) {
              colorizePieceByStatus(ann.objectName, ann.status);
            }
          });
        }
      } catch {
        // ignore
      }
    }
  }, [modelInfo.name, colorizePieceByStatus]);

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
      {/* App Bar Simplificada */}
      <div className="flex flex-wrap gap-2 p-2 bg-gray-100 border-b border-gray-200">
        <label className="px-3 py-2 rounded-lg bg-blue-500 text-white font-semibold active:scale-[.98]">
          📁 Carregar
          <input
            type="file"
            accept=".obj,.mtl"
            className="hidden"
            multiple
            onChange={(e) => handleFilesChosen(e.target.files)}
          />
        </label>

        <button
          onClick={() => setIsPlacing((v) => !v)}
          className={`px-3 py-2 rounded-lg font-semibold ${
            isPlacing ? "bg-emerald-600 text-white" : "bg-white border"
          }`}
          title="Toque no modelo para marcar"
        >
          {isPlacing ? "📍 Marcando…" : "📌 Anotar"}
        </button>

        <button
          onClick={() => {
            setIsIsolationMode((v) => {
              const next = !v;
              if (!next) clearIsolation();
              return next;
            });
          }}
          className={`px-3 py-2 rounded-lg font-semibold ${
            isIsolationMode ? "bg-purple-600 text-white" : "bg-white border"
          }`}
          title="Isolar peças ao clicar"
        >
          {isIsolationMode ? "🔍 Isolando" : "🔍 Isolar"}
        </button>

        <button
          onClick={() =>
            modelGroupRef.current &&
            fitCameraToObject(
              cameraRef.current,
              modelGroupRef.current,
              controlsRef.current,
              1.25
            )
          }
          className="px-3 py-2 rounded-lg bg-white border font-semibold"
        >
          🎯 Enquadrar
        </button>

        {isolatedUuid && (
          <button
            onClick={() => clearIsolation()}
            className="px-3 py-2 rounded-lg bg-white border font-semibold"
          >
            👁️ Mostrar tudo
          </button>
        )}
      </div>

      {/* Sub bar */}
      <div className="px-3 py-1 text-xs text-gray-600 border-b border-gray-100 bg-gray-50">
        {modelInfo.name ? (
          <span>
            <span className="font-medium">Modelo:</span> {modelInfo.name} ·{" "}
            {humanFileSize(modelInfo.size)}
          </span>
        ) : (
          "Carregue um arquivo .obj (e .mtl) para começar"
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 relative">
        <div ref={mountRef} className="absolute inset-0" />

        {/* Dica de gestos */}
        <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 bg-white/80 backdrop-blur rounded-xl shadow px-3 py-1 text-xs text-gray-700">
          1 dedo gira · 2 dedos move/zoom
        </div>

        {/* FABs */}
        <div className="absolute bottom-3 right-3 flex flex-col gap-2">
          <button
            onClick={() =>
              modelGroupRef.current &&
              fitCameraToObject(
                cameraRef.current,
                modelGroupRef.current,
                controlsRef.current,
                1.25
              )
            }
            className="w-12 h-12 rounded-full shadow bg-gray-900 text-white font-semibold grid place-items-center"
          >
            🎯
          </button>

          {annotations.length > 0 && (
            <>
              <button
                onClick={goToPrevAnnotation}
                className="w-12 h-12 rounded-full shadow bg-white border font-semibold grid place-items-center"
              >
                ◀
              </button>
              <button
                onClick={goToNextAnnotation}
                className="w-12 h-12 rounded-full shadow bg-white border font-semibold grid place-items-center"
              >
                ▶
              </button>
            </>
          )}

          <button
            onClick={onScreenshot}
            className="w-12 h-12 rounded-full shadow bg-white border font-semibold grid place-items-center"
          >
            📸
          </button>

          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-12 h-12 rounded-full shadow bg-white border font-semibold grid place-items-center"
          >
            {sidebarCollapsed ? "📋" : "✕"}
          </button>
        </div>

        {loading && (
          <div className="absolute inset-0 grid place-items-center bg-white/60 z-30">
            <div className="animate-pulse text-sm bg-white rounded-xl px-4 py-3 shadow border">
              Carregando modelo…
            </div>
          </div>
        )}

        {/* Tutorial Inicial */}
        {showTutorial && (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-40 p-4">
            <div className="bg-white rounded-2xl p-5 max-w-md">
              <h2 className="text-xl font-bold mb-3">Bem-vindo ao Visualizador 3D!</h2>
              <ul className="list-disc pl-5 mb-4 space-y-2">
                <li>
                  Toque com <b>um dedo</b> para rotacionar a vista
                </li>
                <li>
                  Toque com <b>dois dedos</b> para mover e dar zoom
                </li>
                <li>
                  Use o botão <b>Anotar</b> e <b>Isolar</b> e toque no modelo para marcar problemas
                </li>
                <li>Toque longo em uma peça para menu rápido de anotações</li>
                <li>
                  Cada peça pode ter apenas <b>uma anotação</b>
                </li>
              </ul>
              <button
                onClick={() => setShowTutorial(false)}
                className="w-full py-2 bg-blue-500 text-white rounded-lg font-semibold"
              >
                Entendi, vamos começar!
              </button>
            </div>
          </div>
        )}

        {/* Menu de Contexto (toque longo) */}
        {contextMenu && (
          <div 
            className="absolute z-30 bg-white rounded-xl shadow-lg border p-3"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="text-xs text-gray-500 mb-2">Adicionar à: {contextMenu.pieceName}</div>
            <div className="grid grid-cols-2 gap-2">
              {DEFAULT_ISSUES.slice(0, 4).map(issue => (
                <button
                  key={issue}
                  onClick={() => onAddAnnotationFromContextMenu(issue)}
                  className="px-3 py-2 text-xs bg-gray-100 rounded-lg hover:bg-gray-200"
                >
                  {issue}
                </button>
              ))}
            </div>
            <button 
              onClick={() => setContextMenu(null)}
              className="w-full mt-2 py-1 text-xs text-gray-500 hover:text-gray-700"
            >
              Cancelar
            </button>
          </div>
        )}
      </div>

      {/* Side Panel (lateral direita) */}
      {!sidebarCollapsed && (
        <div className="absolute right-0 top-0 bottom-0 w-full max-w-md bg-white border-l border-gray-200 shadow-lg z-20 flex flex-col">
          <div className="p-4 border-b border-gray-200 flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">Anotações</div>
              <div className="text-xs text-gray-600">{annotations.length} anotação(ões)</div>
            </div>
            
            <div className="flex gap-2">
              <button onClick={onExportJSON} className="px-3 py-2 rounded-lg text-sm font-semibold bg-gray-900 text-white">
                JSON
              </button>
              <button onClick={onExportXLSX} className="px-3 py-2 rounded-lg text-sm font-semibold bg-green-600 text-white">
                Excel
              </button>
              <button 
                onClick={() => setSidebarCollapsed(true)}
                className="w-10 h-10 rounded-lg grid place-items-center border"
              >
                ✕
              </button>
            </div>
          </div>

          {mtlHint && (
            <div className="mx-4 mt-3 mb-0 text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3">
              O OBJ referencia: <span className="font-mono">{mtlHint}</span>. Para cores/texturas, adicione o arquivo .mtl.
            </div>
          )}

          <div className="p-4 border-b">
            <label className="block text-xs font-medium text-gray-700 mb-1">Importar anotações (JSON)</label>
            <input
              type="file"
              accept="application/json"
              onChange={(e) => e.target.files?.[0] && onImportJSON(e.target.files[0])}
              className="block text-sm w-full p-2 border rounded-lg"
            />
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {annotations.map((ann) => (
              <div key={ann.id} className={`rounded-xl border ${selectedId === ann.id ? "border-blue-500" : "border-gray-200"} bg-white p-3`}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <button onClick={() => onSelectAnnotation(ann.id)} className="text-left flex-1">
                    <div className="text-sm font-semibold">{ann.issueType}</div>
                    <div className="text-xs text-gray-600">{new Date(ann.createdAt).toLocaleString()}</div>
                  </button>
                  <div className="flex items-center gap-1">
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-gray-100">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: `#${STATUS_COLORS[ann.status].toString(16).padStart(6, '0')}` }}
                      />
                      {ann.status}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-gray-600">Tipo</label>
                    <select value={ann.issueType} onChange={(e) => onUpdateAnnotation(ann.id, { issueType: e.target.value })} className="mt-1 w-full rounded-lg border-gray-300 text-xs p-2">
                      {DEFAULT_ISSUES.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600">Severidade</label>
                    <select value={ann.severity} onChange={(e) => onUpdateAnnotation(ann.id, { severity: e.target.value })} className="mt-1 w-full rounded-lg border-gray-300 text-xs p-2">
                      {DEFAULT_SEVERITIES.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600">Status</label>
                    <select value={ann.status} onChange={(e) => onUpdateAnnotation(ann.id, { status: e.target.value })} className="mt-1 w-full rounded-lg border-gray-300 text-xs p-2">
                      {DEFAULT_STATUSES.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600">Peça</label>
                    <input value={ann.objectName || ""} onChange={(e) => onUpdateAnnotation(ann.id, { objectName: e.target.value })} className="mt-1 w-full rounded-lg border-gray-300 text-xs p-2" placeholder="Ex: Braço, Base, Travessa" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-600">Observações</label>
                    <textarea value={ann.note} onChange={(e) => onUpdateAnnotation(ann.id, { note: e.target.value })} className="mt-1 w-full rounded-lg border-gray-300 text-xs p-2" rows={2} placeholder="Descreva o problema..." />
                  </div>
                  <div className="col-span-2 flex items-center justify-between mt-2">
                    <button onClick={() => onSelectAnnotation(ann.id)} className="px-3 py-2 rounded-lg text-xs font-semibold bg-gray-100">Localizar</button>
                    <button onClick={() => onDeleteAnnotation(ann.id)} className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-50 text-red-600">Excluir</button>
                  </div>
                </div>
              </div>
            ))}

            {annotations.length === 0 && (
              <div className="text-sm text-gray-600 bg-gray-50 border border-dashed border-gray-300 rounded-xl p-4 text-center">
                Nenhuma anotação ainda. Ative <span className="font-semibold">Anotar</span> e toque no modelo para marcar.
              </div>
            )}
          </div>

          {/* Legenda de Status */}
          <div className="p-3 border-t mt-auto">
            <div className="text-xs font-medium mb-2">Legenda de Status:</div>
            <div className="grid grid-cols-2 gap-2">
              {DEFAULT_STATUSES.map(status => (
                <div key={status} className="flex items-center gap-2">
                  <div 
                    className="w-3 h-3 rounded-full" 
                    style={{ 
                      backgroundColor: `#${STATUS_COLORS[status].toString(16).padStart(6, '0')}`,
                      border: STATUS_COLORS[status] === 0xffffff ? "1px solid #ccc" : "none"
                    }}
                  />
                  <span className="text-xs">{status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
