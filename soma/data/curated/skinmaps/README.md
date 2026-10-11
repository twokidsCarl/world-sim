# 皮肤分区图的定义文件

本目录是皮节图和皮神经分布区图的全部“可审校内容”。改这里的 JSON 后运行
`bun tools/skinmaps/run.ts male`（或 `female`）即可重建，无需改代码。

**这些是为教学而构建的示意图。** 皮节因人而异，各家发表的图谱互有出入，相邻区域实际相互重叠；
全部内容均未经临床医师审校（`status: unreviewed`）。

| 文件 | 内容 |
|---|---|
| `landmarks.json` | 体表标志和肢体坐标架，由模型的具名骨骼计算 |
| `dermatomes.json` | 皮节图：方案说明、出处、屏障（轴线）、各皮节的种子和关键感觉点、独立检查点 |
| `cutaneous.json` | 皮神经分布区图：各区的神经部件、种子、节段来源及出处、分布描述及出处 |
| `innervation.<body>.json` | 由程序生成的对照表（皮节 → 神经根/神经节部件；分布区 → 神经部件 → 上级神经链 → 节段），供日后的疼痛模型使用 |

## 语法

`{side}` 在左侧代入 `left`、右侧代入 `right`。方向词：`lat`（该侧自身的外侧）、`med`、`sup`、`inf`、
`ant`、`post`，可用 `+` 组合并加权，如 `post+0.7*inf`。偏移量为 `[外侧, 上, 前]`，单位米。

三维点（PointExpr）：

- `"名称"`：引用 `landmarks.json` 中的点
- `{ "part": 部件名, "pick": "centroid" }`：部件顶点的平均位置（缺省）
- `{ "part": …, "pick": { "extreme": 方向, "within": { "axis": 方向, "frac": [a, b] }, "half": true } }`：
  沿某方向最远的顶点；`within` 先把部件限制在沿 `axis` 的一段（0 为该方向最远端）；`half` 只取本侧一半（用于正中的骨）
- `{ "part": …, "pick": { "slice": { "axis": 方向, "frac": [a, b] } } }`：该段顶点的平均位置
- `{ "lerp": [A, B, t] }`、`{ "xyz": [A, B, C] }`（x 取自 A，y 取自 B，z 取自 C）、`{ "offset": [A, [外, 上, 前]] }`
- `{ "shift": [A, from, to] }`：把 A 平移 (to − from)，用于把一处量得的位移照搬到另一处
- `{ "frame": 坐标架, "t": t }`：坐标架轴线上的点（0 起点，1 终点）
- `{ "nervePoint": 神经部件名, "x": A, "back": true }`：神经中心线与过 A 的矢状面的交点

皮肤上的点（SkinExpr）：

- `{ "at": 点, "to": "nearest" }`：该点位于其下方的最近皮肤顶点；`"nearestAny"` 不要求在其下方
- `{ "at": 点, "to": 方向 }`：自该点沿方向发出射线，取与皮肤外壁的第一个交点
- `{ "frame": 坐标架, "t": t, "deg": 角度 }`：自肢体轴线向外的射线；0° 前（屈侧；手为掌侧、足为足背），
  90° 外侧，180° 后，270° 内侧。`{ "at": 点, "frame": …, "deg": … }` 以给定点为起点
- `{ "nerveCross": 神经部件名, "x": A }`：神经的体表投影与过 A 的矢状面在躯干前面的交点
- `{ "dimple": { "between": [A, B] } }`：前正中线上 A、B 之间最深的凹点（脐）

种子（每个分区的 `seeds`）：

- `{ "curve": [SkinExpr 或 { "nerve": 名称, "project": "trunkRadial", "clip": … }, …] }`：依次相连的曲线
- `{ "nerve": [名称…], "maxDepthMm": 15, "where": { "frame": …, "t": [a, b] } }`：神经中心线距皮肤不超过给定深度的部分
- 可选：`"pin": true`（关键点，保持标签）、`"widthMm"`（带宽度的种子）、`"offsetMm"`（让先/让后）
- 神经种子可加 `"facing": { "frame": …, "deg": … }`：只取投影到朝向该方向的皮肤上的点（如手的 180 = 手背）

`dermatomes.json` 的 `checks`（独立检查点）中，`at` 可以是皮肤上的一点，也可以是 `{ "over": 部件名 }`：
取该部件正前方皮肤中面积最大的皮节。`landmarks.json` 的 `notes` 说明个别标志的取法。

`barriers` 是标签扩散不能越过的曲线（肢体的腹侧、背侧轴线）。

---

# Definition files of the skin maps

This directory holds everything a reviewer may want to correct in the dermatome map and the
cutaneous nerve territory map. Edit the JSON, run `bun tools/skinmaps/run.ts male` (or `female`),
and the maps are rebuilt; no code change is needed.

**These are constructed teaching maps.** Dermatomes vary between people, published maps disagree,
and neighbouring areas really overlap; nothing here has been reviewed by a clinician
(`status: unreviewed`).

| File | Content |
|---|---|
| `landmarks.json` | Surface landmarks and limb frames, computed from the model's named bones |
| `dermatomes.json` | Dermatome map: scheme, sources, barriers (axial lines), seeds and key sensory point of every dermatome, independent checkpoints |
| `cutaneous.json` | Cutaneous nerve territories: nerve parts, seeds, root values with source, territory description with source |
| `innervation.<body>.json` | Generated lookup tables (dermatome → root / ganglion parts; territory → nerve parts → parent chain → segments) for the later pain model |

## Grammar

`{side}` becomes `left` or `right`. Directions: `lat` (each side's own lateral), `med`, `sup`,
`inf`, `ant`, `post`, combined and weighted with `+`, e.g. `post+0.7*inf`. Offsets are
`[lateral, superior, anterior]` in metres.

3D points (PointExpr):

- `"name"`: a point of `landmarks.json`
- `{ "part": name, "pick": "centroid" }`: mean position of the part's vertices (default)
- `{ "part": …, "pick": { "extreme": dir, "within": { "axis": dir, "frac": [a, b] }, "half": true } }`:
  the vertex furthest along a direction; `within` first restricts the part to a stretch along
  `axis` (0 = far end in that direction); `half` keeps this side's half only (midline bones)
- `{ "part": …, "pick": { "slice": { "axis": dir, "frac": [a, b] } } }`: mean position of that stretch
- `{ "lerp": [A, B, t] }`, `{ "xyz": [A, B, C] }` (x from A, y from B, z from C), `{ "offset": [A, [lat, sup, ant]] }`
- `{ "shift": [A, from, to] }`: A moved by (to − from), to carry a displacement measured in one place over to another
- `{ "frame": frame, "t": t }`: point on a frame's axis (0 origin, 1 end)
- `{ "nervePoint": nerve part, "x": A, "back": true }`: where a nerve's centreline crosses the sagittal plane through A

Points on the skin (SkinExpr):

- `{ "at": point, "to": "nearest" }`: nearest skin vertex that the point lies under; `"nearestAny"` drops that condition
- `{ "at": point, "to": dir }`: first hit on the outer skin of a ray from the point
- `{ "frame": frame, "t": t, "deg": angle }`: ray outwards from a limb's axis; 0° anterior (flexor
  side; palmar on the hand, dorsal on the foot), 90° lateral, 180° posterior, 270° medial.
  `{ "at": point, "frame": …, "deg": … }` starts from a given point
- `{ "nerveCross": nerve part, "x": A }`: where a nerve's skin projection crosses the sagittal plane through A on the front of the trunk
- `{ "dimple": { "between": [A, B] } }`: deepest dimple of the anterior midline between A and B (umbilicus)

Seeds (`seeds` of every region):

- `{ "curve": [SkinExpr or { "nerve": name, "project": "trunkRadial", "clip": … }, …] }`: a curve through the items in order
- `{ "nerve": [names…], "maxDepthMm": 15, "where": { "frame": …, "t": [a, b] } }`: the part of the nerves' centrelines within the given depth of the skin
- optional: `"pin": true` (key point, keeps its label), `"widthMm"` (seed with width), `"offsetMm"` (head start / handicap)
- a nerve seed may carry `"facing": { "frame": …, "deg": … }`: only points that project onto skin facing that direction (e.g. 180 on the hand = dorsal)

In the `checks` of `dermatomes.json` (independent checkpoints) `at` is a point on the skin or
`{ "over": part name }`: the dermatome with the largest share of the skin in front of that part.
`notes` in `landmarks.json` explains how particular landmarks are taken.

`barriers` are curves that labels cannot spread across (the ventral and dorsal axial lines of the limbs).
