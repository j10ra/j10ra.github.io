import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

const COLOR_BASE = new THREE.Color("#5d4730");
const COLOR_PULSE = new THREE.Color("#f5d8a8");

const NODE_COUNT = 56;
const VOL_X = 16;
const VOL_Y = 5.5;
const NEIGHBORS_PER_NODE = 3;
const DRIFT_RADIUS = 0.35;

type Node = {
  base: THREE.Vector3;
  pos: THREE.Vector3;
  driftPhaseX: number;
  driftPhaseY: number;
  driftFreqX: number;
  driftFreqY: number;
};

type Edge = {
  a: number;
  b: number;
  baseDist: number;
  pulsePhase: number; // 0..1 random offset
  pulsePeriod: number; // seconds, varies per edge
};

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function buildNetwork() {
  const rand = rng(31);
  const nodes: Node[] = [];

  // distribute nodes with slight grid bias to avoid pure-random galaxy look
  const cols = 12;
  const rows = Math.ceil(NODE_COUNT / cols);
  for (let i = 0; i < NODE_COUNT; i++) {
    const cx = i % cols;
    const ry = Math.floor(i / cols);
    const cellX = (cx / (cols - 1) - 0.5) * VOL_X;
    const cellY = (ry / Math.max(1, rows - 1) - 0.5) * VOL_Y;
    const jitterX = (rand() - 0.5) * (VOL_X / cols) * 0.9;
    const jitterY = (rand() - 0.5) * (VOL_Y / rows) * 0.9;
    const base = new THREE.Vector3(cellX + jitterX, cellY + jitterY, 0);
    nodes.push({
      base,
      pos: base.clone(),
      driftPhaseX: rand() * Math.PI * 2,
      driftPhaseY: rand() * Math.PI * 2,
      driftFreqX: 0.08 + rand() * 0.1,
      driftFreqY: 0.07 + rand() * 0.09,
    });
  }

  // For each node, find its k nearest neighbors and create edges (deduped)
  const edgeSet = new Set<string>();
  const edges: Edge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const dists: Array<{ idx: number; d: number }> = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      dists.push({ idx: j, d: nodes[i].base.distanceTo(nodes[j].base) });
    }
    dists.sort((a, b) => a.d - b.d);
    for (let k = 0; k < NEIGHBORS_PER_NODE; k++) {
      const j = dists[k].idx;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({
        a: Math.min(i, j),
        b: Math.max(i, j),
        baseDist: dists[k].d,
        pulsePhase: rand(),
        pulsePeriod: 7 + rand() * 9, // 7–16s per pulse cycle
      });
    }
  }

  return { nodes, edges };
}

function Network() {
  const group = useRef<THREE.Group>(null);
  const lineMatRef = useRef<THREE.LineBasicMaterial>(null);

  const { nodes, edges } = useMemo(buildNetwork, []);

  const lineGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(edges.length * 6), 3)
    );
    g.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(edges.length * 6), 3)
    );
    return g;
  }, [edges]);

  const nodeGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(nodes.length * 3), 3)
    );
    return g;
  }, [nodes]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // drift each node in a small orbit around its base
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.pos.x =
        n.base.x +
        Math.sin(t * n.driftFreqX + n.driftPhaseX) * DRIFT_RADIUS;
      n.pos.y =
        n.base.y +
        Math.cos(t * n.driftFreqY + n.driftPhaseY) * DRIFT_RADIUS;
    }

    // update node points
    const nAttr = nodeGeom.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < nodes.length; i++) {
      nAttr.setXYZ(i, nodes[i].pos.x, nodes[i].pos.y, 0);
    }
    nAttr.needsUpdate = true;

    // update line positions + per-edge pulse colors
    const lAttr = lineGeom.getAttribute("position") as THREE.BufferAttribute;
    const cAttr = lineGeom.getAttribute("color") as THREE.BufferAttribute;
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      const a = nodes[e.a].pos;
      const b = nodes[e.b].pos;
      lAttr.setXYZ(k * 2, a.x, a.y, 0);
      lAttr.setXYZ(k * 2 + 1, b.x, b.y, 0);

      // pulse: brief bright moment each cycle
      const local = (t / e.pulsePeriod + e.pulsePhase) % 1;
      // bell peak in the first 12% of the cycle, dim the rest
      const peakWindow = 0.14;
      let intensity = 0;
      if (local < peakWindow) {
        const w = local / peakWindow;
        intensity = Math.sin(w * Math.PI); // 0 → 1 → 0
      }
      const r = COLOR_BASE.r + (COLOR_PULSE.r - COLOR_BASE.r) * intensity;
      const g = COLOR_BASE.g + (COLOR_PULSE.g - COLOR_BASE.g) * intensity;
      const bl = COLOR_BASE.b + (COLOR_PULSE.b - COLOR_BASE.b) * intensity;
      cAttr.setXYZ(k * 2, r, g, bl);
      cAttr.setXYZ(k * 2 + 1, r, g, bl);
    }
    lAttr.needsUpdate = true;
    cAttr.needsUpdate = true;

    if (lineMatRef.current) {
      lineMatRef.current.opacity = 0.5;
    }

    if (group.current) {
      // very gentle global sway
      group.current.position.x = Math.sin(t * 0.05) * 0.1;
      group.current.position.y = Math.cos(t * 0.06) * 0.06;
    }
  });

  return (
    <group ref={group}>
      <lineSegments geometry={lineGeom}>
        <lineBasicMaterial
          ref={lineMatRef}
          vertexColors
          transparent
          opacity={0.5}
          depthWrite={false}
        />
      </lineSegments>

      <points geometry={nodeGeom}>
        <pointsMaterial
          color="#d6a36a"
          size={0.07}
          sizeAttenuation
          transparent
          opacity={0.85}
          depthWrite={false}
        />
      </points>
    </group>
  );
}

export default function Backdrop() {
  const reduced = usePrefersReducedMotion();

  if (reduced) {
    return <div className="backdrop backdrop--static" aria-hidden="true" />;
  }

  return (
    <div className="backdrop" aria-hidden="true">
      <Canvas
        dpr={[1, 1.5]}
        gl={{
          alpha: true,
          antialias: true,
          powerPreference: "low-power",
        }}
        camera={{ position: [0, 0, 8], fov: 50 }}
      >
        <Network />
      </Canvas>
    </div>
  );
}
