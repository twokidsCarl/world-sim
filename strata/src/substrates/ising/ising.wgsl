// 二维 Ising 内核。与 src/substrates/ising/ref.ts 逐位一致：
// 相同的哈希、相同的阈值表、相同的子格顺序、相同的块自旋平局处理。
// 2D Ising kernels. Bit-for-bit mirror of src/substrates/ising/ref.ts: the same hash, the
// same threshold table, the same sublattice order, the same tie-breaking in block spins.

struct Level {
  L: u32,        // 本层晶格的边长 / side of this level's lattice
  seed: u32,
  level: u32,    // 原始晶格为 0 / 0 for the original lattice
  pad: u32,
}

const ALWAYS = 0xffffffffu;
const TIE_KEY = 0x40000000u;

@group(0) @binding(0) var<uniform> U: Level;
@group(0) @binding(1) var<storage, read_write> spins: array<u32>;
@group(0) @binding(2) var<storage, read> thr: array<u32>;
@group(0) @binding(3) var<storage, read_write> counter: array<u32>;   // [0] = 已完成的子格遍数 / [0] = sublattice passes done
@group(0) @binding(4) var<storage, read_write> coarse: array<u32>;
@group(0) @binding(5) var<storage, read_write> partial: array<vec4i>; // 每行一个 / one per row

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

fn pm(b: u32) -> i32 {
  return 2 * i32(b) - 1;
}

@compute @workgroup_size(16, 16)
fn metropolis(@builtin(global_invocation_id) id: vec3u) {
  let L = U.L;
  let x = id.x;
  let y = id.y;
  if (x >= L || y >= L) { return; }
  let done = counter[0];
  if (((x & 1u) + 2u * (y & 1u)) != (done & 3u)) { return; }
  let l = (x + L - 1u) % L;
  let r = (x + 1u) % L;
  let up = ((y + L - 1u) % L) * L;
  let down = ((y + 1u) % L) * L;
  let row = y * L;
  let nn = pm(spins[row + l]) + pm(spins[row + r]) + pm(spins[up + x]) + pm(spins[down + x]);
  let nnn = pm(spins[up + l]) + pm(spins[up + r]) + pm(spins[down + l]) + pm(spins[down + r]);
  let site = row + x;
  let s = spins[site];
  let t = thr[s * 25u + u32((nn + 4) / 2) * 5u + u32((nnn + 4) / 2)];
  if (t == ALWAYS || hash32(hash32(U.seed, done), site) < t) { spins[site] = s ^ 1u; }
}

@compute @workgroup_size(1)
fn bump() {
  counter[0] = counter[0] + 1u;
}

// 多数规则：`spins` 是较细的晶格（边长 2 L），`coarse` 是本层的晶格（边长 L）。
// Majority rule: `spins` is the finer lattice (side 2 L), `coarse` this level's (side L).
@compute @workgroup_size(16, 16)
fn block(@builtin(global_invocation_id) id: vec3u) {
  let M = U.L;
  if (id.x >= M || id.y >= M) { return; }
  let i = 2u * id.y * (2u * M) + 2u * id.x;
  let sum = spins[i] + spins[i + 1u] + spins[i + 2u * M] + spins[i + 2u * M + 1u];
  let site = id.y * M + id.x;
  var v = u32(sum > 2u);
  if (sum == 2u) { v = hash32(hash32(U.seed, TIE_KEY + U.level), site) & 1u; }
  coarse[site] = v;
}

// 每行调用一次：Σ s、Σ 最近邻键、Σ 对角键。
// One invocation per row: Σ s, Σ nearest-neighbour bonds, Σ diagonal bonds.
@compute @workgroup_size(64)
fn reduceRows(@builtin(global_invocation_id) id: vec3u) {
  let L = U.L;
  let y = id.x;
  if (y >= L) { return; }
  let down = ((y + 1u) % L) * L;
  var s = 0;
  var nn = 0;
  var nnn = 0;
  for (var x = 0u; x < L; x++) {
    let r = (x + 1u) % L;
    let l = (x + L - 1u) % L;
    let v = pm(spins[y * L + x]);
    s += v;
    nn += v * (pm(spins[y * L + r]) + pm(spins[down + x]));
    nnn += v * (pm(spins[down + r]) + pm(spins[down + l]));
  }
  partial[y] = vec4i(s, nn, nnn, 0);
}
