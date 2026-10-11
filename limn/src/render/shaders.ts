/**
 * 四个渲染通道。边线通道和合成通道照 Goodsell 的 Illustrate（illustrate.f）来做：
 * 描边和阴影只由深度缓冲和 id 缓冲算出，从不使用表面法线。
 * The four passes. The edge and composite passes follow Goodsell's Illustrate
 * (illustrate.f): outlines and shadows are computed from the depth and id
 * buffers only, never from surface normals.
 */

/**
 * 一次绘制画“一段原子 × 若干实例”：原子和实例都放在纹理里，用实例序号去查。
 * One call draws a run of atoms times a range of instances: atoms and instances both live
 * in textures and are looked up from the instance index.
 */
export const SPHERE_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
layout(location = 0) in vec2 a_corner;
uniform sampler2D u_posr;
uniform sampler2D u_color;
uniform usampler2D u_ids;
uniform sampler2D u_inst;
uniform usampler2D u_instIds;
uniform int u_w;
uniform ivec3 u_run; // 起始原子、本段原子数、起始实例 / first atom, atoms in the run, first instance
uniform mat4 u_place;
uniform mat3 u_rot;
uniform vec3 u_center;
uniform vec2 u_toClip;
uniform float u_clipFront;
uniform float u_radiusScale;
uniform float u_minRadius; // Å
uniform vec3 u_layer;   // 景深层数（0 = 不分层）、淡出开始和结束处的视图 z / depth layers (0 = none), view z where fading starts and ends
uniform vec2 u_fogKeep; // 前端和后端各保留的本色比例 / share of true colour kept at the front and at the back
out vec2 v_uv;
out vec3 v_color;
out float v_z;
out float v_r;
flat out float v_keep;
flat out uvec2 v_ids;
flat out uvec2 v_inst;
void main() {
  int a = u_run.x + gl_InstanceID % u_run.y;
  int o = u_run.z + gl_InstanceID / u_run.y;
  ivec2 at = ivec2(a % u_w, a / u_w);
  vec4 posr = texelFetch(u_posr, at, 0);
  int per = u_w / 4;
  ivec2 ip = ivec2((o % per) * 4, o / per);
  vec4 p = vec4(posr.xyz, 1.0);
  vec3 local = vec3(dot(texelFetch(u_inst, ip, 0), p), dot(texelFetch(u_inst, ip + ivec2(1, 0), 0), p), dot(texelFetch(u_inst, ip + ivec2(2, 0), 0), p));
  vec4 mc = texelFetch(u_inst, ip + ivec2(3, 0), 0);
  vec3 view = u_rot * ((u_place * vec4(local, 1.0)).xyz - u_center);
  // 纤维的各股至少取最小半径的两倍，这样缠成一团时仍看得出是一股一股的
  // strands of a fibre are held to twice the minimum, so a tangle still reads as strands
  float r = posr.w <= 0.0 ? 0.0 : max(posr.w * u_radiusScale, u_minRadius * (mc.w > 1.5 && mc.w < 2.5 ? 2.0 : 1.0));
  v_uv = a_corner;
  v_color = texelFetch(u_color, at, 0).rgb;
  v_z = view.z;
  v_r = r;
  v_ids = texelFetch(u_ids, at, 0).rg;
  v_inst = texelFetch(u_instIds, ivec2(o % u_w, o / u_w), 0).rg;
  v_keep = 1.0;
  // 截面之前的原子整个丢弃，和 Illustrate 一样，所以剖面上不会出现被切开的球。
  // 已知中心的分子整体保留或丢弃，所以也不会被切开。
  // Atoms in front of the cut are dropped whole, as Illustrate does, so a
  // cross-section never shows sliced spheres. A molecule whose centre is
  // known is kept or dropped as a whole, so none is sliced either.
  float zcut = view.z;
  // 3 = 永不切掉（叠在密度图里的原子模型）/ 3 = never cut away (an atomic model shown inside a density map)
  if (mc.w > 2.5) {
    zcut = -1.0e30;
  } else if (mc.w > 0.5) {
    float zc = (u_rot * ((u_place * vec4(mc.xyz, 1.0)).xyz - u_center)).z;
    zcut = zc;
    if (u_layer.x > 0.0) {
      // 整个分子取其中心所在景深层的色调
      // the whole molecule takes the tone of the layer its centre is in
      float t = clamp((u_layer.y - zc) / max(u_layer.y - u_layer.z, 1.0e-3), 0.0, 0.999);
      float s = u_layer.x <= 1.0 ? 0.0 : floor(t * u_layer.x) / (u_layer.x - 1.0);
      v_keep = mix(u_fogKeep.x, u_fogKeep.y, s);
    }
  }
  if (zcut > u_clipFront || r <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_Position = vec4((view.xy + a_corner * r) * u_toClip, 0.0, 1.0);
}`

export const SPHERE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
in vec3 v_color;
in float v_z;
in float v_r;
flat in uvec2 v_ids;
flat in uvec2 v_inst;  // 该拷贝的链编号偏移、分子编号 / chain-index offset of this copy, molecule id
flat in float v_keep;  // 该分子保留的本色比例（景深层） / share of true colour this molecule keeps (depth layers)
uniform vec2 u_z; // 前、后（视图空间，Å） / front, back (view-space Å)
uniform bool u_outlineByMolecule;
layout(location = 0) out vec4 o_color;
layout(location = 1) out uvec4 o_ids;
void main() {
  float d2 = dot(v_uv, v_uv);
  if (d2 > 1.0) discard;
  float z = v_z + v_r * sqrt(1.0 - d2);
  gl_FragDepth = clamp((u_z.x - z) / (u_z.x - u_z.y), 0.0, 0.999999);
  o_color = vec4(v_color, v_keep);
  uint subunit = u_outlineByMolecule ? v_inst.y : v_inst.x + v_ids.x;
  o_ids = uvec4(subunit + 1u, v_ids.y, v_inst.y, 1u);
}`

export const QUAD_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
void main() { gl_Position = vec4(a_corner, 0.0, 1.0); }`

/** R：轮廓线强度，G：亚基/残基线强度，B：阴影 / R: contour line strength, G: subunit/residue line strength, B: shadow. */
export const EDGE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D u_depth;
uniform usampler2D u_ids;
uniform vec2 u_z;
uniform float u_pen;       // 每个卷积核步长的像素数 / pixels per kernel step
uniform float u_pxPerA;
uniform vec4 u_contour;    // 低阈值、高阈值、diffMin Å、diffMax Å / low, high, diffMin Å, diffMax Å
uniform vec3 u_subunit;    // 低阈值、高阈值、强度 0..1 / low, high, strength 0..1
uniform vec3 u_residue;    // 低阈值、高阈值、残基编号差 / low, high, residue-number difference
uniform vec4 u_shadow;     // 每个采样的强度、锥角、下限、半径 Å / strength per sample, cone angle, floor, radius Å
uniform int u_shadowN;     // 中心每侧的采样数（10 = Illustrate 的 21x21） / samples per side of centre (10 = Illustrate's 21x21)
out vec4 o;

ivec2 size;
ivec2 clampP(ivec2 p) { return clamp(p, ivec2(0), size - 1); }
float zAt(ivec2 p) {
  float d = texelFetch(u_depth, clampP(p), 0).r;
  return d >= 1.0 ? -1.0e4 : mix(u_z.x, u_z.y, d);
}

void main() {
  size = textureSize(u_depth, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float z0 = zAt(p);
  uvec4 id0 = texelFetch(u_ids, p, 0);
  bool atom0 = id0.a != 0u;

  float l = 0.0, r = 0.0, g = 0.0;
  for (int i = -2; i <= 2; i++) {
    for (int j = -2; j <= 2; j++) {
      if (abs(i * j) == 4) continue;
      ivec2 q = p + ivec2(round(vec2(float(i), float(j)) * u_pen));
      float rd = abs(z0 - zAt(q));
      if (rd > u_contour.z) l += min((rd - u_contour.z) / (u_contour.w - u_contour.z), 1.0);
      uvec4 id = texelFetch(u_ids, clampP(q), 0);
      if (id.r != id0.r) r += 1.0;
      if (atom0 && id.a != 0u && abs(float(int(id.g) - int(id0.g))) > u_residue.z) g += 1.0;
    }
  }
  float lo = clamp((l - u_contour.x) / (u_contour.y - u_contour.x), 0.0, 1.0);
  // Illustrate 在像素之间从不清零它的累计计数，所以每个像素都从邻居的线强度（0..1）起算；
  // 这里用像素自身的强度代替邻居的。
  // Illustrate never clears its running count between pixels, so each one
  // starts from its neighbour's line strength (0..1); the pixel's own strength
  // stands in for the neighbour's here.
  lo = clamp((l + lo - u_contour.x) / (u_contour.y - u_contour.x), 0.0, 1.0);
  float ro = clamp((r - u_subunit.x) / (u_subunit.y - u_subunit.x), 0.0, 1.0);
  // 外轮廓保留完整的线；只有链间的线淡出。
  // The silhouette keeps its full line; only lines between chains fade.
  if (atom0) ro *= u_subunit.z;
  float go = clamp((g - u_residue.x) / (u_residue.y - u_residue.x), 0.0, 1.0);

  // 锥形阴影：每个采样到的邻居，只要比本像素高且足够陡，就减去固定量的光。
  // Conical shadow: every sampled neighbour that stands higher than this
  // pixel, and steeply enough, removes a fixed amount of light.
  float shade = 1.0;
  if (atom0 && u_shadow.x > 0.0) {
    float n = float(u_shadowN);
    float stepA = u_shadow.w / n;           // 采样间距（Å） / Å between samples
    float rc = u_shadow.w / 50.0;           // Illustrate 的 rcone，50 px 中的 1 px / Illustrate's rcone, 1 px of 50
    float per = u_shadow.x * (100.0 / (n * n)); // 采样数减少时保持总强度不变 / keep total strength when using fewer samples
    for (int i = -u_shadowN; i <= u_shadowN; i++) {
      for (int j = -u_shadowN; j <= u_shadowN; j++) {
        if (i == 0 && j == 0) continue;
        vec2 offA = vec2(float(i), float(j)) * stepA;
        float dist = length(offA);
        if (dist > u_shadow.w) continue;
        float dz = zAt(p + ivec2(round(offA * u_pxPerA))) - z0;
        if (dz > rc && dist * u_shadow.y < dz + rc) shade -= per;
      }
    }
    shade = max(shade, u_shadow.z);
  }
  o = vec4(lo, max(ro, go), shade, 1.0);
}`

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_color;
uniform sampler2D u_edge;
uniform sampler2D u_depth;
uniform vec2 u_z;
uniform vec2 u_zSpan;   // 最近和最远的内容，视图空间 Å / nearest and farthest content, view-space Å
uniform vec3 u_bg;
uniform vec3 u_fog;
uniform vec2 u_fogAmt;  // 前端和后端各保留的本色比例 / share of true colour kept at the front and at the back
uniform vec3 u_ink;
uniform float u_grain;
uniform bool u_layered; // 景深淡出已按分子决定，存在颜色的 alpha 里 / depth fading was decided per molecule, in the colour's alpha
out vec4 o;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 e = texelFetch(u_edge, p, 0);

  // Illustrate 本意是在 3x3 邻域上平滑轮廓线，但按它实际的写法（illustrate.f，kernel 4）
  // 九个采样全是中心那一个，所以它的图上实际呈现的是线强度乘以 9/6。
  // Illustrate means to smooth contour lines over a 3x3 neighbourhood, but
  // as written (illustrate.f, kernel 4) all nine samples are the centre one,
  // so what its pictures actually show is the line strength times 9/6.
  float line = min(e.r * 1.5, 1.0);
  line = max(line, e.g);

  float d = texelFetch(u_depth, p, 0).r;
  vec3 rgb = u_bg;
  if (d < 1.0) {
    float z = mix(u_z.x, u_z.y, d);
    float t = clamp((u_zSpan.x - z) / max(u_zSpan.x - u_zSpan.y, 1.0e-3), 0.0, 1.0);
    float keep = mix(u_fogAmt.x, u_fogAmt.y, t);
    vec4 c = texelFetch(u_color, p, 0);
    if (u_layered) keep = c.a;
    rgb = mix(u_fog, c.rgb * e.b, keep);
  }
  rgb = mix(rgb, u_ink, line);
  if (u_grain > 0.0) {
    // 纸纹：两个倍频的值噪声，只压暗。
    // Paper tooth: two octaves of value noise, darkening only.
    ivec2 size = textureSize(u_edge, 0);
    vec2 q = gl_FragCoord.xy / float(max(size.x, size.y)) * 1500.0;
    float n = noise(q * 0.9) * 0.6 + noise(q * 2.3) * 0.4;
    rgb *= 1.0 - u_grain * (n - 0.35);
  }
  o = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`
