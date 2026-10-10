# soma

三维人体解剖浏览器，面向医学生。world-sim 阶梯上的 L4：器官怎么合成一个活着的整体。

长期目标是外科训练用的模拟人：解剖结构在医学上可信，组织有物理性质，身体对疼痛有反应。现在完成的是第一步——把一个完整的人体拆成两千多个可以单独查看的部件，并标出它们之间的关系。

> 仅供教学使用，不是临床依据。几何来自公开数据集，源数据自身声明仍含错误；中文名称和功能关系都还没有经过医学专业人员审校。

## 现在能做什么

- 全身 2,299 个独立部件：骨、肌肉、血管段、器官、神经，按系统分组。
- 按系统显示或隐藏、调透明度；从皮肤到骨骼逐层剥离。
- 点选部件，查看中/英/拉丁名、FMA 编号、所属层级、相邻结构。
- 肌肉的起点、止点、神经支配、血供等关系，每条带出处，可点击跳转。
- 隔离、只看相邻结构、爆炸视图、任意轴向剖切。
- 两棵层级树（分类 is-a、结构 part-of）和按名称或编号搜索。

## 运行

需要 [Bun](https://bun.sh)。

```sh
bun install
bun run dev        # http://localhost:5183
```

仓库里已经带了生成好的解剖数据（`public/anatomy/`），克隆后可以直接看。地址参数：`?body=male`（默认）、`?renderer=webgl`（强制用 WebGL2 后端）。

## 测试

```sh
bunx vitest run    # 管线、知识层、图查询、显示规则
bunx tsc --noEmit
```

`tests/pipeline-output.test.ts` 检查的是生成数据的不变量：每个部件恰好出现在一个 GLB 里，邻接关系对称，包围盒落在人体尺寸内，左股骨在身体左侧，等等。

## 结构

```
src/anatomy/types.ts   数据契约：离线管线写，界面读
src/                   界面（React + three.js WebGPURenderer）
tools/pipeline/        几何管线：分类、分层、简化、邻接、配准，输出 GLB
tools/knowledge/       知识层：名称和功能关系，按 FMA 编号对齐
tools/zanatomy/        Z-Anatomy 的读取与评估
tools/register/        女性体型的数据清点
tools/fixture/         开发用的合成数据集
data/curated/          提交进仓库的精编数据
public/anatomy/        生成的运行时数据
```

几何和知识分开来源：形状和位置只取自体数据重建的网格，名称和关系取自本体库、百科和开放教科书。两边靠 FMA（Foundational Model of Anatomy）编号对上。

每个部件带来源标记：`scanned`（源数据原样）、`warped`（经配准变形得到）、`curated`（人工建模或按文献编修）。

## 重新生成数据

原始数据不在仓库里（`data/raw/` 被忽略），需要先下载。

```sh
# BodyParts3D 4.0：把 LATEST/ 下的表格和两个 zip 下载到 data/raw/bodyparts3d/ 并解压
#   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/
bun run pipeline                 # 生成 public/anatomy/male/
bun tools/knowledge/run.ts       # 从缓存生成名称和关系；加 --refresh 重新查询 Wikidata
```

## 数据来源与许可

代码之外，本目录下的解剖数据（`public/anatomy/`、`data/curated/`）整体以 **CC BY-SA 4.0** 发布。

| 来源 | 用在哪里 | 许可 |
|---|---|---|
| [BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html) 4.0 | 男性体型的几何（2,220 个部件）与两棵层级树 | CC BY 4.0（"BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"） |
| BodyParts3D 3.0 | 4.0 里没有的 79 个部件：肺叶、腹壁肌、背阔肌、咀嚼肌和表情肌。经配准变形到 4.0 的坐标里，标记为 `warped` | CC BY-SA 2.1 JP |
| [Wikidata](https://www.wikidata.org) | 名称、功能关系、编号对照 | CC0 |
| [Wikipedia](https://en.wikipedia.org) 肌肉信息框 | 部分肌肉的起止点和神经支配，每条带修订版链接 | CC BY-SA 4.0 |
| [Z-Anatomy](https://github.com/Z-Anatomy) | 周围神经、甲状腺、淋巴结、韧带（接入中） | CC BY-SA 4.0（"Z-Anatomy - The libre 3D atlas of anatomy"） |

名称数据里约六成中文名是按术语表机器生成的，没有出处，`names.json` 的 `zhSource` 字段逐条标明了来源，全部条目的状态都是 `unreviewed`。

## 已知的缺口

- 周围神经：BodyParts3D 只有颅神经和眶内神经，其余要靠 Z-Anatomy 补，后者是手工建模、未经验证。
- 两个版本的 BodyParts3D 都没有：甲状腺、腮腺、淋巴结、脊髓本体、胸膜、心包、膝关节韧带和半月板、乳腺。
- 从 3.0 配准过来的部件位置误差：头部约 1–2 mm，胸部约 4 mm，腹部约 6 mm。腹横肌与内脏有明显穿插。
- 只有成年男性一个体型；女性体型计划用真实的女性骨架和器官做锚点，把男性的精细结构配准过去。
- 没有皮下脂肪层、淋巴管。
- 触屏手势没有在真机上测过。

## 接下来

1. 补齐神经和缺失器官，建女性体型。
2. 软组织物理：四面体化，XPBD，先在一个部位验证。
3. 疼痛：沿神经通路的伤害感受模型，驱动生命体征、退缩反射和体表热力图。这是对疼痛生理的计算模型，模拟人并没有主观感受。
4. 手术操作：切开、牵拉、出血、缝合。
