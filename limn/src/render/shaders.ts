/**
 * The four passes. The edge and composite passes follow Goodsell's Illustrate
 * (illustrate.f): outlines and shadows are computed from the depth and id
 * buffers only, never from surface normals.
 */

export const SPHERE_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_posr;
layout(location = 2) in vec4 a_color;
layout(location = 3) in uvec2 a_ids;
uniform mat4 u_model;
uniform mat4 u_place;
uniform mat3 u_rot;
uniform vec3 u_center;
uniform vec2 u_toClip;
uniform float u_clipFront;
uniform float u_radiusScale;
out vec2 v_uv;
out vec3 v_color;
out float v_z;
out float v_r;
flat out uvec2 v_ids;
void main() {
  vec3 world = (u_place * u_model * vec4(a_posr.xyz, 1.0)).xyz;
  vec3 view = u_rot * (world - u_center);
  float r = a_posr.w * u_radiusScale;
  v_uv = a_corner;
  v_color = a_color.rgb;
  v_z = view.z;
  v_r = r;
  v_ids = a_ids;
  // Atoms in front of the cut are dropped whole, as Illustrate does, so a
  // cross-section never shows sliced spheres.
  if (view.z > u_clipFront || r <= 0.0) {
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
uniform vec2 u_z; // front, back (view-space Å)
uniform uint u_subunitBase;
uniform uint u_molecule;
uniform bool u_outlineByMolecule;
layout(location = 0) out vec4 o_color;
layout(location = 1) out uvec4 o_ids;
void main() {
  float d2 = dot(v_uv, v_uv);
  if (d2 > 1.0) discard;
  float z = v_z + v_r * sqrt(1.0 - d2);
  gl_FragDepth = clamp((u_z.x - z) / (u_z.x - u_z.y), 0.0, 0.999999);
  o_color = vec4(v_color, 1.0);
  uint subunit = u_outlineByMolecule ? u_molecule : u_subunitBase + v_ids.x;
  o_ids = uvec4(subunit + 1u, v_ids.y, u_molecule, 1u);
}`

export const QUAD_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
void main() { gl_Position = vec4(a_corner, 0.0, 1.0); }`

/** R: contour line strength, G: subunit/residue line strength, B: shadow. */
export const EDGE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D u_depth;
uniform usampler2D u_ids;
uniform vec2 u_z;
uniform float u_pen;       // pixels per kernel step
uniform float u_pxPerA;
uniform vec4 u_contour;    // low, high, diffMin Å, diffMax Å
uniform vec3 u_subunit;    // low, high, strength 0..1
uniform vec3 u_residue;    // low, high, residue-number difference
uniform vec4 u_shadow;     // strength per sample, cone angle, floor, radius Å
uniform int u_shadowN;     // samples per side of centre (10 = Illustrate's 21x21)
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
  float ro = clamp((r - u_subunit.x) / (u_subunit.y - u_subunit.x), 0.0, 1.0);
  // The silhouette keeps its full line; only lines between chains fade.
  if (atom0) ro *= u_subunit.z;
  float go = clamp((g - u_residue.x) / (u_residue.y - u_residue.x), 0.0, 1.0);

  // Conical shadow: every sampled neighbour that stands higher than this
  // pixel, and steeply enough, removes a fixed amount of light.
  float shade = 1.0;
  if (atom0 && u_shadow.x > 0.0) {
    float n = float(u_shadowN);
    float stepA = u_shadow.w / n;           // Å between samples
    float rc = u_shadow.w / 50.0;           // Illustrate's rcone, 1 px of 50
    float per = u_shadow.x * (100.0 / (n * n)); // keep total strength when using fewer samples
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
uniform vec2 u_zSpan;   // nearest and farthest content, view-space Å
uniform vec3 u_bg;
uniform vec3 u_fog;
uniform vec2 u_fogAmt;  // share of true colour kept at the front and at the back
uniform vec3 u_ink;
uniform float u_grain;
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
  ivec2 size = textureSize(u_edge, 0);
  vec4 e = texelFetch(u_edge, p, 0);

  // Illustrate's antialiasing of contour lines: where most of the 3x3
  // neighbourhood is on a line, average it; otherwise keep the centre.
  float sum = 0.0, cnt = 0.0;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      float v = texelFetch(u_edge, clamp(p + ivec2(i, j), ivec2(0), size - 1), 0).r;
      sum += v;
      if (v > 0.0) cnt += 1.0;
    }
  }
  float line = cnt >= 6.0 ? min(sum / 6.0, 1.0) : e.r;
  line = max(line, e.g);

  float d = texelFetch(u_depth, p, 0).r;
  vec3 rgb = u_bg;
  if (d < 1.0) {
    float z = mix(u_z.x, u_z.y, d);
    float t = clamp((u_zSpan.x - z) / max(u_zSpan.x - u_zSpan.y, 1.0e-3), 0.0, 1.0);
    float keep = mix(u_fogAmt.x, u_fogAmt.y, t);
    rgb = mix(u_fog, texelFetch(u_color, p, 0).rgb * e.b, keep);
  }
  rgb = mix(rgb, u_ink, line);
  if (u_grain > 0.0) {
    // Paper tooth: two octaves of value noise, darkening only.
    vec2 q = gl_FragCoord.xy / float(max(size.x, size.y)) * 1500.0;
    float n = noise(q * 0.9) * 0.6 + noise(q * 2.3) * 0.4;
    rgb *= 1.0 - u_grain * (n - 0.35);
  }
  o = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`
