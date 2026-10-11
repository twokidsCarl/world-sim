// 直接求和的软化牛顿引力，配合 kick-drift-kick 蛙跳积分。
// 与 src/substrates/gravity/ref.ts 保持一致。
// Softened Newtonian gravity by direct summation, with a kick-drift-kick leapfrog.
// Mirrors src/substrates/gravity/ref.ts.

struct Params {
  n: u32,
  chunk: u32,
  bins: u32,
  pad: u32,
  dt: f32,
  eps2: f32,
  rmax: f32,
  pad2: f32,
  centre: vec4f,   // 径向壳层的量度中心 / where radial shells are measured from
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;     // xyz，w = 质量 / xyz, w = mass
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> acc: array<vec4f>;     // xyz，w = 单位质量的势能 / xyz, w = potential per unit mass
@group(0) @binding(4) var<storage, read_write> partial: array<vec4f>; // 每块五个 / five per chunk
@group(0) @binding(5) var<storage, read_write> hist: array<atomic<u32>>;

@compute @workgroup_size(64)
fn accel(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let xi = pos[i].xyz;
  var a = vec3f(0.0);
  var phi = 0.0;
  for (var j = 0u; j < P.n; j++) {
    if (j == i) { continue; }
    let pj = pos[j];
    let d = pj.xyz - xi;
    let inv = inverseSqrt(dot(d, d) + P.eps2);
    a += pj.w * d * inv * inv * inv;
    phi -= pj.w * inv;
  }
  acc[i] = vec4f(a, phi);
}

@compute @workgroup_size(256)
fn kickDrift(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let v = vel[i].xyz + 0.5 * P.dt * acc[i].xyz;
  vel[i] = vec4f(v, 0.0);
  pos[i] = vec4f(pos[i].xyz + P.dt * v, pos[i].w);
}

@compute @workgroup_size(256)
fn kick(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  vel[i] = vec4f(vel[i].xyz + 0.5 * P.dt * acc[i].xyz, 0.0);
}

// 每块调用一次。除能量和动量外，还计算对束缚天体（v²/2 + φ < 0）
// 的各项求和（由此得出束缚残余体的位力），
// 以及势阱最深处的那个天体（它标记残余体的中心）。
// One invocation per chunk. Besides energies and momentum, the sums over bound bodies
// (v²/2 + φ < 0) from which the virial of the bound remnant is formed, and the body deepest
// in the potential, which marks the remnant's centre.
@compute @workgroup_size(64)
fn reduceChunks(@builtin(global_invocation_id) id: vec3u) {
  let start = id.x * P.chunk;
  if (start >= P.n) { return; }
  let end = min(start + P.chunk, P.n);
  var ke = 0.0;
  var pe = 0.0;
  var p = vec3f(0.0);
  var keBound = 0.0;
  var mxa = 0.0;
  var count = 0.0;
  var mass = 0.0;
  var mv = vec3f(0.0);
  var ma = vec3f(0.0);
  var deepest = vec4f(0.0, 0.0, 0.0, 1e30);
  for (var i = start; i < end; i++) {
    let m = pos[i].w;
    let x = pos[i].xyz;
    let v = vel[i].xyz;
    let a = acc[i];
    let k = 0.5 * dot(v, v);
    ke += m * k;
    pe += 0.5 * m * a.w;
    p += m * v;
    if (a.w < deepest.w) { deepest = vec4f(x, a.w); }
    if (k + a.w < 0.0) {
      keBound += m * k;
      mxa += m * dot(x, a.xyz);
      count += 1.0;
      mass += m;
      mv += m * v;
      ma += m * a.xyz;
    }
  }
  partial[5u * id.x] = vec4f(ke, pe, keBound, mxa);
  partial[5u * id.x + 1u] = vec4f(p, count);
  partial[5u * id.x + 2u] = vec4f(mv, mass);
  partial[5u * id.x + 3u] = vec4f(ma, 0.0);
  partial[5u * id.x + 4u] = deepest;
}

@compute @workgroup_size(256)
fn clearHist(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < P.bins) { atomicStore(&hist[id.x], 0u); }
}

// 以 P.centre 为中心的各径向壳层内的天体数。 / Bodies per radial shell about P.centre.
@compute @workgroup_size(256)
fn radialHist(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.n) { return; }
  let b = u32(length(pos[i].xyz - P.centre.xyz) / P.rmax * f32(P.bins));
  if (b < P.bins) { atomicAdd(&hist[b], 1u); }
}
