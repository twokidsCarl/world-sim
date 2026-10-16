// GPU 求解器的 WGSL 内核。每个入口与 mirror.ts 里的一个函数一一对应（同样的分支、同样的展开式），改一边必须改另一边；
// tests/softbody-gpu.test.ts 检查两边的入口和缓冲区布局对得上，浏览器里的对照（tools/softbody/gpu-check.ts）检查数值。
// The WGSL kernels of the GPU solver. Each entry point matches one function of mirror.ts (the same branches, the same
// expansions); changing one side means changing the other. tests/softbody-gpu.test.ts checks that entry points and
// buffer layout agree, and the browser comparison (tools/softbody/gpu-check.ts) checks the numbers.
//
// 缓冲区（7 个存储缓冲区，在 WebGPU 缺省的上限 8 之内）/ Buffers (7 storage buffers, within WebGPU's default limit of 8)
//   topo   u32   ringStart | ringEntry | ringSlots | nbrStart | nbr | capStart | tetOrder | volOrder | 四面体的 4 个结点 tet nodes | vlStart | vl（偏移在 G 里 / offsets in G）
//   tetD   vec4f 每个四面体 9 个：B 的三行、E₀ 的三行、(μ, λ·份额, κ, G₁)、(τ, 纤维模量, q·V_ref, V_rest)、纤维方向
//                 nine per tetrahedron: the rows of B, the rows of E₀, (μ, λ·share, κ, G₁), (τ, fibre modulus, q·V_ref, V_rest), fibre direction
//   nodeS  vec4f [0,N) (w, K, V, 0) | [N,2N) 加速度项 acceleration term | [2N,3N) 运动学结点的位移 kinematic displacement | 胶囊项 capsule entries (2 each)
//   st     vec4f [0,N) u | [N,2N) v | [2N,3N) u_prev | [3N, 3N+4·Ta) 四面体角上的压强力 pressure force per tet corner | 每个工作组的最大速度² largest speed² per workgroup
//   sc     f32   [0,N) 结点压强乘子 P nodal pressure multiplier | [N, N+6·Ta) Maxwell 支路的粘性应变 viscous strain
//   ptT    u32   所有点的 4 个结点 | 每点的种类 | (形状 << 8) | order | groupStart | 每点 8 个 f32 的位：重心坐标、(base.xyz, 1/k)
//                 the four nodes of every point | kind | (shape << 8) per point | order | groupStart | bits of 8 f32 per point: barycentric, (base.xyz, 1/k)
//   ptF    vec4f 每点一帧里累计的 (力向量, 法向力) / per point, over a frame: (force vector, normal force)

export const WORKGROUP = 64
/** 体积内核的工作组大小 = 一环里四面体的上限（也是邻居的上限）/ workgroup size of the volume kernel = the most tetrahedra in a ring (and the most neighbours) */
export const RING = 32
/** 动态 uniform 每项的字节数（≥ minUniformBufferOffsetAlignment）/ bytes per dynamic uniform entry (≥ minUniformBufferOffsetAlignment) */
export const DYN_STRIDE = 256
/** G 里形状的个数（压头 + 支撑面）/ shapes in G (probe + planes) */
export const MAX_SHAPES = 4
/** G 的字节数 / bytes of G */
export const GLOBALS_BYTES = 96 + MAX_SHAPES * 48
export const ENTRY_POINTS = ['pressure', 'predict', 'tet', 'volume', 'points', 'finish', 'speed'] as const
/** 一个着色器里的存储缓冲区个数（不超过 WebGPU 缺省的上限 8）/ storage buffers in the shader (within WebGPU's default limit of 8) */
export const STORAGE_BUFFERS = 7

export const WGSL = /* wgsl */ `
struct Shape { c: vec4f, a: vec4f, kind: u32, radius: f32, p0: u32, p1: u32 }
struct Globals {
  N: u32, Ta: u32, nodal: u32, oRS: u32,
  oRE: u32, oSL: u32, oNS: u32, oNB: u32,
  oCS: u32, oTO: u32, oVO: u32, oCap: u32,
  h: f32, ih2: f32, keep: f32, cap: f32,
  oTN: u32, oTC: u32, oSP: u32, oVS: u32,
  oVL: u32, q1: u32, q2: u32, q3: u32,
  shapes: array<Shape, ${MAX_SHAPES}>,
}
struct Dispatch { start: u32, count: u32, oKS: u32, p0: u32, p1: u32, oOrder: u32, oGroup: u32, oPD: u32 }

@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var<uniform> D: Dispatch;
@group(0) @binding(2) var<storage, read> topo: array<u32>;
@group(0) @binding(3) var<storage, read> tetD: array<vec4f>;
@group(0) @binding(4) var<storage, read> nodeS: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> st: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> sc: array<f32>;
@group(0) @binding(7) var<storage, read> ptT: array<u32>;
@group(0) @binding(8) var<storage, read_write> ptF: array<vec4f>;

fn tetN(t: u32) -> vec4u {
  let o = G.oTN + t * 4u;
  return vec4u(topo[o], topo[o + 1u], topo[o + 2u], topo[o + 3u]);
}
fn ptV(o: u32) -> vec4f {
  return vec4f(bitcast<f32>(ptT[o]), bitcast<f32>(ptT[o + 1u]), bitcast<f32>(ptT[o + 2u]), bitcast<f32>(ptT[o + 3u]));
}

const J_MIN: f32 = 0.3;

// 形变：E 的三行、H = cof(I + E) 的三行、δ = J − 1、c2 = ‖F‖² + J² − 4J（按 E 展开，见 mirror.ts 的 kinematics）
// the deformation: rows of E, rows of H = cof(I + E), δ = J − 1, c2 = ‖F‖² + J² − 4J (expanded in E; see kinematics in mirror.ts)
struct Kin { e0: vec3f, e1: vec3f, e2: vec3f, h0: vec3f, h1: vec3f, h2: vec3f, dl: f32, c2: f32 }

fn kin(t: u32) -> Kin {
  let nd = tetN(t);
  let ua = st[nd.x].xyz;
  let d0 = st[nd.y].xyz - ua;
  let d1 = st[nd.z].xyz - ua;
  let d2 = st[nd.w].xyz - ua;
  let o = t * 9u;
  let b0 = tetD[o].xyz; let b1 = tetD[o + 1u].xyz; let b2 = tetD[o + 2u].xyz;
  var k: Kin;
  k.e0 = tetD[o + 3u].xyz + d0.x * b0 + d1.x * b1 + d2.x * b2;
  k.e1 = tetD[o + 4u].xyz + d0.y * b0 + d1.y * b1 + d2.y * b2;
  k.e2 = tetD[o + 5u].xyz + d0.z * b0 + d1.z * b1 + d2.z * b2;
  let c0 = cross(k.e1, k.e2);
  let c1 = cross(k.e2, k.e0);
  let c2 = cross(k.e0, k.e1);
  let t1 = k.e0.x + k.e1.y + k.e2.z;
  let t2 = c0.x + c1.y + c2.z;
  let t3 = dot(k.e0, c0);
  k.dl = t1 + t2 + t3;
  k.h0 = vec3f(1.0 + t1, 0.0, 0.0) - vec3f(k.e0.x, k.e1.x, k.e2.x) + c0;
  k.h1 = vec3f(0.0, 1.0 + t1, 0.0) - vec3f(k.e0.y, k.e1.y, k.e2.y) + c1;
  k.h2 = vec3f(0.0, 0.0, 1.0 + t1) - vec3f(k.e0.z, k.e1.z, k.e2.z) + c2;
  k.c2 = dot(k.e0, k.e0) + dot(k.e1, k.e1) + dot(k.e2, k.e2) - 2.0 * t2 - 2.0 * t3 + k.dl * k.dl;
  return k;
}

// 角的梯度：g_c = M·(B 的第 c−1 行)ᵀ，g_0 = −其余之和；M 按行给出 / corner gradients, M given by rows
struct Grads { g0: vec3f, g1: vec3f, g2: vec3f, g3: vec3f }
fn grads(t: u32, m0: vec3f, m1: vec3f, m2: vec3f) -> Grads {
  let o = t * 9u;
  let b0 = tetD[o].xyz; let b1 = tetD[o + 1u].xyz; let b2 = tetD[o + 2u].xyz;
  var g: Grads;
  g.g1 = vec3f(dot(m0, b0), dot(m1, b0), dot(m2, b0));
  g.g2 = vec3f(dot(m0, b1), dot(m1, b1), dot(m2, b1));
  g.g3 = vec3f(dot(m0, b2), dot(m1, b2), dot(m2, b2));
  g.g0 = -g.g1 - g.g2 - g.g3;
  return g;
}

fn wOf(n: u32) -> f32 { return nodeS[n].x; }
fn addU(n: u32, d: vec3f) { st[n] = vec4f(st[n].xyz + d, 0.0); }

// 一条四面体约束的 Gauss–Seidel 解（mirror.ts 的 applyTet）/ one tetrahedron constraint, Gauss–Seidel (applyTet of mirror.ts)
fn applyTet(t: u32, m0: vec3f, m1: vec3f, m2: vec3f, c2: f32, comp: f32) {
  let g = grads(t, m0, m1, m2);
  let nd = tetN(t);
  let w0 = wOf(nd.x); let w1 = wOf(nd.y); let w2 = wOf(nd.z); let w3 = wOf(nd.w);
  let den = comp + w0 * dot(g.g0, g.g0) + w1 * dot(g.g1, g.g1) + w2 * dot(g.g2, g.g2) + w3 * dot(g.g3, g.g3);
  if (!(den > 0.0)) { return; }
  let l = -c2 / den;
  addU(nd.x, w0 * l * g.g0);
  addU(nd.y, w1 * l * g.g1);
  addU(nd.z, w2 * l * g.g2);
  addU(nd.w, w3 * l * g.g3);
}

// 内核 1：上一步的结点压强作为力，分到四个角（kPressure）/ kernel 1: the previous nodal pressures as forces per corner (kPressure)
@compute @workgroup_size(${WORKGROUP})
fn pressure(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (t >= G.Ta) { return; }
  let nd = tetN(t);
  let qv = tetD[t * 9u + 7u].z;
  var ks = 0.0;
  var ns = array<u32, 4>(nd.x, nd.y, nd.z, nd.w);
  for (var c = 0u; c < 4u; c++) {
    let V = nodeS[ns[c]].z;
    if (V > 1e-15) { ks += sc[ns[c]] / V; }
  }
  let kk = ks * qv;
  if (kk == 0.0) {
    for (var c = 0u; c < 4u; c++) { st[G.oTC + t * 4u + c] = vec4f(0.0); }
    return;
  }
  let k = kin(t);
  let g = grads(t, k.h0, k.h1, k.h2);
  st[G.oTC + t * 4u] = vec4f(kk * g.g0, 0.0);
  st[G.oTC + t * 4u + 1u] = vec4f(kk * g.g1, 0.0);
  st[G.oTC + t * 4u + 2u] = vec4f(kk * g.g2, 0.0);
  st[G.oTC + t * 4u + 3u] = vec4f(kk * g.g3, 0.0);
}

// 内核 2：收压强力，预测位置（kPredict）/ kernel 2: gathers the pressure forces, predicts the position (kPredict)
@compute @workgroup_size(${WORKGROUP})
fn predict(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let N = G.N;
  if (i >= N) { return; }
  var f = vec3f(0.0);
  if (G.nodal != 0u) {
    for (var r = topo[G.oRS + i]; r < topo[G.oRS + i + 1u]; r++) { f += st[G.oTC + topo[G.oRE + r]].xyz; }
  }
  let u = st[i].xyz;
  st[2u * N + i] = vec4f(u, 0.0);
  let w = nodeS[i].x;
  if (w == 0.0) {
    st[i] = vec4f(nodeS[2u * N + i].xyz, 0.0);
    return;
  }
  let v = st[N + i].xyz * G.keep + G.h * (nodeS[N + i].xyz + f * w);
  st[i] = vec4f(u + G.h * v, 0.0);
}

// 内核 3：一种颜色的四面体，逐条 Gauss–Seidel（kTet）/ kernel 3: the tetrahedra of one colour, Gauss–Seidel (kTet)
@compute @workgroup_size(${WORKGROUP})
fn tet(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= D.count) { return; }
  let t = topo[G.oTO + D.start + gid.x];
  let o = t * 9u;
  let pa = tetD[o + 6u];
  let pb = tetD[o + 7u];
  let mu = pa.x; let la = pa.y; let kap = pa.z; let g1m = pa.w;
  let tau = pb.x; let fk = pb.y; let qv = pb.z; let vol = pb.w;
  if (qv == 0.0) { return; }
  let ih2 = G.ih2;
  var k = kin(t);
  var J = 1.0 + k.dl;
  if (mu > 0.0 && k.c2 > 0.0) {
    // P = E − (H − I) + δ·H
    let m0 = k.e0 - (k.h0 - vec3f(1.0, 0.0, 0.0)) + k.dl * k.h0;
    let m1 = k.e1 - (k.h1 - vec3f(0.0, 1.0, 0.0)) + k.dl * k.h1;
    let m2 = k.e2 - (k.h2 - vec3f(0.0, 0.0, 1.0)) + k.dl * k.h2;
    applyTet(t, m0, m1, m2, k.c2, (k.c2 * ih2) / (mu * (1.0 + kap * k.c2) * vol));
  }
  if (la > 0.0 || J <= 0.5) {
    k = kin(t);
    J = 1.0 + k.dl;
    var cc = 0.0; var comp = 0.0; var keep = true;
    if (J < J_MIN) { cc = J - J_MIN; }
    else if (la > 0.0) {
      cc = k.dl;
      comp = ih2 / (la * vol);
      if (cc == 0.0) { keep = false; }
    } else { keep = false; }
    if (keep) { applyTet(t, k.h0, k.h1, k.h2, cc, comp); }
  }
  if (g1m > 0.0) {
    k = kin(t);
    let e0 = k.e0; let e1 = k.e1; let e2 = k.e2;
    let s00 = e0.x + 0.5 * (e0.x * e0.x + e1.x * e1.x + e2.x * e2.x);
    let s11 = e1.y + 0.5 * (e0.y * e0.y + e1.y * e1.y + e2.y * e2.y);
    let s22 = e2.z + 0.5 * (e0.z * e0.z + e1.z * e1.z + e2.z * e2.z);
    let s01 = 0.5 * (e0.y + e1.x + e0.x * e0.y + e1.x * e1.y + e2.x * e2.y);
    let s02 = 0.5 * (e0.z + e2.x + e0.x * e0.z + e1.x * e1.z + e2.x * e2.z);
    let s12 = 0.5 * (e1.z + e2.y + e0.y * e0.z + e1.y * e1.z + e2.y * e2.z);
    let tr = (s00 + s11 + s22) / 3.0;
    let o6 = G.N + t * 6u;
    let q00 = s00 - tr - sc[o6]; let q11 = s11 - tr - sc[o6 + 1u]; let q22 = s22 - tr - sc[o6 + 2u];
    let q01 = s01 - sc[o6 + 3u]; let q02 = s02 - sc[o6 + 4u]; let q12 = s12 - sc[o6 + 5u];
    let kr = 1.0 - exp(-G.h / tau);
    sc[o6] += kr * q00; sc[o6 + 1u] += kr * q11; sc[o6 + 2u] += kr * q22;
    sc[o6 + 3u] += kr * q01; sc[o6 + 4u] += kr * q02; sc[o6 + 5u] += kr * q12;
    let cq = q00 * q00 + q11 * q11 + q22 * q22 + 2.0 * (q01 * q01 + q02 * q02 + q12 * q12);
    if (cq > 1e-24) {
      // P = Q + E·Q（Q 对称，按列）/ P = Q + E·Q (Q symmetric, by columns)
      let Q0 = vec3f(q00, q01, q02); let Q1 = vec3f(q01, q11, q12); let Q2 = vec3f(q02, q12, q22);
      let m0 = Q0 + vec3f(dot(e0, Q0), dot(e0, Q1), dot(e0, Q2));
      let m1 = Q1 + vec3f(dot(e1, Q0), dot(e1, Q1), dot(e1, Q2));
      let m2 = Q2 + vec3f(dot(e2, Q0), dot(e2, Q1), dot(e2, Q2));
      applyTet(t, m0, m1, m2, cq, (cq * ih2) / (2.0 * g1m * vol));
    }
  }
  if (fk > 0.0) {
    let d = tetD[o + 8u].xyz;
    if (any(d != vec3f(0.0))) {
      k = kin(t);
      let b0 = tetD[o].xyz; let b1 = tetD[o + 1u].xyz; let b2 = tetD[o + 2u].xyz;
      let s1 = dot(b0, d); let s2 = dot(b1, d); let s3 = dot(b2, d);
      let ed = vec3f(dot(k.e0, d), dot(k.e1, d), dot(k.e2, d));
      var uu = d + ed;
      let len = length(uu);
      if (len > 1e-12) {
        let cf = (2.0 * dot(d, ed) + dot(ed, ed) + (dot(d, d) - 1.0)) / (len + 1.0);
        uu = uu / len;
        let nd = tetN(t);
        let w0 = wOf(nd.x); let w1 = wOf(nd.y); let w2 = wOf(nd.z); let w3 = wOf(nd.w);
        let s0 = -s1 - s2 - s3;
        let ws = w0 * s0 * s0 + w1 * s1 * s1 + w2 * s2 * s2 + w3 * s3 * s3;
        let l = -cf / (ws + ih2 / (fk * vol));
        addU(nd.x, w0 * s0 * l * uu);
        addU(nd.y, w1 * s1 * l * uu);
        addU(nd.z, w2 * s2 * l * uu);
        addU(nd.w, w3 * s3 * l * uu);
      }
    }
  }
}

// 内核 4：一种颜色的结点体积约束（kVolume）。每个结点一个工作组（${RING} 个线程）：先每个线程算一环里的一个四面体，
// 再每个线程按事先排好的表收一个邻居的梯度，S 和 A 用树形归约求和，最后每个线程移动一个邻居。
// kernel 4: the nodal volume constraints of one colour (kVolume). One workgroup per node (${RING} threads): first each
// thread evaluates one tetrahedron of the ring, then each gathers one neighbour's gradient from a precomputed list,
// S and A are summed by a tree reduction, and last each thread moves one neighbour.
var<workgroup> vg: array<vec4f, ${RING * 4}>;
var<workgroup> vr: array<vec2f, ${RING}>;
@compute @workgroup_size(${RING})
fn volume(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let n = topo[G.oVO + D.start + wg.x];
  let r0 = topo[G.oRS + n];
  let r1 = topo[G.oRS + n + 1u];
  let ns = nodeS[n];
  let K = ns.y; let Vn = ns.z;
  // 整个工作组一起退出（条件对所有线程相同）/ the whole workgroup leaves together (the condition is uniform)
  if (r0 == r1 || !(K > 0.0) || !(Vn > 1e-15)) { return; }
  let ring = r1 - r0;
  let nb0 = topo[G.oNS + n];
  let cnt = topo[G.oNS + n + 1u] - nb0;
  var sS = 0.0;
  if (li < ring) {
    let t = topo[G.oRE + r0 + li] >> 2u;
    let qv = tetD[t * 9u + 7u].z;
    let k = kin(t);
    let g = grads(t, k.h0, k.h1, k.h2);
    sS = qv * k.dl;
    vg[li * 4u] = vec4f(qv * g.g0, 0.0);
    vg[li * 4u + 1u] = vec4f(qv * g.g1, 0.0);
    vg[li * 4u + 2u] = vec4f(qv * g.g2, 0.0);
    vg[li * 4u + 3u] = vec4f(qv * g.g3, 0.0);
  }
  workgroupBarrier();
  var gj = vec3f(0.0);
  var nj = 0u;
  var sA = 0.0;
  if (li < cnt) {
    let base = G.oVL + topo[G.oVS + n];
    let e0 = topo[base + li];
    let e1 = topo[base + li + 1u];
    let items = base + cnt + 1u;
    for (var e = e0; e < e1; e++) {
      let idx = (topo[items + (e >> 2u)] >> (8u * (e & 3u))) & 255u;
      gj += vg[idx].xyz;
    }
    nj = topo[G.oNB + nb0 + li];
    sA = wOf(nj) * dot(gj, gj);
  }
  vr[li] = vec2f(sS, sA);
  workgroupBarrier();
  for (var k = ${RING / 2}u; k > 0u; k = k >> 1u) {
    if (li < k) { vr[li] += vr[li + k]; }
    workgroupBarrier();
  }
  let S = vr[0].x;
  let iv = 1.0 / Vn;
  let A = vr[0].y * iv * iv;
  let h2 = G.h * G.h;
  let alpha = max(G.ih2 / K, A / G.cap);
  let Pn = sc[n];
  let dl = -(S * iv + alpha * Pn * h2) / (A + alpha);
  let lim = 1.5 * K;
  let pn = clamp(Pn + dl * G.ih2, -lim, lim);
  let s = (pn - Pn) * h2 * iv;
  // 所有线程都读过 sc[n] 之后才由 0 号写 / thread 0 writes sc[n] only after every thread has read it
  workgroupBarrier();
  if (A > 0.0) {
    if (li == 0u) { sc[n] = pn; }
    if (li < cnt) { addU(nj, wOf(nj) * s * gj); }
  }
}

// 内核 6：一种颜色的点组，组里的点逐个 Gauss–Seidel（kPointGroup）/ kernel 6: the point groups of one colour, points one by one (kPointGroup)
@compute @workgroup_size(${WORKGROUP})
fn points(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= D.count) { return; }
  let grp = D.start + gid.x;
  for (var q = ptT[D.oGroup + grp]; q < ptT[D.oGroup + grp + 1u]; q++) {
    let i = ptT[D.oOrder + q];
    let ks = ptT[D.oKS + i];
    let kind = ks & 255u;
    let sh = G.shapes[ks >> 8u];
    let nd = vec4u(ptT[i * 4u], ptT[i * 4u + 1u], ptT[i * 4u + 2u], ptT[i * 4u + 3u]);
    let b = ptV(D.oPD + i * 8u);
    let base = ptV(D.oPD + i * 8u + 4u);
    let qq = b.x * st[nd.x].xyz + b.y * st[nd.y].xyz + b.z * st[nd.z].xyz + b.w * st[nd.w].xyz;
    var c = 0.0; var nrm = vec3f(0.0); var alpha = 0.0; var ok = true;
    if (kind == 0u) {
      // 锚点：C = −Σ b·u / anchor
      if (base.w < 0.0) { ok = false; }
      let l = length(qq);
      if (!(l > 0.0)) { ok = false; }
      if (ok) { c = l; nrm = -qq / l; alpha = base.w * G.ih2; }
    } else if (kind == 4u) {
      c = -(base.x + dot(sh.c.xyz, qq));
      if (!(c > 0.0)) { ok = false; }
      nrm = sh.c.xyz;
    } else {
      let r = base.xyz + qq - sh.c.xyz;
      let ax = sh.a.xyz; let R = sh.radius;
      let along = dot(r, ax);
      if (kind == 3u && along < 0.0) {
        let o = r - along * ax;
        let l = length(o);
        if (along < -6.0 * R || l >= R || l < 1e-12) { ok = false; }
        else { c = R - l; nrm = o / l; }
      } else if (kind == 1u || kind == 3u) {
        let l = length(r);
        if (l >= R || l < 1e-12) { ok = false; }
        else { c = R - l; nrm = r / l; }
      } else {
        let o = r - along * ax;
        if (along >= 0.0 || along < -4.0 * R || dot(o, o) >= R * R) { ok = false; }
        else { c = -along; nrm = ax; }
      }
    }
    if (!ok) { continue; }
    let w0 = wOf(nd.x); let w1 = wOf(nd.y); let w2 = wOf(nd.z); let w3 = wOf(nd.w);
    let ws = w0 * b.x * b.x + w1 * b.y * b.y + w2 * b.z * b.z + w3 * b.w * b.w;
    if (!(ws > 0.0)) { continue; }
    let dl = c / (ws + alpha);
    addU(nd.x, w0 * b.x * dl * nrm);
    addU(nd.y, w1 * b.y * dl * nrm);
    addU(nd.z, w2 * b.z * dl * nrm);
    addU(nd.w, w3 * b.w * dl * nrm);
    let f = dl * G.ih2;
    ptF[i] += vec4f(-f * nrm, f);
  }
}

// 内核 8：骨的胶囊，然后速度（kFinish）/ kernel 8: the bone capsules, then the velocity (kFinish)
@compute @workgroup_size(${WORKGROUP})
fn finish(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let N = G.N;
  if (i >= N) { return; }
  var u = st[i].xyz;
  for (var r = topo[G.oCS + i]; r < topo[G.oCS + i + 1u]; r++) {
    let a = nodeS[G.oCap + 2u * r];
    let b = nodeS[G.oCap + 2u * r + 1u];
    let p = a.xyz + u;
    let t = clamp(dot(p, b.xyz) / a.w, 0.0, 1.0);
    let rr = p - t * b.xyz;
    let dist = length(rr);
    if (dist >= b.w || dist < 1e-9) { continue; }
    u += rr * ((b.w - dist) / dist);
  }
  st[i] = vec4f(u, 0.0);
  st[N + i] = vec4f((u - st[2u * N + i].xyz) / G.h, 0.0);
}

// 最大速度²（只看自由结点）：每个工作组求一个最大值，写到 st 的末段，CPU 上再取最大
// the largest speed² (free nodes only): one maximum per workgroup, written to the end of st and maximised on the CPU
var<workgroup> wmax: array<f32, ${WORKGROUP}>;
@compute @workgroup_size(${WORKGROUP})
fn speed(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  let i = gid.x;
  var s = 0.0;
  if (i < G.N && nodeS[i].x != 0.0) {
    let v = st[G.N + i].xyz;
    s = dot(v, v);
  }
  wmax[li] = s;
  workgroupBarrier();
  for (var k = ${WORKGROUP / 2}u; k > 0u; k = k >> 1u) {
    if (li < k) { wmax[li] = max(wmax[li], wmax[li + k]); }
    workgroupBarrier();
  }
  if (li == 0u) { st[G.oSP + wg.x] = vec4f(wmax[0], 0.0, 0.0, 0.0); }
}
`
