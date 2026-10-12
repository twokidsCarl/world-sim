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
uniform float u_clipBack;   // 视图 z 比这更靠后的丢弃（切片的背面）；没有切片时是一个很大的负数 / dropped when farther back than this view z (the back of the slab); a large negative number without a slab
uniform float u_radiusScale;
uniform float u_minRadius; // Å
uniform float u_inflate;   // 平滑用的探针半径（Å），加在每个球上；见 SMOOTH_FS / the probe radius for smoothing in Å, added to every sphere; see SMOOTH_FS
uniform vec3 u_layer;   // 景深层数（0 = 不分层）、淡出开始和结束处的视图 z / depth layers (0 = none), view z where fading starts and ends
uniform vec2 u_fogKeep; // 前端和后端各保留的本色比例 / share of true colour kept at the front and at the back
out vec2 v_uv;
out vec3 v_color;
out float v_z;
out float v_r;
flat out float v_keep;
flat out float v_fine;
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
  float r = posr.w <= 0.0 ? 0.0 : max(posr.w * u_radiusScale, u_minRadius * (mc.w > 1.5 && mc.w < 2.5 ? 2.0 : 1.0)) + u_inflate;
  v_uv = a_corner;
  v_color = texelFetch(u_color, at, 0).rgb;
  v_z = view.z;
  v_r = r;
  v_ids = texelFetch(u_ids, at, 0).rg;
  v_inst = texelFetch(u_instIds, ivec2(o % u_w, o / u_w), 0).rg;
  v_keep = 1.0;
  // 4 = 一大群小分子里的一个：彼此之间不画轮廓线 / 4 = one of a crowd of small molecules, with no contours drawn among them
  // 5 = 一整张不分块的膜：表面的小起伏不画线，按每个球自己的深度来切和上色调
  // 5 = a membrane in one piece: its small relief draws no lines, and it is cut and toned sphere by sphere at each sphere's own depth
  // 6 = 切片的背面不切它（衬在里面的一层，免得空隙里露出白纸）/ 6 = not cut at the back of a slab (a layer lining the inside, so that gaps do not show paper)
  // 7 = 膜，并且衬在后面（切片的背面不切）/ 7 = a membrane that also lines the back (not cut at the back of a slab)
  v_fine = (mc.w > 4.5 && mc.w < 5.5) || mc.w > 6.5 ? 2.0 : mc.w > 3.5 && mc.w < 4.5 ? 1.0 : 0.0;
  // 截面之前的原子整个丢弃，和 Illustrate 一样，所以剖面上不会出现被切开的球。
  // 已知中心的分子整体保留或丢弃，所以也不会被切开。
  // Atoms in front of the cut are dropped whole, as Illustrate does, so a
  // cross-section never shows sliced spheres. A molecule whose centre is
  // known is kept or dropped as a whole, so none is sliced either.
  float zcut = view.z;
  // 3 = 永不切掉（叠在密度图里的原子模型）/ 3 = never cut away (an atomic model shown inside a density map)
  if (mc.w > 2.5 && mc.w < 3.5) {
    zcut = -1.0e30;
  } else if ((mc.w > 4.5 && mc.w < 5.5) || mc.w > 6.5) {
    if (u_layer.x > 0.0) {
      // 整张膜的色调随深度连续变化，不分档：按球分档会在档与档交界处出一圈杂点
      // a membrane in one piece is toned continuously with depth, not in steps: stepping sphere by sphere leaves a ring of speckle where steps meet
      // 整张膜平涂，不随深度变：他画里的膜是一条颜色均匀的浅带子，切片里露出来的那一小段内壁不另加明暗
      // a membrane in one piece is a flat wash that does not change with depth: in his paintings a membrane is an even pale band, and the short stretch of inner wall a slab exposes gets no shading of its own
      v_keep = u_fogKeep.x;
    }
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
  // 切片：整个分子按它的中心留或丢，所以切片里的分子都是完整的；永不切的东西（标志 3）除外
  // a slab: a molecule is kept or dropped whole by its centre, so every molecule in the slab is complete; except what is never cut (flag 3)
  if (zcut > u_clipFront || r <= 0.0 || (zcut < u_clipBack && !(mc.w > 2.5 && mc.w < 3.5) && mc.w < 4.5)) {
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
flat in float v_keep;
flat in float v_fine;  // 该分子保留的本色比例（景深层） / share of true colour this molecule keeps (depth layers)
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
  // 第四个分量：0 = 没有东西，1 = 普通原子，2 = 小分子群里的原子，3 = 网格被剖开露出的背面，4 = 整张膜上的球
  // fourth channel: 0 = nothing, 1 = an ordinary atom, 2 = an atom of a crowd of small molecules, 3 = the back of a mesh exposed by a cut, 4 = a sphere of a membrane in one piece
  o_ids = uvec4(subunit + 1u, v_ids.y, v_inst.y, v_fine > 1.5 ? 4u : v_fine > 0.5 ? 2u : 1u);
}`

/**
 * 胶囊：把两个原子（位置和半径取自同一张原子纹理）连成一段圆台。每段画一个贴着它投影的长方形，
 * 片元里求视线与圆台侧面的交点。两端的球冠不在这里画：两个端点本身各有一个球。
 * 求交的算式见 src/render/capsule.ts，那里有同一段算式的可测版本。
 *
 * Capsules: two atoms (positions and radii from the same atom texture) joined into a round cone.
 * Each segment draws a rectangle hugging its projection, and the fragment finds where the line
 * of sight meets the side of the cone. The end caps are not drawn here: each end is an atom with
 * a sphere of its own. The algebra is in src/render/capsule.ts, in a form that can be tested.
 */
export const CAPSULE_VS = /* glsl */ `#version 300 es
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
uniform usampler2D u_seg;
uniform int u_w;
uniform mat4 u_place;
uniform mat3 u_rot;
uniform vec3 u_center;
uniform vec2 u_toClip;
uniform float u_clipFront;
uniform float u_radiusScale;
uniform float u_minRadius;
uniform float u_inflate;
uniform float u_clipBack;
uniform vec3 u_layer;
uniform vec2 u_fogKeep;
out vec2 v_xy;
flat out float v_keep;
flat out vec4 v_a;
flat out vec4 v_b;
flat out vec3 v_color;
flat out uvec2 v_ids;
flat out uvec2 v_inst;
vec3 toView(vec3 q) {
  vec4 p = vec4(q, 1.0);
  // 线段只按第一个实例画 / segments are drawn for the first instance only
  vec3 local = vec3(dot(texelFetch(u_inst, ivec2(0, 0), 0), p), dot(texelFetch(u_inst, ivec2(1, 0), 0), p), dot(texelFetch(u_inst, ivec2(2, 0), 0), p));
  return u_rot * ((u_place * vec4(local, 1.0)).xyz - u_center);
}
void main() {
  uvec2 s = texelFetch(u_seg, ivec2(gl_InstanceID % u_w, gl_InstanceID / u_w), 0).rg;
  ivec2 ia = ivec2(int(s.x) % u_w, int(s.x) / u_w), ib = ivec2(int(s.y) % u_w, int(s.y) / u_w);
  vec4 A = texelFetch(u_posr, ia, 0), B = texelFetch(u_posr, ib, 0);
  float ra = max(A.w * u_radiusScale, u_minRadius) + u_inflate, rb = max(B.w * u_radiusScale, u_minRadius) + u_inflate;
  vec3 pa = toView(A.xyz), pb = toView(B.xyz);
  // 和球一样：端点被截面丢掉的线段整段不画 / as with spheres: a segment with an end dropped by the cut is not drawn at all
  // 切片的背面同理；色调和两端的球一致，取最前一层的 / likewise at the back of a slab; the tone matches the spheres at its ends, that of the front layer
  v_keep = u_layer.x > 0.0 ? u_fogKeep.x : 1.0;
  if (A.w <= 0.0 || B.w <= 0.0 || max(pa.z, pb.z) > u_clipFront || min(pa.z, pb.z) < u_clipBack) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 d = pb.xy - pa.xy;
  float len = length(d);
  vec2 u = len > 1.0e-6 ? d / len : vec2(1.0, 0.0);
  float rm = max(ra, rb);
  vec2 xy = (pa.xy + pb.xy) * 0.5 + u * a_corner.x * (len * 0.5 + rm) + vec2(-u.y, u.x) * a_corner.y * rm;
  v_xy = xy;
  v_a = vec4(pa, ra);
  v_b = vec4(pb, rb);
  // 颜色和编号取第二个端点的 / colour and ids are those of the second end
  v_color = texelFetch(u_color, ib, 0).rgb;
  v_ids = texelFetch(u_ids, ib, 0).rg;
  v_inst = texelFetch(u_instIds, ivec2(0, 0), 0).rg;
  gl_Position = vec4(xy * u_toClip, 0.0, 1.0);
}`

export const CAPSULE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_xy;
flat in vec4 v_a;
flat in vec4 v_b;
flat in vec3 v_color;
flat in uvec2 v_ids;
flat in uvec2 v_inst;
flat in float v_keep;
uniform vec2 u_z;
uniform bool u_outlineByMolecule;
layout(location = 0) out vec4 o_color;
layout(location = 1) out uvec4 o_ids;
void main() {
  vec3 pa = v_a.xyz, pb = v_b.xyz;
  float ra = v_a.w, rb = v_b.w;
  float top = max(pa.z + ra, pb.z + rb);
  vec3 ba = pb - pa;
  vec3 oa = vec3(v_xy, top) - pa;
  float rr = ra - rb;
  float m0 = dot(ba, ba);
  float d2 = m0 - rr * rr;
  if (d2 <= 0.0) discard;
  float m1 = dot(ba, oa), m2 = -ba.z, m3 = -oa.z, m5 = dot(oa, oa);
  float k2 = d2 - m2 * m2;
  float k1 = d2 * m3 - m1 * m2 + m2 * rr * ra;
  float k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2.0 - m0 * ra * ra;
  float h = k1 * k1 - k0 * k2;
  if (h < 0.0 || abs(k2) < 1.0e-7 * m0) discard;
  float sq = sqrt(h);
  float t1 = (-k1 - sq) / k2, t2 = (-k1 + sq) / k2;
  float y1 = m1 - ra * rr + t1 * m2, y2 = m1 - ra * rr + t2 * m2;
  float t = 1.0e30;
  if (y1 > 0.0 && y1 < d2) t = t1;
  if (y2 > 0.0 && y2 < d2) t = min(t, t2);
  if (t > 1.0e29) discard;
  float z = top - t;
  gl_FragDepth = clamp((u_z.x - z) / (u_z.x - u_z.y), 0.0, 0.999999);
  o_color = vec4(v_color, v_keep);
  uint subunit = u_outlineByMolecule ? v_inst.y : v_inst.x + v_ids.x;
  o_ids = uvec4(subunit + 1u, v_ids.y, v_inst.y, 1u);
}`

/**
 * 三角网格：顶点就是原子纹理里的点（顶点下标 = 原子下标），所以只需要一张下标表。平色，不用法线，
 * 描边和阴影同样只从深度和编号算。截面处按片元丢弃，实心的东西（细胞器）露出来的背面画在截面上，剖开看到的是实心的断面；不标成实心的（密度图的等值面）剖开看到的是壳的里面。
 *
 * Triangle meshes: the vertices are the points in the atom texture (vertex index = atom index),
 * so an index list is all that is needed. Flat colour and no normals; outlines and shadows come
 * from depth and ids as everywhere else. At a cut, fragments are discarded one by one and the
 * back faces this exposes are drawn on the cut plane when the mesh is marked solid (organelles),
 * so a cut-away shows solid sections; one not so marked (the isosurface of a density map) shows
 * the inside of its shell.
 */
export const MESH_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
uniform sampler2D u_posr;
uniform sampler2D u_color;
uniform usampler2D u_ids;
uniform sampler2D u_inst;
uniform usampler2D u_instIds;
uniform int u_w;
uniform mat4 u_place;
uniform mat3 u_rot;
uniform vec3 u_center;
uniform vec2 u_toClip;
out float v_z;
flat out vec3 v_color;
flat out uvec2 v_ids;
flat out uvec2 v_inst;
void main() {
  ivec2 at = ivec2(gl_VertexID % u_w, gl_VertexID / u_w);
  vec4 p = vec4(texelFetch(u_posr, at, 0).xyz, 1.0);
  vec3 local = vec3(dot(texelFetch(u_inst, ivec2(0, 0), 0), p), dot(texelFetch(u_inst, ivec2(1, 0), 0), p), dot(texelFetch(u_inst, ivec2(2, 0), 0), p));
  vec3 view = u_rot * ((u_place * vec4(local, 1.0)).xyz - u_center);
  v_z = view.z;
  v_color = texelFetch(u_color, at, 0).rgb;
  v_ids = texelFetch(u_ids, at, 0).rg;
  v_inst = texelFetch(u_instIds, ivec2(0, 0), 0).rg;
  gl_Position = vec4(view.xy * u_toClip, 0.0, 1.0);
}`

export const MESH_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in float v_z;
flat in vec3 v_color;
flat in uvec2 v_ids;
flat in uvec2 v_inst;
uniform vec2 u_z;
uniform float u_clipFront;
uniform bool u_outlineByMolecule;
uniform bool u_solid; // 这张网格围着的是实心的东西 / this mesh encloses something solid
layout(location = 0) out vec4 o_color;
layout(location = 1) out uvec4 o_ids;
void main() {
  if (v_z > u_clipFront) discard;
  // 剖开时，看得见背面就说明视线是在截面上进到物体里面的：把这个像素画在截面上，切口于是是一个平的实心断面，
  // 而不是一个空壳。网格要封闭、法线朝外才成立。
  // With a cut, a visible back face means the line of sight entered the solid at the cut plane:
  // the pixel is drawn on that plane, so a cut shows a flat solid section instead of a hollow
  // shell. This holds for closed meshes with outward normals.
  // 深度照实写，这样深度测试挑出的确实是视线碰到的第一个面；它若是背面，就在编号的第四个分量里记 3，
  // 后面的描边和合成通道把这样的像素当作位于截面上。
  // The true depth is written, so that the depth test really picks the first face along the line
  // of sight; if that face is a back face, 3 goes into the fourth id channel, and the edge and
  // composite passes treat such a pixel as lying on the cut plane.
  gl_FragDepth = clamp((u_z.x - v_z) / (u_z.x - u_z.y), 0.0, 0.999999);
  o_color = vec4(v_color, 1.0);
  uint subunit = u_outlineByMolecule ? v_inst.y : v_inst.x + v_ids.x;
  o_ids = uvec4(subunit + 1u, v_ids.y, v_inst.y, u_solid && !gl_FrontFacing && u_clipFront < 1.0e29 ? 3u : 1u);
}`

/**
 * “滚球”平滑：把原子的疙瘩抹成光滑的轮廓，分子的外形和大小不变。
 *
 * 画球时每个球的半径已经加了探针半径 p，得到的深度图是“探针球心能到的最近处”。这里再对它做一次
 * 以半径 p 的球为结构元的腐蚀：每个像素取周围 p 以内各点的 深度 − sqrt(p² − 距离²) 的最小值。
 * 两步合起来是高度场上的闭运算，也就是从观察方向看到的、探针滚过之后的表面：原子之间的沟被填平，
 * 凸出的地方回到原处。周围 p 以内只要有背景，这个像素就回到背景，所以轮廓不会变胖。
 * 颜色和编号取自给出最小值的那个邻点：在近处分子的边缘，被露出来的是它后面的东西。
 *
 * "Rolling ball" smoothing: the lumps of atoms are wiped into smooth outlines, with the shape and
 * size of each molecule unchanged.
 *
 * The spheres were drawn with the probe radius p added to each, so the depth map is "the nearest
 * the centre of a probe can come". Here that map is eroded with a ball of radius p as structuring
 * element: each pixel takes the minimum, over points within p, of depth − sqrt(p² − distance²).
 * Together the two steps are a closing of the height field, the surface a probe leaves after
 * rolling over it as seen from the viewer: grooves between atoms are filled and what stood out
 * returns to where it was. If anything within p is background the pixel goes back to background,
 * so outlines do not grow fatter. Colour and ids come from the neighbour that gave the minimum:
 * at the rim of a nearer molecule, what is uncovered is whatever lies behind it.
 */
export const SMOOTH_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D u_depth;
uniform sampler2D u_color;
uniform usampler2D u_ids;
uniform vec2 u_z;
uniform float u_probe;   // Å
uniform float u_pxPerA;
uniform int u_rings;     // 采样的圈数；交互时少取几圈 / rings of samples; fewer while interacting
layout(location = 0) out vec4 o_color;
layout(location = 1) out uvec4 o_ids;
void main() {
  ivec2 size = textureSize(u_depth, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float d0 = texelFetch(u_depth, p, 0).r;
  if (d0 >= 1.0) discard;
  float own = mix(u_z.x, u_z.y, d0) - u_probe;
  float best = own;
  ivec2 at = p;
  float R = u_probe * u_pxPerA;
  for (int k = 1; k <= u_rings; k++) {
    float f = float(k) / float(u_rings);
    int n = 6 + 4 * k;
    float h = u_probe * sqrt(max(0.0, 1.0 - f * f));
    for (int j = 0; j < n; j++) {
      // 每一圈错开半步，免得采样排成放射状的线 / each ring is offset by half a step, so that samples do not line up along spokes
      float a = (float(j) + 0.5 * float(k)) * 6.2831853 / float(n);
      ivec2 q = p + ivec2(round(vec2(cos(a), sin(a)) * R * f));
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      float dq = texelFetch(u_depth, q, 0).r;
      if (dq >= 1.0) discard;
      float z = mix(u_z.x, u_z.y, dq) - h;
      if (z < best) {
        best = z;
        at = q;
      }
    }
  }
  gl_FragDepth = clamp((u_z.x - best) / (u_z.x - u_z.y), 0.0, 0.999999);
  // 只有当最小值比本像素自己的低出一截（真的露出了后面的东西）才换用那个邻点的颜色和编号；
  // 否则在分子内部，最小值在几个采样之间来回跳，编号跟着跳，会描出碎线
  // the neighbour's colour and ids are taken only when its minimum is well below this pixel's own (something behind really is uncovered);
  // otherwise, inside a molecule, the minimum hops between samples, the ids hop with it, and broken lines get drawn
  if (own - best < 0.6 * u_probe) at = p;
  o_color = texelFetch(u_color, at, 0);
  o_ids = texelFetch(u_ids, at, 0);
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
uniform vec2 u_cap;        // x > 0：场景里有网格被剖开；y：截面的视图 z / x > 0: a mesh in the scene is cut; y: view z of the cut plane
out vec4 o;

ivec2 size;
ivec2 clampP(ivec2 p) { return clamp(p, ivec2(0), size - 1); }
float zAt(ivec2 p) {
  float d = texelFetch(u_depth, clampP(p), 0).r;
  // 网格被剖开后露出的背面：算作在截面上 / the back of a mesh exposed by the cut counts as lying on the cut plane
  if (u_cap.x > 0.0 && d < 1.0 && texelFetch(u_ids, clampP(p), 0).a == 3u) return u_cap.y;
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
      uvec4 id = texelFetch(u_ids, clampP(q), 0);
      // 同一群小分子内部的深度台阶不算轮廓 / a depth step inside one crowd of small molecules is not a contour
      bool within = id0.a == 2u && id.a == 2u && id.b == id0.b;
      // 同一张膜上不到半层膜厚的起伏也不算；更大的台阶（膜的切口对着远处的膜）照常画线
      // nor is relief of under half a bilayer on one membrane; a larger step (the cut edge of the membrane against membrane far behind) draws its line as usual
      if (id0.a == 4u && id.a == 4u && id.b == id0.b && rd < 20.0) within = true;
      if (rd > u_contour.z && !within) l += min((rd - u_contour.z) / (u_contour.w - u_contour.z), 1.0);
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
uniform highp usampler2D u_ids;
uniform vec2 u_cap;     // 同描边通道 / as in the edge pass
uniform vec3 u_inkTint; // x：线取“该处填色压暗”的比例（0 = 用固定的墨色）；y：压暗到本色的几成；z：笔宽（像素）
                        // x: how far a line takes "the fill here, darkened" (0 = the fixed ink); y: how dark, as a share of the fill; z: pen width in pixels
uniform vec3 u_mid;      // 膜的中线：强度、带子最宽多少像素、虚线的周期（像素）/ membrane mid-line: strength, widest band in pixels, dash period in pixels
uniform float u_fogShade; // > 0：景深不是褪向雾色，而是把本色压暗、加浓；值是最远处的明暗系数 / > 0: depth does not fade to the fog colour but darkens and enriches the fill itself; the value is the factor at the far end
out vec4 o;

// 压暗并略微加浓：Goodsell 画里远处的层和线都是“同一个颜色的深一号”，彩度不跟着掉
// darken and enrich a little: in Goodsell's paintings both the far layers and the lines are "the same colour, a shade deeper", and chroma does not drop with it
vec3 deepen(vec3 c, float k) {
  vec3 d = c * k;
  float g = dot(d, vec3(0.299, 0.587, 0.114));
  return clamp(mix(vec3(g), d, 1.0 + 0.9 * (1.0 - k)), 0.0, 1.0);
}

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
    if (u_cap.x > 0.0 && texelFetch(u_ids, p, 0).a == 3u) z = u_cap.y;
    float t = clamp((u_zSpan.x - z) / max(u_zSpan.x - u_zSpan.y, 1.0e-3), 0.0, 1.0);
    float keep = mix(u_fogAmt.x, u_fogAmt.y, t);
    vec4 c = texelFetch(u_color, p, 0);
    if (u_layered) keep = c.a;
    if (u_fogShade > 0.0) rgb = deepen(c.rgb, mix(u_fogShade, 1.0, keep)) * e.b;
    else rgb = mix(u_fog, c.rgb * e.b, keep);
  }
  if (u_mid.x > 0.0 && d < 1.0 && texelFetch(u_ids, p, 0).a == 4u) {
    // 朝四个方向的正反两边各走到膜的边界；两边都在限度内、而且差不多一样远的地方就是中线。
    // 正对着看的膜（一大片）两边都走不到边，不画。
    // March both ways along four directions to the edge of the membrane; where both edges lie within the limit and about equally far, that is the mid-line.
    // A membrane seen face-on (a broad area) reaches no edge either way and gets no line.
    ivec2 size = textureSize(u_ids, 0);
    int reach = int(u_mid.y);
    float best = 1.0e9;
    vec2 across = vec2(0.0);
    float off = 0.0;
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.3926991;
      vec2 dir = vec2(cos(a), sin(a));
      int plus = -1, minus = -1;
      for (int i = 1; i <= reach; i++) {
        ivec2 q = p + ivec2(round(dir * float(i)));
        if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y || texelFetch(u_ids, q, 0).a != 4u) { plus = i; break; }
      }
      if (plus < 0) continue;
      for (int i = 1; i <= reach; i++) {
        ivec2 q = p - ivec2(round(dir * float(i)));
        if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y || texelFetch(u_ids, q, 0).a != 4u) { minus = i; break; }
      }
      if (minus < 0) continue;
      float w = float(plus + minus);
      if (w < best) { best = w; across = dir; off = float(plus - minus); }
    }
    // 只认宽度像一层膜的带子（28–62 Å）：两个穿膜蛋白之间的那段膜沿带子方向量也是窄的，但比膜厚宽得多
    // only a band as wide as one membrane counts (28–62 Å): the stretch of membrane between two proteins is narrow along the band too, but much wider than a membrane is thick
    if (best <= u_mid.y && best >= u_mid.y * 0.45 && abs(off) <= max(1.0, best * 0.1)) {
      float along = dot(vec2(p), vec2(-across.y, across.x));
      if (fract(along / u_mid.z) < 0.55) rgb = mix(rgb, deepen(rgb, 0.72), u_mid.x);
    }
  }
  vec3 ink = u_ink;
  if (u_inkTint.x > 0.0 && line > 0.0) {
    // 线的颜色取自它旁边的填色；线落在物体外面时，在一两个笔宽内找最近的有填色的像素
    // a line takes its colour from the fill beside it; where the line falls outside the object, the nearest filled pixel within a pen width or two is used
    vec3 fill = vec3(-1.0);
    if (d < 1.0) fill = texelFetch(u_color, p, 0).rgb;
    else {
      ivec2 size = textureSize(u_color, 0);
      for (int ring = 1; ring <= 3 && fill.r < 0.0; ring++) {
        for (int k = 0; k < 8; k++) {
          float a = float(k) * 0.7853982;
          ivec2 q = clamp(p + ivec2(round(vec2(cos(a), sin(a)) * float(ring) * u_inkTint.z)), ivec2(0), size - 1);
          if (texelFetch(u_depth, q, 0).r < 1.0) {
            fill = texelFetch(u_color, q, 0).rgb;
            break;
          }
        }
      }
    }
    if (fill.r >= 0.0) ink = mix(u_ink, deepen(fill, u_inkTint.y), u_inkTint.x);
  }
  rgb = mix(rgb, ink, line);
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
