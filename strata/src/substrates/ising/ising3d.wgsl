// 三维 Ising 内核，逐位对应 src/substrates/ising/ref3d.ts：同一个哈希、同一张阈值表、
// 同样的子格顺序、块自旋里同样的平局处理。
// 3D Ising kernels, a bit-for-bit mirror of src/substrates/ising/ref3d.ts: the same hash,
// the same threshold table, the same sublattice order, the same tie-breaking in block spins.

struct Level {
  L: u32,        // 这一层晶格的边长 / side of this level's lattice
  seed: u32,
  level: u32,    // 原始晶格为 0 / 0 for the original lattice
  pad: u32,
}

const ALWAYS = 0xffffffffu;
const TIE_KEY = 0x40000000u;

@group(0) @binding(0) var<uniform> U: Level;
@group(0) @binding(1) var<storage, read_write> spins: array<u32>;      // 下标 x + L (y + L z) / indexed x + L (y + L z)
@group(0) @binding(2) var<storage, read> thr: array<u32>;
@group(0) @binding(3) var<storage, read_write> counter: array<u32>;    // [0] = 已做的子格遍数 / sublattice passes done
@group(0) @binding(4) var<storage, read_write> coarse: array<u32>;
@group(0) @binding(5) var<storage, read_write> partial: array<vec4i>;  // 每个 z 层一个 / one per z layer

// 须与 src/core/rng.ts 的 hash32 一致。 / Must match hash32 in src/core/rng.ts.
fn hash32(seed: u32, c: u32) -> u32 {
  var h = seed ^ (c * 0x9e3779b1u);
  h = (h ^ (h >> 16u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  h = h ^ (h >> 16u);
  h = (h + seed) * 0x27d4eb2fu;
  h = h ^ (h >> 15u);
  return h;
}

fn pm(b: u32) -> i32 {
  return 2 * i32(b) - 1;
}

fn at(x: u32, y: u32, z: u32, L: u32) -> i32 {
  return pm(spins[x + L * (y + L * z)]);
}

@compute @workgroup_size(8, 8, 4)
fn metropolis(@builtin(global_invocation_id) id: vec3u) {
  let L = U.L;
  if (id.x >= L || id.y >= L || id.z >= L) { return; }
  let done = counter[0];
  if (((id.x + id.y + id.z) & 1u) != (done & 1u)) { return; }
  let xm = (id.x + L - 1u) % L;
  let xp = (id.x + 1u) % L;
  let ym = (id.y + L - 1u) % L;
  let yp = (id.y + 1u) % L;
  let zm = (id.z + L - 1u) % L;
  let zp = (id.z + 1u) % L;
  let nn = at(xm, id.y, id.z, L) + at(xp, id.y, id.z, L) + at(id.x, ym, id.z, L)
         + at(id.x, yp, id.z, L) + at(id.x, id.y, zm, L) + at(id.x, id.y, zp, L);
  let site = id.x + L * (id.y + L * id.z);
  let s = spins[site];
  let t = thr[s * 7u + u32((nn + 6) / 2)];
  if (t == ALWAYS || hash32(hash32(U.seed, done), site) < t) { spins[site] = s ^ 1u; }
}

@compute @workgroup_size(1)
fn bump() {
  counter[0] = counter[0] + 1u;
}

// 2×2×2 多数表决：`spins` 是更细的晶格（边长 2 L），`coarse` 是这一层（边长 L）。
// Majority rule over 2×2×2: `spins` is the finer lattice (side 2 L), `coarse` this level's (side L).
@compute @workgroup_size(8, 8, 4)
fn block(@builtin(global_invocation_id) id: vec3u) {
  let M = U.L;
  if (id.x >= M || id.y >= M || id.z >= M) { return; }
  let F = 2u * M;
  var sum = 0u;
  for (var c = 0u; c < 8u; c++) {
    sum += spins[2u * id.x + (c & 1u) + F * (2u * id.y + ((c >> 1u) & 1u) + F * (2u * id.z + (c >> 2u)))];
  }
  let site = id.x + M * (id.y + M * id.z);
  var v = u32(sum > 4u);
  if (sum == 4u) { v = hash32(hash32(U.seed, TIE_KEY + U.level), site) & 1u; }
  coarse[site] = v;
}

// 每个 z 层一次调用：Σ s 与 Σ 最近邻键（每个格点向 +x、+y、+z 各一条）。
// One invocation per z layer: Σ s and Σ nearest-neighbour bonds (one each towards +x, +y, +z per site).
@compute @workgroup_size(16)
fn reduceLayers(@builtin(global_invocation_id) id: vec3u) {
  let L = U.L;
  let z = id.x;
  if (z >= L) { return; }
  var s = 0;
  var nn = 0;
  for (var y = 0u; y < L; y++) {
    for (var x = 0u; x < L; x++) {
      let v = at(x, y, z, L);
      s += v;
      nn += v * (at((x + 1u) % L, y, z, L) + at(x, (y + 1u) % L, z, L) + at(x, y, (z + 1u) % L, L));
    }
  }
  partial[z] = vec4i(s, nn, 0, 0);
}
