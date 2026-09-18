import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fetchKnowledgeDoc } from '../api'
import type { KnowledgeDoc, KnowledgeDocDetail } from '../api'
import { Markdown } from '../components/markdown'

/** 知识链接图谱：词条 × 标签的二分关系图（Three.js 真三维 + 扎哈流线 + 轨道旋转/缩放），点击节点预览内容。 */

// 模拟空间半边长（力导向布局范围）。
const KG_SPACE = 300
const clampv = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * 图谱配色全部从 CSS 令牌实时读取，因此暗 / 浅两套主题各自成立。
 * 场景挂载时读取一次：切换主题后重开图谱页即生效，无需重建组件树。
 */
type GraphPalette = {
  dark: boolean
  paper: string
  fiberLight: string
  fiberDark: string
  doc: THREE.Color
  tag: THREE.Color
  edge: THREE.Color
  sel: THREE.Color
  hover: THREE.Color
  none: THREE.Color
  ground: THREE.Color
  hemiGround: THREE.Color
  fill: THREE.Color
  sheenDoc: THREE.Color
  sheenTag: THREE.Color
}

/** 读取 CSS 令牌的原始值。 */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 读取令牌的 sRGB 分量串，供 canvas 程序化肌理拼接 rgba()。 */
function cssVarRgb(name: string): string {
  const raw = cssVar(name)
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)
  if (hex) {
    const n = Number.parseInt(hex[1], 16)
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
  }
  const rgb = raw.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  return rgb ? `${rgb[1]},${rgb[2]},${rgb[3]}` : '255,255,255'
}

function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme !== 'light'
}

function readGraphPalette(): GraphPalette {
  const dark = isDarkTheme()
  const accent = new THREE.Color(cssVar('--accent'))
  const surface1 = new THREE.Color(cssVar('--surface-1'))
  return {
    dark,
    paper: cssVar('--bg'),
    fiberLight: cssVarRgb('--text'),
    fiberDark: cssVarRgb('--accent'),
    doc: new THREE.Color(cssVar('--surface-2')),
    tag: surface1.clone().lerp(accent, 0.22),
    edge: accent.clone(),
    sel: accent.clone(),
    hover: dark ? accent.clone().lerp(new THREE.Color(0xffffff), 0.35) : accent.clone().lerp(new THREE.Color(0x000000), 0.25),
    none: new THREE.Color(0x000000),
    ground: surface1.clone(),
    hemiGround: new THREE.Color(cssVar('--surface-2')),
    fill: new THREE.Color(cssVar('--bg-2')),
    sheenDoc: surface1.clone().lerp(accent, 0.3),
    sheenTag: surface1.clone().lerp(accent, 0.45),
  }
}

/** Three.js 场景上下文（跨 React 渲染持久化，避免重复创建渲染器）。 */
type ThreeCtx = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  group: THREE.Group
  ring: THREE.Mesh
  raycaster: THREE.Raycaster
  pointer: THREE.Vector2
  nodeMeshes: THREE.Mesh[]
  edgeMeshes: THREE.Mesh[]
  raf: number
  ro: ResizeObserver | null
  hoverId: string | null
  bumpTex: THREE.Texture | null
  palette: GraphPalette
}

/** 确定性哈希 → [0,1)，用于让每条流线以稳定而各异的角度弯曲。 */
function hashUnit(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000
}

/** 程序化肌理：底色 + 细颗粒噪点 + 横向纤维丝 + 柔和斑驳，可无缝平铺。
 *  底色与纤维色都由主题令牌给出，用于 3D 背景 / 地面 / 节点颗粒凸感。 */
function makePaperTexture(base: string, fiberLight: string, fiberDark: string): THREE.CanvasTexture {
  const size = 512
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)

  // 细颗粒噪点：乘性明暗斑，模拟纸张纤维颗粒的微起伏。
  const img = ctx.getImageData(0, 0, size, size)
  const px = img.data
  for (let i = 0; i < px.length; i += 4) {
    const n = (Math.random() - 0.5) * 14
    px[i] = Math.max(0, Math.min(255, px[i] + n))
    px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + n))
    px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + n))
  }
  ctx.putImageData(img, 0, 0)

  // 横向纤维丝：柔细长丝，跨上下边界各复制一份实现无缝平铺。
  ctx.lineWidth = 0.5
  for (let k = 0; k < 220; k++) {
    const y = Math.random() * size
    const len = size * (0.35 + Math.random() * 0.6)
    const x = Math.random() * size
    const bend = (Math.random() - 0.5) * 6
    const alpha = 0.03 + Math.random() * 0.05
    const tone = Math.random() > 0.5 ? fiberDark : fiberLight
    for (const off of [-size, 0, size]) {
      const gy = y + off
      const grad = ctx.createLinearGradient(x, gy, x + len, gy)
      grad.addColorStop(0, `rgba(${tone},0)`)
      grad.addColorStop(0.5, `rgba(${tone},${alpha})`)
      grad.addColorStop(1, `rgba(${tone},0)`)
      ctx.strokeStyle = grad
      ctx.beginPath()
      ctx.moveTo(x, gy)
      ctx.quadraticCurveTo(x + len / 2, gy + bend, x + len, gy)
      ctx.stroke()
    }
  }

  // 柔和斑驳：几团极淡明暗，模拟纸浆不匀，越界团块四周复制以无缝平铺。
  for (let k = 0; k < 26; k++) {
    const cx = Math.random() * size
    const cy = Math.random() * size
    const r = 40 + Math.random() * 120
    const light = Math.random() > 0.45
    const a = 0.02 + Math.random() * 0.03
    const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    g2.addColorStop(0, light ? `rgba(${fiberLight},${a})` : `rgba(${fiberDark},${a})`)
    g2.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g2
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath()
        ctx.arc(cx + ox, cy + oy, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** 节点材质：清漆 + 微绒面 + 颗粒凸感。暗色下更接近冷玻璃，浅色下保持纸感。 */
function makeNodeMaterial(kind: 'doc' | 'tag', bump: THREE.Texture | null | undefined, palette: GraphPalette): THREE.MeshPhysicalMaterial {
  const p = palette
  return new THREE.MeshPhysicalMaterial({
    color: kind === 'doc' ? p.doc : p.tag,
    roughness: p.dark ? 0.28 : 0.3,
    metalness: p.dark ? 0.35 : 0.0,
    clearcoat: p.dark ? 0.85 : 0.65,
    clearcoatRoughness: p.dark ? 0.2 : 0.35,
    iridescence: p.dark ? 0.35 : 0.22,
    iridescenceIOR: 1.3,
    sheen: p.dark ? 0.5 : 0.36,
    sheenRoughness: 0.5,
    sheenColor: kind === 'doc' ? p.sheenDoc : p.sheenTag,
    bumpMap: bump ?? null,
    bumpScale: bump ? (p.dark ? 0.35 : 0.5) : 0,
    transparent: true,
    opacity: 1,
    emissive: new THREE.Color(0x000000),
  })
}

/** 节点间以二次贝塞尔弧线（TubeGeometry）相连，弯曲方向由哈希确定、彼此各异。 */
function makeEdgeTube(a: THREE.Vector3, b: THREE.Vector3, seed: number, color: THREE.Color): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a)
  const dist = dir.length() || 1
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
  const ref = Math.abs(dir.y) > 0.9 * dist ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const perp = new THREE.Vector3().crossVectors(dir, ref).normalize()
  const tilt = new THREE.Vector3().crossVectors(dir, perp).normalize()
  const bend = dist * 0.24
  const ang = seed * Math.PI * 2
  const ctrl = mid.clone().addScaledVector(perp, Math.cos(ang) * bend).addScaledVector(tilt, Math.sin(ang) * bend)
  const curve = new THREE.QuadraticBezierCurve3(a.clone(), ctrl, b.clone())
  const radius = Math.max(0.5, Math.min(1.4, dist * 0.006))
  const geo = new THREE.TubeGeometry(curve, 28, radius, 7, false)
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32 })
  return new THREE.Mesh(geo, mat)
}

/** 释放 group 内所有网格的几何体与材质。 */
function disposeGroup(group: THREE.Group): void {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const c = group.children[i] as THREE.Mesh
    group.remove(c)
    if (c.geometry) c.geometry.dispose()
    const m = c.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(m)) m.forEach((x) => x.dispose())
    else if (m) m.dispose()
  }
}

export function KnowledgeGraph({
  docs,
  onToast,
}: {
  docs: KnowledgeDoc[]
  onToast: (message: string) => void
}) {
  const [sel, setSel] = useState<{ kind: 'doc' | 'tag'; id: string } | null>(null)
  const [selDoc, setSelDoc] = useState<KnowledgeDocDetail | null>(null)
  const [fetching, setFetching] = useState(false)
  const [positions, setPositions] = useState<Map<string, { x: number; y: number; z: number }> | null>(null)
  const [hoverInfo, setHoverInfo] = useState<{ title: string; sub: string } | null>(null)

  const mountRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const threeRef = useRef<ThreeCtx | null>(null)
  const focusSetRef = useRef<Set<string> | null>(null)
  const selRef = useRef<{ kind: 'doc' | 'tag'; id: string } | null>(null)
  const selectNodeRef = useRef<(n: { kind: 'doc' | 'tag'; id: string }) => void>(() => {})

  const { nodes, edges } = useMemo(() => buildKnowledgeGraph(docs), [docs])

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of docs) for (const t of d.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  }, [docs])

  // 三维力导向布局（收敛后一次性渲染，避免运行时抖动）
  useEffect(() => {
    if (!nodes.length) return
    const sim = nodes.map((n) => ({
      ...n,
      x: (Math.random() - 0.5) * KG_SPACE * 1.2,
      y: (Math.random() - 0.5) * KG_SPACE * 1.2,
      z: (Math.random() - 0.5) * KG_SPACE * 1.2,
    }))
    const idx = new Map(sim.map((n, i) => [n.id, i]))
    const adj = edges
      .map((e) => [idx.get(e.source), idx.get(e.target)])
      .filter((pair): pair is [number, number] => typeof pair[0] === 'number' && typeof pair[1] === 'number')
    // 迭代次数按规模自适应：力导向是全对 O(n²) 计算，词条上百后再跑满 320 次
    // 会把主线程冻结好几秒（切换标签页时表现为「点了没反应」）。
    // 布局精度对可视化而言够用即可，先保证「打得开」。
    const iterations = sim.length > 160 ? 60 : sim.length > 80 ? 140 : 320
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          const dx = sim[i].x - sim[j].x
          const dy = sim[i].y - sim[j].y
          const dz = sim[i].z - sim[j].z
          const d2 = dx * dx + dy * dy + dz * dz || 1
          const d = Math.sqrt(d2)
          const rf = (sim[i].kind === 'doc' ? 1.5 : 1) * (sim[j].kind === 'doc' ? 1.5 : 1)
          const f = Math.min(9000, (rf * 5200) / d2)
          const fx = (f * dx) / d
          const fy = (f * dy) / d
          const fz = (f * dz) / d
          sim[i].vx += fx
          sim[i].vy += fy
          sim[i].vz += fz
          sim[j].vx -= fx
          sim[j].vy -= fy
          sim[j].vz -= fz
        }
      }
      for (const [a, b] of adj) {
        const dx = sim[b].x - sim[a].x
        const dy = sim[b].y - sim[a].y
        const dz = sim[b].z - sim[a].z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
        const f = (sim[a].kind === 'doc' && sim[b].kind === 'doc' ? 0.004 : 0.01) * d
        const fx = (f * dx) / d
        const fy = (f * dy) / d
        const fz = (f * dz) / d
        sim[a].vx += fx
        sim[a].vy += fy
        sim[a].vz += fz
        sim[b].vx -= fx
        sim[b].vy -= fy
        sim[b].vz -= fz
      }
      for (const n of sim) {
        n.vx += -n.x * 0.006
        n.vy += -n.y * 0.006
        n.vz += -n.z * 0.006
        n.vx *= 0.86
        n.vy *= 0.86
        n.vz *= 0.86
        n.x += n.vx
        n.y += n.vy
        n.z += n.vz
      }
    }
    for (const n of sim) {
      n.x = clampv(n.x, -KG_SPACE, KG_SPACE)
      n.y = clampv(n.y, -KG_SPACE, KG_SPACE)
      n.z = clampv(n.z, -KG_SPACE, KG_SPACE)
    }
    setPositions(new Map(sim.map((n) => [n.id, { x: n.x, y: n.y, z: n.z }])))
  }, [nodes, edges])

  // 邻居关系
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, new Set())
      if (!m.has(e.target)) m.set(e.target, new Set())
      m.get(e.source)!.add(e.target)
      m.get(e.target)!.add(e.source)
    }
    return m
  }, [edges])

  const focusSet = useMemo(() => {
    if (!sel) return null
    const s = new Set<string>([sel.id])
    const nb = neighbors.get(sel.id)
    if (nb) for (const x of nb) s.add(x)
    return s
  }, [sel, neighbors])

  const groupDocs = (tag: string) => docs.filter((d) => d.tags?.includes(tag))

  const selectNode = async (n: { kind: 'doc' | 'tag'; id: string }) => {
    setSel(n)
    if (n.kind === 'doc') {
      setFetching(true)
      try {
        setSelDoc(await fetchKnowledgeDoc(n.id))
      } catch (e) {
        setSelDoc(null)
        onToast(e instanceof Error ? e.message : String(e))
      } finally {
        setFetching(false)
      }
    } else {
      setSelDoc(null)
    }
  }

  // 将最新的选中态 / 聚焦集合 / 选择回调写入 ref，供挂载一次的 Three.js 渲染循环读取。
  focusSetRef.current = focusSet
  selRef.current = sel
  selectNodeRef.current = (n) => {
    void selectNode(n)
  }

  // 挂载一次：创建渲染器 / 相机 / 灯光 / 轨道控制 / 地面柔影 / 选择轨道环，并启动渲染循环。
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const palette = readGraphPalette()
    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(palette.paper, 980, 2500)

    // 程序化肌理：整面背景 + 地面（同纹理，分别 Control 平铺参数）。
    const paperBack = makePaperTexture(palette.paper, palette.fiberLight, palette.fiberDark)
    paperBack.wrapS = paperBack.wrapT = THREE.ClampToEdgeWrapping
    scene.background = paperBack
    const paperGround = makePaperTexture(palette.paper, palette.fiberLight, palette.fiberDark)
    paperGround.repeat.set(36, 36)

    const camera = new THREE.PerspectiveCamera(42, 1, 1, 6000)
    camera.position.set(0, 200, 860)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.06
    renderer.domElement.className = 'kb-graph-canvas'
    mount.appendChild(renderer.domElement)

    // 光环境：半球环境光 + 主光（柔影） + 冷调补光；暗色下整体压暗，靠自发光点出选中态。
    scene.add(new THREE.HemisphereLight(0xffffff, palette.hemiGround, palette.dark ? 0.55 : 1.05))
    const key = new THREE.DirectionalLight(0xffffff, palette.dark ? 1.0 : 1.5)
    key.position.set(240, 340, 200)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -KG_SPACE - 160
    key.shadow.camera.right = KG_SPACE + 160
    key.shadow.camera.top = KG_SPACE + 160
    key.shadow.camera.bottom = -KG_SPACE - 160
    key.shadow.camera.near = 50
    key.shadow.camera.far = 1500
    key.shadow.bias = -0.0004
    key.shadow.radius = 6
    scene.add(key)
    const fill = new THREE.DirectionalLight(palette.fill, palette.dark ? 0.35 : 0.5)
    fill.position.set(-260, -140, -220)
    scene.add(fill)

    // 地面柔影 + 纸感：漂浮的形态落在带纸张肌理的纸面上。
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ map: paperGround, roughness: 1.0, metalness: 0, color: palette.ground })
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -KG_SPACE - 60
    ground.receiveShadow = true
    scene.add(ground)

    // 选择轨道环：仅在选中节点时出现的绕行丝带。
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.03, 12, 80),
      new THREE.MeshBasicMaterial({ color: palette.sel, transparent: true, opacity: 0.85 })
    )
    ring.visible = false
    scene.add(ring)

    const group = new THREE.Group()
    scene.add(group)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.rotateSpeed = 0.65
    // 缓慢自转是持续动画，系统要求减少动效时关闭。
    controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    controls.autoRotateSpeed = 0.55
    controls.minDistance = 280
    controls.maxDistance = 2400
    controls.target.set(0, 0, 0)

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const ctx: ThreeCtx = { renderer, scene, camera, controls, group, ring, raycaster, pointer, nodeMeshes: [], edgeMeshes: [], raf: 0, ro: null, hoverId: null, bumpTex: paperGround, palette }
    threeRef.current = ctx

    const setSize = () => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    setSize()
    const ro = new ResizeObserver(setSize)
    ro.observe(mount)
    ctx.ro = ro

    const el = renderer.domElement
    const updatePointer = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }
    const pick = (): THREE.Mesh | null => {
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(ctx.nodeMeshes, false)
      return hits.length ? (hits[0].object as THREE.Mesh) : null
    }
    const onMove = (e: PointerEvent) => {
      updatePointer(e)
      const hit = pick()
      const id = hit ? (hit.userData.id as string) : null
      if (id !== ctx.hoverId) {
        ctx.hoverId = id
        el.style.cursor = id ? 'pointer' : 'grab'
        if (hit) {
          const u = hit.userData
          setHoverInfo({ title: u.kind === 'doc' ? (u.label as string) : (u.tag as string), sub: u.kind === 'doc' ? '词条' : `标签 · ${u.count} 篇` })
        } else {
          setHoverInfo(null)
        }
      }
      if (hit && tipRef.current) {
        const rect = el.getBoundingClientRect()
        tipRef.current.style.left = `${e.clientX - rect.left + 14}px`
        tipRef.current.style.top = `${e.clientY - rect.top + 12}px`
      }
    }
    let downPos: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      downPos = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent) => {
      if (!downPos) return
      const moved = Math.abs(e.clientX - downPos.x) + Math.abs(e.clientY - downPos.y)
      downPos = null
      if (moved > 6) return
      updatePointer(e)
      const hit = pick()
      if (hit) selectNodeRef.current({ kind: hit.userData.kind, id: hit.userData.id })
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)

    const tick = () => {
      ctx.raf = requestAnimationFrame(tick)
      controls.update()
      const focus = focusSetRef.current
      const selId = selRef.current?.id ?? null
      for (const m of ctx.nodeMeshes) {
        const id = m.userData.id as string
        const mat = m.material as THREE.MeshPhysicalMaterial
        const target = focus ? (focus.has(id) ? 1 : 0.16) : 1
        mat.opacity += (target - mat.opacity) * 0.12
        const isSel = id === selId
        const isHover = id === ctx.hoverId
        mat.emissive.lerp(isSel ? ctx.palette.sel : isHover ? ctx.palette.hover : ctx.palette.none, 0.15)
        const targetScale = isSel ? 1.18 : isHover ? 1.1 : 1
        m.scale.setScalar(m.scale.x + (targetScale - m.scale.x) * 0.15)
      }
      for (const t of ctx.edgeMeshes) {
        const a = t.userData.source as string
        const b = t.userData.target as string
        const mat = t.material as THREE.MeshBasicMaterial
        const target = focus ? (focus.has(a) && focus.has(b) ? 0.62 : 0.05) : 0.32
        mat.opacity += (target - mat.opacity) * 0.12
      }
      if (ring.visible) {
        ring.rotation.z += 0.012
        ring.rotation.x = Math.PI / 2.3 + Math.sin(performance.now() * 0.001) * 0.12
      }
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(ctx.raf)
      ro.disconnect()
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      controls.dispose()
      disposeGroup(group)
      const ringMat = ring.material as THREE.Material
      ring.geometry.dispose()
      ringMat.dispose()
      const groundMat = ground.material as THREE.Material
      ground.geometry.dispose()
      groundMat.dispose()
      paperBack.dispose()
      paperGround.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      threeRef.current = null
    }
  }, [])

  // 依据力导向布局位置重建节点网格与流线管道（位置就绪后一次构建）。
  useEffect(() => {
    const ctx = threeRef.current
    if (!ctx || !positions) return
    disposeGroup(ctx.group)
    ctx.nodeMeshes = []
    ctx.edgeMeshes = []
    ctx.hoverId = null
    setHoverInfo(null)
    const nodePos = new Map<string, THREE.Vector3>()
    for (const n of nodes) {
      const p = positions.get(n.id)
      if (p) nodePos.set(n.id, new THREE.Vector3(p.x, p.y, p.z))
    }
    for (const e of edges) {
      const a = nodePos.get(e.source)
      const b = nodePos.get(e.target)
      if (!a || !b) continue
      const tube = makeEdgeTube(a, b, hashUnit(`${e.source}|${e.target}`), ctx.palette.edge)
      tube.userData = { source: e.source, target: e.target }
      ctx.group.add(tube)
      ctx.edgeMeshes.push(tube)
    }
    for (const n of nodes) {
      const p = nodePos.get(n.id)
      if (!p) continue
      const baseRadius = n.r * 1.5
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(baseRadius, 40, 28), makeNodeMaterial(n.kind, ctx.bumpTex, ctx.palette))
      mesh.position.copy(p)
      mesh.castShadow = true
      mesh.userData = { id: n.id, kind: n.kind, label: n.label, tag: n.tag, count: n.kind === 'tag' ? tagCounts.get(n.tag ?? '') ?? 0 : 0, baseRadius }
      ctx.group.add(mesh)
      ctx.nodeMeshes.push(mesh)
    }
  }, [positions, nodes, edges, tagCounts])

  // 选择轨道环跟随选中节点。
  useEffect(() => {
    const ctx = threeRef.current
    if (!ctx) return
    const mesh = sel ? ctx.nodeMeshes.find((m) => m.userData.id === sel.id) : undefined
    if (mesh) {
      ctx.ring.visible = true
      ctx.ring.position.copy(mesh.position)
      ctx.ring.scale.setScalar((mesh.userData.baseRadius as number) * 2.1)
    } else {
      ctx.ring.visible = false
    }
  }, [sel, positions, nodes])

  return (
    <div className="kb-graph">
      <div className="kb-graph-hint">
        <span className="kg-legend"><i className="kg-dot doc" />词条</span>
        <span className="kg-legend"><i className="kg-dot tag" />标签</span>
        <span className="kg-tip">拖拽旋转 · 滚轮缩放 · 点击节点在下方预览</span>
      </div>
      <div ref={mountRef} className="kb-graph-3d">
        {(!positions || !docs.length) && (
          <div className="kg-empty">{docs.length ? '正在生成图谱…' : '知识库为空，上传文档后自动生成信息链接图谱。'}</div>
        )}
        <div ref={tipRef} className={`kg-tooltip${hoverInfo ? ' show' : ''}`}>
          {hoverInfo && (
            <>
              <div className="kg-tooltip-title">{hoverInfo.title}</div>
              <div className="kg-tooltip-sub">{hoverInfo.sub}</div>
            </>
          )}
        </div>
      </div>

      {sel && (
        <div className="kb-graph-preview">
          {sel.kind === 'doc' ? (
            selDoc ? (
              <>
                <div className="sub-model-head">
                  <span className="sub-idx">{selDoc.source} · {selDoc.title}</span>
                  <button className="btn-link" onClick={() => { setSel(null); setSelDoc(null) }}>收起</button>
                </div>
                <div className="meta">{selDoc.contentLength} 字符 · {selDoc.chunkCount} 分块 · {new Date(selDoc.createdAt).toLocaleString()}</div>
                {selDoc.tags?.length ? (
                  <div className="cap-tags my-2">
                    {selDoc.tags.map((t) => <span key={t} className="cap-tag">{t}</span>)}
                  </div>
                ) : null}
                <div className="kb-doc-content"><Markdown text={selDoc.content} onPreview={() => {}} /></div>
              </>
            ) : (
              <div className="empty-hint">{fetching ? '加载词条中…' : '该词条无内容'}</div>
            )
          ) : (
            <>
              <div className="sub-model-head">
                <span className="sub-idx">标签「{sel.id.replace(/^tag:/, '')}」关联 {groupDocs(sel.id.replace(/^tag:/, '')).length} 个词条</span>
                <button className="btn-link" onClick={() => setSel(null)}>收起</button>
              </div>
              <div className="kb-graph-group">
                {groupDocs(sel.id.replace(/^tag:/, '')).map((d) => (
                  <button key={d.id} className="btn-link" onClick={() => void selectNode({ kind: 'doc', id: d.id })}>{d.title}（{d.chunkCount} 分块）</button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 根据分块数计算节点半径。 */
function clampNodeRadius(v: number, min: number, max: number): number {
  const s = Math.sqrt(Math.max(1, v))
  return Math.max(min, Math.min(max, 4 + s * 1.6))
}

/** 图谱节点：词条（doc）或标签（tag）。 */
type GraphNode = {
  id: string
  kind: 'doc' | 'tag'
  label: string
  doc?: KnowledgeDoc
  tag?: string
  r: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

/** 构建词条 × 标签二分图节点与边。 */
function buildKnowledgeGraph(docs: KnowledgeDoc[]): { nodes: GraphNode[]; edges: Array<{ source: string; target: string }> } {
  const nodes: GraphNode[] = []
  const edges: Array<{ source: string; target: string }> = []
  const tagFreq = new Map<string, number>()
  for (const d of docs) for (const t of d.tags ?? []) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1)
  for (const d of docs) {
    nodes.push({ id: d.id, kind: 'doc', label: d.title, doc: d, tag: undefined, r: clampNodeRadius(d.chunkCount, 5, 15), x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })
  }
  for (const [tag, freq] of tagFreq) {
    nodes.push({ id: `tag:${tag}`, kind: 'tag', label: tag, doc: undefined, tag, r: clampNodeRadius(freq, 3, 8), x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })
  }
  for (const d of docs) for (const t of d.tags ?? []) edges.push({ source: d.id, target: `tag:${t}` })
  return { nodes, edges }
}
