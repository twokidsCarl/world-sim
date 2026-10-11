// 粒子网格法引力的内核，逐段对应 src/substrates/mesh/ref.ts：CIC 分配、Stockham FFT、
// 泊松方程的格林函数、中心差分、CIC 插值、蛙跳。分配用定点整数的原子加法，所以与 CPU
// 参考实现只在舍入上有差别。
// Kernels for particle-mesh gravity, mirroring src/substrates/mesh/ref.ts section by
// section: CIC deposit, Stockham FFT, the Green's function of Poisson's equation, central
// differences, CIC interpolation, leapfrog. The deposit uses atomic adds of fixed-point
// integers, so it differs from the CPU reference only by rounding.

struct Params {
  n: u32,
  M: u32,
  chunk: u32,       // 每个归约块的粒子数或格点数 / particles or cells per reduction chunk
  particleChunks: u32,
  dt: f32,
  G: f32,
  pad0: f32,
  pad1: f32,
}

struct Stage {
  axis: u32,
  stride: u32,
  sign: f32,
  pad: u32,
}

const WEIGHT = 4096.0;   // CIC 权重的定点比例 / fixed-point scale of the CIC weights
const PI = 3.14159265358979;

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> acc: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> mass: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read> src: array<vec2f>;
@group(0) @binding(6) var<storage, read_write> dst: array<vec2f>;
@group(0) @binding(7) var<storage, read_write> field: array<vec4f>;   // 加速度 xyz，势 w / acceleration xyz, potential w
@group(0) @binding(8) var<storage, read_write> partial: array<vec4f>;
@group(0) @binding(9) var<uniform> S: Stage;

fn cellIndex(c: vec3i) -> u32 {
  let M = i32(P.M);
  let w = (c + vec3i(M)) % vec3i(M);
  return u32(w.x + M * (w.y + M * w.z));
}

fn coords(i: u32) -> vec3u {
  return vec3u(i % P.M, (i / P.M) % P.M, i / (P.M * P.M));
}

fn cicWeight(c: u32, f: vec3f) -> f32 {
  let d = vec3f(f32(c & 1u), f32((c >> 1u) & 1u), f32(c >> 2u));
  let w = mix(vec3f(1.0) - f, f, d);
  return w.x * w.y * w.z;
}

@compute @workgroup_size(256)
fn kickDrift(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let v = vel[i].xyz + 0.5 * P.dt * acc[i].xyz;
  let x = pos[i].xyz + P.dt * v;
  vel[i] = vec4f(v, 0.0);
  pos[i] = vec4f(x - floor(x), 0.0);
}

@compute @workgroup_size(256)
fn clearMass(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < P.M * P.M * P.M) { atomicStore(&mass[id.x], 0); }
}

@compute @workgroup_size(256)
fn deposit(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let g = pos[i].xyz * f32(P.M);
  let base = vec3i(floor(g));
  let f = g - floor(g);
  for (var c = 0u; c < 8u; c++) {
    let cell = cellIndex(base + vec3i(i32(c & 1u), i32((c >> 1u) & 1u), i32(c >> 2u)));
    atomicAdd(&mass[cell], i32(round(cicWeight(c, f) * WEIGHT)));
  }
}

fn contrast(c: u32) -> f32 {
  let mean = f32(P.n) / f32(P.M * P.M * P.M);
  return f32(atomicLoad(&mass[c])) / (WEIGHT * mean) - 1.0;
}

@compute @workgroup_size(256)
fn toComplex(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.M * P.M * P.M) { return; }
  dst[id.x] = vec2f(contrast(id.x), 0.0);
}

// 一个蝶形阶段，写法与 ref.ts 的 fftStage 相同。 / One butterfly stage, written as fftStage in ref.ts.
@compute @workgroup_size(256)
fn fftStage(@builtin(global_invocation_id) id: vec3u) {
  let M = P.M;
  let i = id.x;
  if (i >= M * M * M) { return; }
  var step = 1u;
  if (S.axis == 1u) { step = M; }
  if (S.axis == 2u) { step = M * M; }
  let length = M / S.stride;
  let half = length / 2u;
  let j = (i / step) % M;
  let base = i - j * step;
  let q = j % S.stride;
  let t = (j - q) / S.stride;
  let p = t >> 1u;
  let a = src[base + (q + S.stride * p) * step];
  let b = src[base + (q + S.stride * (p + half)) * step];
  if ((t & 1u) == 0u) {
    dst[i] = a + b;
  } else {
    let angle = S.sign * 2.0 * PI * f32(p) / f32(length);
    let w = vec2f(cos(angle), sin(angle));
    let d = a - b;
    dst[i] = vec2f(d.x * w.x - d.y * w.y, d.x * w.y + d.y * w.x);
  }
}

fn fold(k: u32) -> f32 {
  if (k < P.M / 2u) { return f32(k); }
  return f32(k) - f32(P.M);
}

// φ_k = −4πG δ_k / k²，并除以 M³ 完成逆变换的归一化。 / φ_k = −4πG δ_k / k², divided by M³ to normalise the inverse transform.
@compute @workgroup_size(256)
fn greens(@builtin(global_invocation_id) id: vec3u) {
  let cells = P.M * P.M * P.M;
  if (id.x >= cells) { return; }
  let c = coords(id.x);
  let k = vec3f(fold(c.x), fold(c.y), fold(c.z));
  let k2 = dot(k, k);
  var g = 0.0;
  if (k2 > 0.0) { g = -P.G / (PI * k2 * f32(cells)); }
  dst[id.x] = src[id.x] * g;
}

@compute @workgroup_size(256)
fn gradient(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.M * P.M * P.M) { return; }
  let c = vec3i(coords(id.x));
  let scale = 0.5 * f32(P.M);
  let a = -scale * vec3f(
    src[cellIndex(c + vec3i(1, 0, 0))].x - src[cellIndex(c - vec3i(1, 0, 0))].x,
    src[cellIndex(c + vec3i(0, 1, 0))].x - src[cellIndex(c - vec3i(0, 1, 0))].x,
    src[cellIndex(c + vec3i(0, 0, 1))].x - src[cellIndex(c - vec3i(0, 0, 1))].x);
  field[id.x] = vec4f(a, src[id.x].x);
}

@compute @workgroup_size(256)
fn interpKick(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let g = pos[i].xyz * f32(P.M);
  let base = vec3i(floor(g));
  let f = g - floor(g);
  var a = vec3f(0.0);
  for (var c = 0u; c < 8u; c++) {
    let cell = cellIndex(base + vec3i(i32(c & 1u), i32((c >> 1u) & 1u), i32(c >> 2u)));
    a += cicWeight(c, f) * field[cell].xyz;
  }
  acc[i] = vec4f(a, 0.0);
  vel[i] = vec4f(vel[i].xyz + 0.5 * P.dt * a, 0.0);
}

// 每块粒子一次调用：动能、动量、基频密度模的实部与虚部。
// One invocation per chunk of particles: kinetic energy, momentum, and the real and imaginary parts of the fundamental density mode.
@compute @workgroup_size(64)
fn reduceParticles(@builtin(global_invocation_id) id: vec3u) {
  let start = id.x * P.chunk;
  if (start >= P.n) { return; }
  let end = min(start + P.chunk, P.n);
  var ke = 0.0;
  var p = vec3f(0.0);
  var mode = vec2f(0.0);
  for (var i = start; i < end; i++) {
    let v = vel[i].xyz;
    ke += 0.5 * dot(v, v);
    p += v;
    let angle = 2.0 * PI * pos[i].x;
    mode += vec2f(cos(angle), -sin(angle));
  }
  partial[2u * id.x] = vec4f(ke, p);
  partial[2u * id.x + 1u] = vec4f(mode, 0.0, 0.0);
}

// 每块格点一次调用：Σ δφ、Σ δ²、最大的 δ。 / One invocation per chunk of cells: Σ δφ, Σ δ², the largest δ.
@compute @workgroup_size(64)
fn reduceCells(@builtin(global_invocation_id) id: vec3u) {
  let cells = P.M * P.M * P.M;
  let start = id.x * P.chunk;
  if (start >= cells) { return; }
  let end = min(start + P.chunk, cells);
  var work = 0.0;
  var square = 0.0;
  var peak = -1.0;
  for (var c = start; c < end; c++) {
    let d = contrast(c);
    work += d * field[c].w;
    square += d * d;
    peak = max(peak, d);
  }
  partial[2u * P.particleChunks + id.x] = vec4f(work, square, peak, 0.0);
}
