// Potts 内核，逐位对应 src/substrates/potts/ref.ts：同一个哈希、同一张阈值表、
// 同样的子格顺序、块状态里同样的并列处理。
// Potts kernels, a bit-for-bit mirror of src/substrates/potts/ref.ts: the same hash, the
// same threshold table, the same sublattice order, the same tie-breaking in block states.

struct Level {
  L: u32,        // 这一层晶格的边长 / side of this level's lattice
  seed: u32,
  level: u32,    // 原始晶格为 0 / 0 for the original lattice
  q: u32,
}

const TIE_KEY = 0x40000000u;
const ACCEPT_KEY = 0x5bd1e995u;

@group(0) @binding(0) var<uniform> U: Level;
@group(0) @binding(1) var<storage, read_write> spins: array<u32>;      // 下标 x + L y / indexed x + L y
@group(0) @binding(2) var<storage, read> thr: array<u32>;
@group(0) @binding(3) var<storage, read_write> counter: array<u32>;    // [0] = 已做的子格遍数 / sublattice passes done
@group(0) @binding(4) var<storage, read_write> coarse: array<u32>;
@group(0) @binding(5) var<storage, read_write> partial: array<vec4u>;  // 每行三个 / three per row

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

@compute @workgroup_size(8, 8)
fn metropolis(@builtin(global_invocation_id) id: vec3u) {
  let L = U.L;
  if (id.x >= L || id.y >= L) { return; }
  let done = counter[0];
  if (((id.x + id.y) & 1u) != (done & 1u)) { return; }
  let site = id.x + L * id.y;
  let a = spins[(id.x + L - 1u) % L + L * id.y];
  let b = spins[(id.x + 1u) % L + L * id.y];
  let c = spins[id.x + L * ((id.y + L - 1u) % L)];
  let d = spins[id.x + L * ((id.y + 1u) % L)];
  let old = spins[site];
  let next = (old + 1u + hash32(hash32(U.seed, done), site) % (U.q - 1u)) % U.q;
  let dE = i32(u32(a == old) + u32(b == old) + u32(c == old) + u32(d == old))
         - i32(u32(a == next) + u32(b == next) + u32(c == next) + u32(d == next));
  if (dE <= 0) { spins[site] = next; return; }
  if (hash32(hash32(U.seed ^ ACCEPT_KEY, done), site) < thr[dE]) { spins[site] = next; }
}

@compute @workgroup_size(1)
fn bump() {
  counter[0] = counter[0] + 1u;
}

// 2×2 相对多数：`spins` 是更细的晶格（边长 2 L），`coarse` 是这一层（边长 L）。
// Plurality over 2×2: `spins` is the finer lattice (side 2 L), `coarse` this level's (side L).
@compute @workgroup_size(8, 8)
fn block(@builtin(global_invocation_id) id: vec3u) {
  let M = U.L;
  if (id.x >= M || id.y >= M) { return; }
  let F = 2u * M;
  let i = 2u * id.y * F + 2u * id.x;
  var cell = array<u32, 4>(spins[i], spins[i + 1u], spins[i + F], spins[i + F + 1u]);
  var count = array<u32, 4>(0u, 0u, 0u, 0u);
  var most = 0u;
  for (var k = 0u; k < 4u; k++) {
    for (var j = 0u; j < 4u; j++) { count[k] += u32(cell[j] == cell[k]); }
    most = max(most, count[k]);
  }
  let site = id.x + M * id.y;
  var pick = hash32(hash32(U.seed, TIE_KEY + U.level), site) & 3u;
  if (count[pick] != most) {
    pick = 0u;
    while (count[pick] != most) { pick++; }
  }
  coarse[site] = cell[pick];
}

// 每行一次调用：各状态的格点数（8 个）与同态键数（每个格点向 +x、+y 各一条）。
// One invocation per row: sites in each state (8 of them) and like bonds (one each towards +x and +y per site).
@compute @workgroup_size(16)
fn reduceRows(@builtin(global_invocation_id) id: vec3u) {
  let L = U.L;
  let y = id.x;
  if (y >= L) { return; }
  var counts = array<u32, 8>(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
  var bonds = 0u;
  let down = L * ((y + 1u) % L);
  for (var x = 0u; x < L; x++) {
    let v = spins[x + L * y];
    counts[v] += 1u;
    bonds += u32(v == spins[(x + 1u) % L + L * y]) + u32(v == spins[x + down]);
  }
  partial[3u * y] = vec4u(counts[0], counts[1], counts[2], counts[3]);
  partial[3u * y + 1u] = vec4u(counts[4], counts[5], counts[6], counts[7]);
  partial[3u * y + 2u] = vec4u(bonds, 0u, 0u, 0u);
}
