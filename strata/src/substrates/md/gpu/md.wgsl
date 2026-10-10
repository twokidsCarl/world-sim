// Molecular dynamics kernels. Mirrors src/substrates/md/ref: the same velocity Verlet
// split, the same table-interpolated pair force, the same reductions.
//
// Neighbour search uses a fixed-capacity cell table: each cell holds up to `cap` particle
// indices, claimed with an atomic counter. Entries past the capacity are dropped, and the
// largest count seen is reported so the host can detect overflow.

struct Params {
  box: vec4f,
  nc: vec4u,            // cells per axis; w = cell capacity
  n: u32,
  dim: u32,
  tableK: u32,
  chunk: u32,           // particles per reduction chunk
  dt: f32,
  rc2: f32,
  r2min: f32,
  tableScale: f32,
  vmax: f32,
  rdfMax: f32,
  lambda: f32,          // velocity scale applied by `rescale`
  rdfReach: f32,        // stencil radius in cells for the g(r) pass
}

const SPEED_BINS = 64u;
const RDF_BINS = 120u;
const RDF_OFFSET = 64u;
const MAX_CELL_SLOT = 192u;
// Neighbours for the hexatic order parameter: within 1.5 σ, squared.
const PSI_R2 = 2.25;

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> force: array<vec4f>;      // xyz force, w = potential energy share
@group(0) @binding(4) var<storage, read_write> aux: array<vec4f>;        // virial share, Re ψ6, Im ψ6, neighbours
@group(0) @binding(5) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> cellTable: array<u32>;
@group(0) @binding(7) var<storage, read> potTable: array<vec2f>;         // (f/r, u) on a uniform r² grid
@group(0) @binding(8) var<storage, read_write> partial: array<vec4f>;    // three per chunk
@group(0) @binding(9) var<storage, read_write> hist: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> heat: array<f32>;        // one per chunk

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
  return d - P.box.xyz * round(d / P.box.xyz);
}

@compute @workgroup_size(256)
fn kickDrift(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let v = vel[i].xyz + 0.5 * P.dt * force[i].xyz;
  var x = pos[i].xyz + P.dt * v;
  x = x - P.box.xyz * floor(x / P.box.xyz);
  vel[i] = vec4f(v, vel[i].w);
  pos[i] = vec4f(x, pos[i].w);
}

@compute @workgroup_size(256)
fn kick(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  vel[i] = vec4f(vel[i].xyz + 0.5 * P.dt * force[i].xyz, vel[i].w);
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
  let ci = vec3i(cellCoord(xi));
  let zr = i32(P.dim == 3u);
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
          let d = minImage(xi - pos[j].xyz);
          let r2 = dot(d, d);
          if (r2 >= P.rc2) { continue; }
          if (r2 < PSI_R2) {
            // exp(6 i θ) as the sixth power of the unit bond vector.
            let u = d.xy * inverseSqrt(r2);
            let u2 = vec2f(u.x * u.x - u.y * u.y, 2.0 * u.x * u.y);
            let u4 = vec2f(u2.x * u2.x - u2.y * u2.y, 2.0 * u2.x * u2.y);
            psi += vec2f(u4.x * u2.x - u4.y * u2.y, u4.x * u2.y + u4.y * u2.x);
            nb += 1.0;
          }
          let t = max((r2 - P.r2min) * P.tableScale, 0.0);
          let k0 = min(u32(t), P.tableK - 1u);
          let e = mix(potTable[k0], potTable[k0 + 1u], min(t - f32(k0), 1.0));
          f += e.x * d;
          pe += 0.5 * e.y;
          vir += 0.5 * e.x * r2;
        }
      }
    }
  }
  force[i] = vec4f(f, pe);
  aux[i] = vec4f(vir, psi / max(nb, 6.0), nb);
}

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
  for (var i = start; i < end; i++) {
    let v = vel[i].xyz;
    ke += 0.5 * dot(v, v);
    pe += force[i].w;
    vir += aux[i].x;
    p += v;
    psi += vec3f(aux[i].yz, length(aux[i].yz));
  }
  partial[3u * id.x] = vec4f(ke, pe, vir, 0.0);
  partial[3u * id.x + 1u] = vec4f(p, 0.0);
  partial[3u * id.x + 2u] = vec4f(psi, 0.0);
}

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
  if (i >= P.n) { return; }
  let b = u32(length(vel[i].xyz) / P.vmax * f32(SPEED_BINS));
  if (b < SPEED_BINS) { atomicAdd(&hist[b], 1u); }
}

// Pair-distance histogram; each unordered pair is counted once (j > i).
@compute @workgroup_size(256)
fn rdfHist(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let xi = pos[i].xyz;
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
          if (j <= i) { continue; }
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
