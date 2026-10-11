// 分子动力学内核。与 src/substrates/md/ref 保持一致：相同的速度 Verlet 拆分、
// 相同的查表插值对力、相同的归约。
//
// 近邻搜索使用固定容量的元胞表：每个元胞最多存放 `cap` 个粒子索引，用原子计数器
// 占位。超出容量的条目被丢弃，并上报所见的最大计数，以便宿主检测溢出。
//
// Molecular dynamics kernels. Mirrors src/substrates/md/ref: the same velocity Verlet
// split, the same table-interpolated pair force, the same reductions.
//
// Neighbour search uses a fixed-capacity cell table: each cell holds up to `cap` particle
// indices, claimed with an atomic counter. Entries past the capacity are dropped, and the
// largest count seen is reported so the host can detect overflow.

struct Params {
  box: vec4f,
  nc: vec4u,            // 每个轴上的元胞数；w = 元胞容量 / cells per axis; w = cell capacity
  n: u32,
  dim: u32,
  tableK: u32,
  chunk: u32,           // 每个归约块的粒子数 / particles per reduction chunk
  dt: f32,
  rc2: f32,
  r2min: f32,
  tableScale: f32,
  vmax: f32,
  rdfMax: f32,
  lambda: f32,          // `rescale` 施加的速度缩放因子 / velocity scale applied by `rescale`
  rdfReach: f32,        // g(r) 通道的模板半径，以元胞为单位 / stencil radius in cells for the g(r) pass
  drive: f32,           // 每个粒子沿 x 方向的体力 / body force per particle along x
  wallT: f32,           // 壁面温度 / wall temperature
  // 1：在 y = 0 和 y = box.y 处设热壁，取代周期性的 y 轴
  // 1: thermal walls at y = 0 and y = box.y instead of a periodic y axis
  walls: u32,
  seed: u32,            // 每提交一批就改变一次 / changes every submitted batch
  strideX: u32,         // 密度模沿 x 每隔 strideX 个波矢采样一个 / density modes sample every strideX-th wave vector along x
  strideY: u32,
  // 1：只统计选区内的粒子 / 1: reductions count only particles inside the region
  regionOn: u32,
  pad1: u32,
  // 选区矩形 (x0, y0, x1, y1) / region rectangle (x0, y0, x1, y1)
  region: vec4f,
}

const SPEED_BINS = 64u;
const RDF_BINS = 120u;
const RDF_OFFSET = 64u;
const MAX_CELL_SLOT = 192u;
// 六角序参量所用的近邻：1.5 σ 以内，此处取平方。
// Neighbours for the hexatic order parameter: within 1.5 σ, squared.
const PSI_R2 = 2.25;
const SPECIES = 2u;
// 配位数所用的最近邻：1.35 σ 以内，此处取平方。
// Nearest neighbours for the coordination number: within 1.35 σ, squared.
const COORD_R2 = 1.8225;
const FIELD_G = 48u;
// 场求和所用的定点缩放系数，这些和用 i32 原子变量累加。
// Fixed-point scales for the field sums, which are accumulated in i32 atomics.
const FIELD_V = 1024.0;
const FIELD_V2 = 256.0;
// 密度模在每个轴上的波矢数；每个块写入 MODE_SLOTS 个浮点数。
// Wave vectors per axis for the density modes; each chunk writes MODE_SLOTS floats.
const MODE_COUNT = 48u;
const MODE_SLOTS = 194u;

@group(0) @binding(0) var<uniform> P: Params;
// xyz 为位置，w = 组分（0 或 1） / xyz position, w = species (0 or 1)
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
// xyz 为力，w = 势能份额 / xyz force, w = potential energy share
@group(0) @binding(3) var<storage, read_write> force: array<vec4f>;
// 位力份额、Re ψ6、Im ψ6、打包的近邻计数（见 `forces`）
// virial share, Re ψ6, Im ψ6, packed neighbour counts (see `forces`)
@group(0) @binding(4) var<storage, read_write> aux: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> cellTable: array<u32>;
// 均匀 r² 网格上的 (f/r, u)；每个组分对一张表 / (f/r, u) on a uniform r² grid; one table per species pair
@group(0) @binding(7) var<storage, read> potTable: array<vec2f>;
@group(0) @binding(8) var<storage, read_write> partial: array<vec4f>;    // 每块四个 / four per chunk
@group(0) @binding(9) var<storage, read_write> hist: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> heat: array<f32>;        // 每块一个 / one per chunk
@group(0) @binding(12) var<storage, read_write> modeChunks: array<f32>;   // 每块 MODE_SLOTS 个 / MODE_SLOTS per chunk
@group(0) @binding(13) var<storage, read_write> modes: array<f32>;        // MODE_SLOTS
// 每个单元：计数、Σvx、Σvy、Σv²、组分 B 的计数 / per cell: count, Σvx, Σvy, Σv², count of species B
@group(0) @binding(11) var<storage, read_write> field: array<atomic<i32>>;

// 粒子是否计入当前的统计：没有选区时全部计入。
// Whether a particle counts towards the current reduction: all of them when no region is set.
fn counted(p: vec3f) -> bool {
  return P.regionOn == 0u || (all(p.xy >= P.region.xy) && all(p.xy < P.region.zw));
}

fn cellCoord(p: vec3f) -> vec3u {
  return min(vec3u(p / P.box.xyz * vec3f(P.nc.xyz)), P.nc.xyz - vec3u(1u));
}

fn cellIndex(c: vec3u) -> u32 {
  return c.x + P.nc.x * (c.y + P.nc.y * c.z);
}

fn wrapCell(c: vec3i) -> vec3u {
  let nc = vec3i(P.nc.xyz);
  return vec3u((c + nc) % nc);
}

fn minImage(d: vec3f) -> vec3f {
  var shift = P.box.xyz * round(d / P.box.xyz);
  if (P.walls != 0u) { shift.y = 0.0; }
  return d - shift;
}

// 必须与 src/core/rng.ts 中的 hash32 一致。 / Must match hash32 in src/core/rng.ts.
fn hash32(seed: u32, c: u32) -> u32 {
  var h = seed ^ (c * 0x9e3779b1u);
  h = (h ^ (h >> 16u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  h = h ^ (h >> 16u);
  h = (h + seed) * 0x27d4eb2fu;
  h = h ^ (h >> 15u);
  return h;
}

// (0, 1) 上的均匀分布。 / Uniform in (0, 1).
fn rand(key: u32, c: u32) -> f32 {
  return (f32(hash32(key, c) >> 8u) + 0.5) / 16777216.0;
}

@compute @workgroup_size(256)
fn kickDrift(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  var v = vel[i].xyz + 0.5 * P.dt * (force[i].xyz + vec3f(P.drive, 0.0, 0.0));
  var x = pos[i].xyz + P.dt * v;
  let wrapped = x - P.box.xyz * floor(x / P.box.xyz);
  if (P.walls != 0u && (x.y < 0.0 || x.y >= P.box.y)) {
    // 热壁上的漫反射。若干子步共用同一个种子，所以混入位置的比特位，使各次抽样保持相互独立。
    // Diffuse reflection from a thermal wall. Several substeps share one seed, so the
    // position bits are mixed in to keep their draws independent.
    let lower = x.y < 0.0;
    let key = hash32(hash32(P.seed, i), bitcast<u32>(x.x));
    let sd = sqrt(P.wallT);
    let normal = sd * sqrt(-2.0 * log(rand(key, 0u)));
    let tangent = sd * sqrt(-2.0 * log(rand(key, 1u))) * cos(6.2831853 * rand(key, 2u));
    v = vec3f(tangent, select(-normal, normal, lower), 0.0);
    x.y = clamp(select(2.0 * P.box.y - x.y, -x.y, lower), 0.0, P.box.y * 0.999999);
  } else {
    x.y = wrapped.y;
  }
  x.x = wrapped.x;
  x.z = wrapped.z;
  vel[i] = vec4f(v, vel[i].w);
  pos[i] = vec4f(x, pos[i].w);
}

@compute @workgroup_size(256)
fn kick(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  vel[i] = vec4f(vel[i].xyz + 0.5 * P.dt * (force[i].xyz + vec3f(P.drive, 0.0, 0.0)), vel[i].w);
}

@compute @workgroup_size(256)
fn clearCells(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < P.nc.x * P.nc.y * P.nc.z) { atomicStore(&cellCount[id.x], 0u); }
}

@compute @workgroup_size(256)
fn fillCells(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let c = cellIndex(cellCoord(pos[i].xyz));
  let k = atomicAdd(&cellCount[c], 1u);
  if (k < P.nc.w) { cellTable[c * P.nc.w + k] = i; }
  atomicMax(&hist[MAX_CELL_SLOT], k + 1u);
}

@compute @workgroup_size(256)
fn forces(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let xi = pos[i].xyz;
  let si = u32(pos[i].w);
  let ci = vec3i(cellCoord(xi));
  let zr = i32(P.dim == 3u);
  var unlike = 0.0;
  var coord = 0.0;
  var f = vec3f(0.0);
  var pe = 0.0;
  var vir = 0.0;
  var psi = vec2f(0.0);
  var nb = 0.0;
  for (var oz = -zr; oz <= zr; oz++) {
    for (var oy = -1; oy <= 1; oy++) {
      for (var ox = -1; ox <= 1; ox++) {
        let c = cellIndex(wrapCell(ci + vec3i(ox, oy, oz)));
        let count = min(atomicLoad(&cellCount[c]), P.nc.w);
        for (var k = 0u; k < count; k++) {
          let j = cellTable[c * P.nc.w + k];
          if (j == i) { continue; }
          let pj = pos[j];
          let sj = u32(pj.w);
          let d = minImage(xi - pj.xyz);
          let r2 = dot(d, d);
          if (r2 >= P.rc2) { continue; }
          coord += f32(r2 < COORD_R2);
          if (r2 < PSI_R2) {
            unlike += f32(si != sj);
            nb += 1.0;
          }
          // 六角序参量只在平面内定义。 / The hexatic order parameter is defined in the plane only.
          if (r2 < PSI_R2 && P.dim == 2u) {
            // exp(6 i θ) 取为单位键矢量的六次幂。 / exp(6 i θ) as the sixth power of the unit bond vector.
            let u = d.xy * inverseSqrt(r2);
            let u2 = vec2f(u.x * u.x - u.y * u.y, 2.0 * u.x * u.y);
            let u4 = vec2f(u2.x * u2.x - u2.y * u2.y, 2.0 * u2.x * u2.y);
            psi += vec2f(u4.x * u2.x - u4.y * u2.y, u4.x * u2.y + u4.y * u2.x);
          }
          let t = max((r2 - P.r2min) * P.tableScale, 0.0);
          // 组分 sj 作用于组分 si 的力所用的表。 / Table for the force on species si from species sj.
          let k0 = (si * SPECIES + sj) * (P.tableK + 1u) + min(u32(t), P.tableK - 1u);
          let e = mix(potTable[k0], potTable[k0 + 1u], min(t - floor(min(t, f32(P.tableK - 1u))), 1.0));
          f += e.x * d;
          pe += 0.5 * e.y;
          vir += 0.5 * e.x * r2;
        }
      }
    }
  }
  force[i] = vec4f(f, pe);
  // 三个小整数计数精确地共用一个浮点数：
  // ψ6 半径内的近邻数、其中属于另一组分的数目，
  // 以及配位半径内的最近邻数。
  // Three small integer counts share one float exactly: neighbours within the ψ6 radius,
  // those of the other species, and nearest neighbours within the coordination radius.
  aux[i] = vec4f(vir, psi / max(nb, 6.0), nb + 64.0 * unlike + 4096.0 * coord);
}

// 每块调用一次，因此各块的和在写入时没有竞争。
// One invocation per chunk, so each chunk's sums are written without contention.
@compute @workgroup_size(64)
fn reduceChunks(@builtin(global_invocation_id) id: vec3u) {
  let start = id.x * P.chunk;
  if (start >= P.n) { return; }
  let end = min(start + P.chunk, P.n);
  var ke = 0.0;
  var pe = 0.0;
  var vir = 0.0;
  var p = vec3f(0.0);
  var psi = vec3f(0.0);
  var bonds = 0.0;
  var unlike = 0.0;
  var coord = 0.0;
  var count = 0.0;
  for (var i = start; i < end; i++) {
    if (!counted(pos[i].xyz)) { continue; }
    count += 1.0;
    let v = vel[i].xyz;
    ke += 0.5 * dot(v, v);
    pe += force[i].w;
    vir += aux[i].x;
    p += v;
    psi += vec3f(aux[i].yz, length(aux[i].yz));
    let c = floor(aux[i].w / 4096.0);
    let rest = aux[i].w - 4096.0 * c;
    let u = floor(rest / 64.0);
    coord += c;
    unlike += u;
    bonds += rest - 64.0 * u;
  }
  partial[4u * id.x] = vec4f(ke, pe, vir, bonds);
  partial[4u * id.x + 1u] = vec4f(p, coord);
  partial[4u * id.x + 2u] = vec4f(psi, unlike);
  partial[4u * id.x + 3u] = vec4f(count, 0.0, 0.0, 0.0);
}

// 把速度乘以 lambda，并按块记录由此增加的动能。
// Scale velocities by lambda and record the kinetic energy this adds, per chunk.
@compute @workgroup_size(64)
fn rescale(@builtin(global_invocation_id) id: vec3u) {
  let start = id.x * P.chunk;
  if (start >= P.n) { return; }
  let end = min(start + P.chunk, P.n);
  var ke = 0.0;
  for (var i = start; i < end; i++) {
    let v = vel[i].xyz;
    ke += 0.5 * dot(v, v);
    vel[i] = vec4f(v * P.lambda, vel[i].w);
  }
  heat[id.x] += (P.lambda * P.lambda - 1.0) * ke;
}

@compute @workgroup_size(64)
fn clearHeat(@builtin(global_invocation_id) id: vec3u) {
  if (id.x * P.chunk < P.n) { heat[id.x] = 0.0; }
}

@compute @workgroup_size(256)
fn clearHist(@builtin(global_invocation_id) id: vec3u) {
  if (id.x <= MAX_CELL_SLOT) { atomicStore(&hist[id.x], 0u); }
}

@compute @workgroup_size(256)
fn speedHist(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n || !counted(pos[i].xyz)) { return; }
  let b = u32(length(vel[i].xyz) / P.vmax * f32(SPEED_BINS));
  if (b < SPEED_BINS) { atomicAdd(&hist[b], 1u); }
}

// 粒子对间距直方图；每个无序粒子对只计一次（j > i）。
// Pair-distance histogram; each unordered pair is counted once (j > i).
@compute @workgroup_size(256)
fn rdfHist(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let xi = pos[i].xyz;
  if (!counted(xi)) { return; }
  let ci = vec3i(cellCoord(xi));
  let reach = i32(P.rdfReach);
  let zr = reach * i32(P.dim == 3u);
  let r2max = P.rdfMax * P.rdfMax;
  for (var oz = -zr; oz <= zr; oz++) {
    for (var oy = -reach; oy <= reach; oy++) {
      for (var ox = -reach; ox <= reach; ox++) {
        let c = cellIndex(wrapCell(ci + vec3i(ox, oy, oz)));
        let count = min(atomicLoad(&cellCount[c]), P.nc.w);
        for (var k = 0u; k < count; k++) {
          let j = cellTable[c * P.nc.w + k];
          // 有选区时以区内粒子为中心统计所有邻居（有序对）；否则每个无序对只计一次。
          // With a region, count every neighbour of each particle inside it (ordered pairs);
          // otherwise count each unordered pair once.
          if (j == i || (P.regionOn == 0u && j < i)) { continue; }
          let d = minImage(xi - pos[j].xyz);
          let r2 = dot(d, d);
          if (r2 >= r2max) { continue; }
          let b = u32(sqrt(r2) / P.rdfMax * f32(RDF_BINS));
          if (b < RDF_BINS) { atomicAdd(&hist[RDF_OFFSET + b], 1u); }
        }
      }
    }
  }
}

@compute @workgroup_size(256)
fn clearField(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < FIELD_G * FIELD_G * 5u) { atomicStore(&field[id.x], 0); }
}

// 用礼帽核粗粒化到 FIELD_G × FIELD_G 网格上。 / Top-hat coarse-graining onto a FIELD_G × FIELD_G grid.
@compute @workgroup_size(256)
fn fieldBin(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let c = min(vec2u(pos[i].xy / P.box.xy * f32(FIELD_G)), vec2u(FIELD_G - 1u));
  let base = 5u * (c.y * FIELD_G + c.x);
  let v = vel[i].xy;
  atomicAdd(&field[base], 1);
  atomicAdd(&field[base + 1u], i32(round(v.x * FIELD_V)));
  atomicAdd(&field[base + 2u], i32(round(v.y * FIELD_V)));
  atomicAdd(&field[base + 3u], i32(round(dot(v, v) * FIELD_V2)));
  atomicAdd(&field[base + 4u], i32(pos[i].w > 0.5));
}

// 密度的傅里叶模 ρ_k = Σ exp(-i k·r)，按块计算。布局为 (Re, Im) 对：沿 x 的最长波；
// 沿 x、取 strideX 各整数倍的 MODE_COUNT 个模；沿 y 的同样一组。相继的倍数由反复做复数乘法得到。
// Fourier modes of the density, ρ_k = Σ exp(-i k·r), per chunk. Layout as (Re, Im) pairs:
// the longest wave along x; MODE_COUNT modes along x at multiples of strideX; the same
// along y. Successive multiples come from repeated complex multiplication.
@compute @workgroup_size(64)
fn densityModes(@builtin(global_invocation_id) id: vec3u) {
  let start = id.x * P.chunk;
  if (start >= P.n) { return; }
  let end = min(start + P.chunk, P.n);
  var acc: array<f32, 194>;
  for (var i = start; i < end; i++) {
    let t = 6.283185307 * pos[i].xy / P.box.xy;
    acc[0] += cos(t.x);
    acc[1] -= sin(t.x);
    let stepX = vec2f(cos(f32(P.strideX) * t.x), sin(f32(P.strideX) * t.x));
    let stepY = vec2f(cos(f32(P.strideY) * t.y), sin(f32(P.strideY) * t.y));
    var cx = stepX;
    var cy = stepY;
    for (var j = 1u; j <= MODE_COUNT; j++) {
      acc[2u * j] += cx.x;
      acc[2u * j + 1u] -= cx.y;
      acc[2u * (MODE_COUNT + j)] += cy.x;
      acc[2u * (MODE_COUNT + j) + 1u] -= cy.y;
      cx = vec2f(cx.x * stepX.x - cx.y * stepX.y, cx.x * stepX.y + cx.y * stepX.x);
      cy = vec2f(cy.x * stepY.x - cy.y * stepY.y, cy.x * stepY.y + cy.y * stepY.x);
    }
  }
  for (var k = 0u; k < MODE_SLOTS; k++) { modeChunks[id.x * MODE_SLOTS + k] = acc[k]; }
}

// 对各块求和：每个模分量调用一次。 / Sum the chunks: one invocation per mode component.
@compute @workgroup_size(64)
fn mergeModes(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= MODE_SLOTS) { return; }
  var sum = 0.0;
  for (var c = 0u; c * P.chunk < P.n; c++) { sum += modeChunks[c * MODE_SLOTS + id.x]; }
  modes[id.x] = sum;
}

// 激发一个驻声波：沿 x 方向的速度按盒内最长的正弦波变化，振幅为 P.lambda。
// Launch a standing sound wave: a velocity along x varying as the longest sine wave in
// the box, with amplitude P.lambda.
@compute @workgroup_size(256)
fn soundKick(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let v = vel[i];
  vel[i] = vec4f(v.x + P.lambda * sin(6.283185307 * pos[i].x / P.box.x), v.yzw);
}
