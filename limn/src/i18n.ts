/**
 * 界面的两种语言。所有给人看的固定文字都在这里的两张表里，键相同；数据文件里成对的字段
 * （title / titleEn 等）用 `pick` 取。当前语言存在 store 里（`lang`），这里留一份镜像，
 * 所以本文件不依赖 store，也不依赖浏览器：解析器、测试和服务端的类型引用都能安全地导入它。
 *
 * The two languages of the interface. Every fixed string a person reads is in
 * the two tables here, under the same keys; paired fields in the data files
 * (title / titleEn and the like) are chosen with `pick`. The current language
 * lives in the store (`lang`) and is mirrored here, so this file depends on
 * neither the store nor the browser: parsers, tests and the server's type
 * imports can all load it safely.
 */
import type { Note, Tier } from './scene/spec'
import type { ColorMode } from './style/annotate'
import type { Role } from './style/palettes'

export type { Note }
export type Lang = 'zh' | 'en'
export type Params = Record<string, string | number>

const STORAGE_KEY = 'limn.lang'

export const zh = {
  'lang.switch': 'English',
  'punct.colon': '：',
  'punct.semicolon': '；',
  'punct.list': '、',
  'etAl': ' 等',
  'unit.atoms': '{n} 原子',

  // 侧栏 / the sidebar
  'tab.topic': '按主题',
  'tab.model': '现成模型',
  'tab.id': '按编号',
  'tab.recent': '最新发表',
  'topic.placeholder': '一个病毒、基因、蛋白或机理，例如：CRISPR-Cas9 切割 DNA',
  'topic.submit': '生成',
  'server.noClaude': '本机没有找到 claude 命令',
  'server.down': '本地服务未启动（bun run dev）',
  'catalog.cells': '整个细胞（电镜）',
  'catalog.neurons': '神经元的形态',
  'catalog.neuro': '神经系统的分子',
  'id.placeholder': '2hhb、AF-P04637 或 EMD-1080',
  'id.submit': '载入',

  // 最新发表 / recent releases
  'recent.days30': '近 30 天',
  'recent.days90': '近 90 天',
  'recent.year': '近一年',
  'recent.loading': '正在查询 RCSB…',
  'recent.count': '{total} 个结构；按发布日期排序。',
  'recent.countShown': '{total} 个结构，显示最新的 {shown} 个；按发布日期排序。',

  // 数据来源 / sources
  'section.sources': '数据来源',
  'paper.link': '论文',
  'paper.abstract': '摘要（开放获取，{licence}）',
  'source.licence': '许可：{licence}',
  'source.link': '来源',
  'source.neuromorpho': 'NeuroMorpho.Org，{archive} 档案',
  'tier.measured': '实测',
  'tier.curated': '整理的模型',
  'tier.predicted': '预测',
  'tier.estimated': '估计',
  'ingredient.line': '{abundance}（{basis}） → {copies} 个',
  'ingredient.linePlaced': '{abundance}（{basis}） → {copies} 个，放下了 {placed} 个',
  'ingredient.measured': '实测数据',
  'ingredient.estimated': '估计',
  'abundance.perArea': '约 {n} 个/μm²',
  'abundance.paxdb': 'PaxDb：{genes} {ppm} ppm，约 {uM} μM',
  'abundance.concentration': '约 {uM} μM',
  'abundance.paxdbComplex': 'PaxDb：{genes} {ppm} ppm；{complex} 里每种亚基 {per} 份（Complex Portal），约 {uM} μM',
  'abundance.supplied': '你提供的拷贝数表：{genes} {copies} 个，约 {uM} μM',
  'membrane.opm': '膜内取向：OPM（{matched} 个残基叠合，偏差 {rmsd} Å）',
  'membrane.pdbtm': '膜内取向：PDBTM，朝向按 UniProt 拓扑注释（{matched} 个残基）',
  'assembly.asym': '非对称单元',
  'assembly.n': '组装体 {id}',
  'method.alphafold': 'AlphaFold 预测',
  'method.emMap': '电镜密度图',
  'method.fibsem': '聚焦离子束扫描电镜 + 机器学习分割',
  'method.reconstruction': '显微重建',
  'entity.isosurface': '密度图的等值面',

  // 角色与上色 / roles and colouring
  'role.soluble': '可溶蛋白',
  'role.membrane': '膜与膜蛋白',
  'role.nucleic': '核酸',
  'role.nucleic-binding': '核酸结合蛋白',
  'role.focus': '焦点（病毒等）',
  'role.extracellular': '胞外分子',
  'role.ligand': '配体',
  'role.glycan': '糖链',
  'role.ion': '离子',
  'color.label': '上色',
  'colorMode.role': '按功能角色',
  'colorMode.confidence': '按预测置信度（pLDDT）',
  'colorMode.domains': '按结构域',
  'colorMode.sites': '标出活性与结合位点',
  'colorMode.pathogenicity': '按突变致病性预测（AlphaMissense）',
  'legend.confidence.veryHigh': '很高（≥90）',
  'legend.confidence.high': '较高（70–90）',
  'legend.confidence.low': '低（50–70）',
  'legend.confidence.about': 'pLDDT 是 AlphaFold 对每个残基位置的置信度；低于 50 的没有画。',
  'legend.confidence.none': '置信度只有预测模型才有；这是实验结构，颜色不变。',
  'legend.noAnnotation': '没有查到这个结构的注释（或本地服务没有启动），颜色不变。',
  'legend.uniprot': '（UniProt {accession}）',
  'legend.noDomains': ' 没有标注结构域',
  'legend.site.active': '活性位点',
  'legend.site.binding': '结合位点',
  'legend.site.other': '其他位点',
  'legend.noSites': '没有标注位点',
  'legend.sourceUniprot': '来源：UniProt。',
  'legend.path.benign': '多半无害',
  'legend.path.uncertain': '不确定',
  'legend.path.pathogenic': '多半致病',
  'legend.path.about': '每个位置上 19 种氨基酸替换的 AlphaMissense 预测值的平均。这是预测，不是临床结论。',
  'legend.path.missing': ' 有的蛋白没有这项数据（只覆盖人类蛋白），颜色不变。',

  // 画面说明 / about the picture
  'scene.realAtoms': '由真实原子坐标绘制；未画出水和氢原子。',
  'scene.sameScale': '各面板比例相同。',
  'landscape.repack': '重新随机排布',
  'landscape.size': '{w}×{h} nm，厚 {d} nm',
  'landscape.dna': '；DNA {pairs} 个碱基对（程序生成）',

  // 看图精修 / refining by review
  'refine.title': '看图精修',
  'refine.placeholder': '可选：你的要求，例如“让 DNA 更突出”“转到能看见结合界面的角度”',
  'refine.running': '精修中…',
  'refine.start': '让 Claude 看图并修改',
  'refine.back': '回到这一版',
  'refine.viewRound': '选角度',
  'refine.score': '{score} 分',
  'refine.comparing': '正在比较 12 个观察方向…',
  'refine.viewChosen': '选定观察方向：{reason}',
  'refine.finalScore': '正在给最后一版打分…',
  'refine.round': '第 {n} 轮：正在看图评审…',

  // 线条、导出、提示 / lines, export, hints
  'look.cut': '剖开',
  'style.title': '线条与阴影',
  'style.lineWidth': '线宽',
  'style.innerLines': '内部轮廓',
  'style.shadow': '阴影强度',
  'style.darkest': '最暗',
  'style.fog': '远处淡出',
  'export.title': '导出',
  'view.reset': '重置视角',
  'hint.landscape': '拖动平移 · 滚轮缩放',
  'hint.molecule': '拖动旋转 · 滚轮缩放 · Shift 拖动平移',
  'footer.credit': '画法致敬 David S. Goodsell；数据来源和许可见上方各条。',
  'stage.atoms': '{ids} · {n} 个原子 · {ms} ms',
  'stage.spheres': '{ids} · {n} 个球 · {ms} ms',
  'stage.empty': '输入一个主题或 PDB 编号开始',

  // 状态栏 / the status line
  'busy.resolving': '正在理解主题并检索结构数据库（约半分钟）…',
  'busy.downloading': '正在下载 {name}…',
  'busy.progress': '正在下载 {name}… {received} MB',
  'busy.progressOf': '正在下载 {name}… {received} / {total} MB',
  'busy.picks': '正在下载 {name} 的粒子位置…',
  'busy.emdbQuery': '正在查询 EMD-{n}…',
  'busy.mapName': '{id} 的密度图（共约 {mb} MB，压缩后更小）',
  'busy.isosurface': '正在从 {id} 的密度图取等值面…',
  'busy.fittedModel': '正在下载拟合的原子模型 {id}…',
  'busy.segmentation': '正在下载 {name}的分割数据… {done}/{total} 块',
  'busy.surface': '正在取 {name}的表面…',
  'busy.annotations': '正在查询结构域和位点注释…',

  // 错误 / errors
  'error.noServer': '连不上本地服务。用 bun run dev 同时启动网页和服务。',
  'error.serverHttp': '本地服务出错（HTTP {status}）',
  'error.badId': 'PDB 编号是 4 位，以数字开头，例如 2HHB；AlphaFold 预测模型写成 AF-加 UniProt 编号，例如 AF-P04637；电镜密度图写成 EMD-加数字，例如 EMD-1080',
  'error.noAlphafold': 'AlphaFold 数据库里没有 {id} 的预测模型（或本地服务没有启动）',
  'error.notInCatalog': '目录里没有 {id}',
  'error.picksFetch': '没能取到粒子位置（HTTP {status}）：{host}',
  'error.picksEmpty': '粒子位置文件里没有读到位置',
  'error.emdbMissing': '没有找到 EMD-{n}（或本地服务没有启动）',
  'error.emdbNoContour': 'EMD-{n} 没有给出等值面阈值，画不了',
  'error.emdbTooBig': 'EMD-{n} 的密度图有 {mb} MB，太大了',
  'error.emdbFetch': '没能取到 {id} 的密度图：它要从 ftp.ebi.ac.uk 现取，请检查网络后重试。',
  'error.emdbNoSurface': '{id} 在阈值 {contour} 处没有等值面',
  'error.cellFetch': '没能取到 {title} 的数据：它要从 OpenOrganelle（亚马逊云存储）现取，请检查网络后重试。',
  'error.neuronFetch': '没能取到 {title}：它要从 neuromorpho.org 现取，请检查网络后重试。',
  'error.cif.field': 'mmCIF 缺少字段 {field}',
  'error.assemblyOperator': '组装体 {id} 引用了不存在的对称算符 {op}',
  'error.parse': '无法解析 {id}: {message}',
  'error.noBlock': '{id} 里没有数据块',
  'error.noCoordinates': '{id} 没有原子坐标',
  'error.noAtomsLeft': '{id} 去掉水和氢之后没有原子',
  'error.fetchStructure': '没能取到 {id}：它要从外网的公共数据库现取（{host}），请检查网络后重试。',
  'error.lipid.parse': '{id} 的坐标文件无法解析',
  'error.lipid.empty': '{id} 没有原子',
  'error.lipid.fetch': '下载脂质 {id} 的坐标失败',
  'error.swc.empty': '{id} 里没有读到节点',
  'error.mrc.short': '密度图文件太短',
  'error.mrc.header': '密度图的文件头无法识别',
  'error.mrc.mode': '不支持的密度图数据类型（模式 {mode}）',
  'error.mrc.truncated': '密度图文件不完整',
  'error.n5.header': 'N5 分块的文件头无法识别',
  'error.n5.compression': '不支持的 N5 压缩方式：{type}',
  'error.n5.dataType': '不支持的 N5 数据类型：{type}',
  'error.n5.truncated': 'N5 分块的数据不完整',
  'error.n5.missing': '没有找到数据集 {base}（HTTP {status}）',
  'error.n5.dims': '只支持三维的 N5 数据集',
  'error.n5.tooBig': '这个尺度的数据太大，换一个更粗的尺度',
  'error.webgl2': '这个浏览器不支持 WebGL2',
  'error.shaderCompile': '着色器编译失败: {log}',
  'error.shaderLink': '着色器链接失败: {log}',
  'error.renderTarget': '无法创建 {w}×{h} 的渲染目标',
  'error.notColor': '不是颜色: {value}',

  // 没有组成数据的膜 / a membrane with no composition data
  'lipid.generic.name': '只有 POPC 的膜',
  'lipid.generic.basis': '没有这类膜的组成数据，用同一种磷脂（POPC）铺成。',

  // 说明：网页端写的 / notes written by the web app
  'note.alphafold': '这是 AlphaFold 预测模型，不是实验结构；置信度低于 50 的区域没有画（{percent}% 的残基置信度在 70 以上）。',
  'note.bfvd': '这是 BFVD 里的预测模型（ColabFold 预测的病毒蛋白），不是实验结构；AlphaFold 数据库没有收录这个蛋白。置信度低于 50 的区域没有画。',
  'note.complex': '这是 AlphaFold 数据库里的预测复合物，不是实验结构：两条链怎样结合是预测出来的，界面可信度 ipTM = {iptm}（1 为最高；低于 0.6 的没有列出）。',
  'method.bfvd': 'BFVD 预测',
  'method.complex': '预测复合物',
  'complexes.title': '含有它的预测复合物（AlphaFold 数据库）',
  'complexes.none': '没有界面可信的预测复合物',
  'neurons.search': '检索 NeuroMorpho.Org',
  'neurons.species': '物种，如 mouse',
  'neurons.region': '脑区，如 hippocampus',
  'neurons.cellType': '细胞类型，如 pyramidal',
  'neurons.go': '检索',
  'neurons.total': '共 {n} 个，显示前 {shown} 个。点名字单独画，点 + 并排加入（最多 4 个）。',
  'neurons.noHits': '没有找到（条件用英文，如 mouse、cerebellum、Purkinje）',
  'note.neuron.sideBySide': '这几个神经元是并排摆放、按同一比例画的，用来比较形状和大小；它们各自的坐标都以胞体为原点，彼此在脑里的相对位置不在数据里。',
  'note.neuron.found': '这是从显微图像描出来的神经元形态（{species}，{region}；{cellType}）：{domain}。坐标和粗细的单位是微米，不是原子图。',
  'note.picks': '{count} 个粒子的位置取自断层扫描的标注（实测）；每个粒子的朝向没有采用数据集里的值，是随机的：数据集的朝向参照的坐标系和这里用的原子模型对不上。',
  'note.coarse': '完整模型有 {millions} 百万个原子，超出了能流畅绘制的范围，这里每个残基只画一个球（脂质每个分子画三个球）。',
  'note.publishedModel': '这是别人已发表的整体模型：其中每个分子是真实结构，位置和数量由模型作者依据实验数据排布，不是直接观测到的。',
  'note.emdb.map': '这是电镜实验得到的三维密度图（{dims} 个体素，每个 {voxel} Å），画的是作者建议的阈值 {contour} 处的等值面。',
  'note.emdb.mapBinned': '这是电镜实验得到的三维密度图（{dims} 个体素，每个 {voxel} Å），画的是作者建议的阈值 {contour} 处的等值面；为了画得动，体素按 {binned} 倍合并过。',
  'note.spheresSurface': '表面是用一个个小球拼出来的（每个被等值面穿过的小格一个球），不是三角网格；阈值取得高一点或低一点，表面会瘦一点或胖一点。',
  'note.emdb.fitted': '里面是拟合进这张图的原子模型 {id}。密度图从正中剖开（“剖开”滑杆可调），原子模型不切，这样能看到模型怎样填在密度里。',
  'note.cell.scale': '这不是原子图，是电镜下一整个细胞的细胞器轮廓，长度单位是纳米。用的是原数据缩小 16 倍的版本：每个体素约 {voxel} nm，比它细的结构（细的内质网小管、小泡）看不出来或者断开。',
  'note.cell.segmentation': '细胞器的边界是机器学习模型逐个体素判断出来的，不是人工描的，局部会有错。表面是用一个个小球拼出来的。',
  'note.cell.envelope': '核膜在数据里算作内质网，紧贴着细胞核；贴着细胞核两个体素以内的内质网等没有画，免得和细胞核的表面叠在一起。',
  'note.cell.missing': '没能取到：{names}。',
  'note.neuron.about': '这是从显微图像描出来的神经元形态（{species}，{region}）：{has}。坐标和粗细的单位是微米，不是原子图。',
  'note.neuron.thin': '比线还细的分支画粗了一点，否则看不见；每一段按两端的半径线性过渡。重建本身的粗细常常不如走向可靠。',
  'note.lipids': '膜的脂质组成：{name}。{basis}每种脂质用数据库里的理想坐标，尾链已转到同一侧；位置随机，构象都相同。',
  'note.lipidsCited': '膜的脂质组成：{name}。{basis}出处：{citation}。每种脂质用数据库里的理想坐标，尾链已转到同一侧；位置随机，构象都相同。',
  'note.oriented': '{list} 在膜里的位置和倾角取自膜蛋白取向数据库（OPM；OPM 没有的用 PDBTM，并按 UniProt 的拓扑注释定哪面朝外）。这些取向是由实验结构计算得到的，不是直接测量。',
  'note.oriented.item': '{label}（{source}）',
  'note.aligned': '为便于比较，已按共同的蛋白链把 {list} 叠合到 {ref} 的朝向。',
  'note.aligned.item': '{id}（{matched} 个残基，偏差 {rmsd} Å）',

  // 说明：服务端写的（server/landscape.ts、server/resolve.ts）/ notes written by the server
  'note.land.random': '分子是真实结构，按比例绘制；它们的位置和朝向是程序随机排布的，不是观测结果。',
  'note.land.paxdb': '{measured} 种成分的丰度取自 PaxDb 的整合质谱数据（{dataset}），其余 {rest} 种是模型的估计值；每种成分各自标明。',
  'note.land.paxdbAll': '{measured} 种成分的丰度取自 PaxDb 的整合质谱数据（{dataset}），其余是模型的估计值；每种成分各自标明。',
  'note.land.estimated': '各成分之间的比例来自模型给出的丰度估计值，不是测量值。',
  'note.land.scaled.both': '真实的细胞里有上千种分子，这里只列出十来种作为代表：除标为主角的成分外，数量已按比例放大，使画出的总质量与该区室的大分子总浓度（膜上方约 {above} g/L，膜下方约 {below} g/L）相符。',
  'note.land.scaled.above': '真实的细胞里有上千种分子，这里只列出十来种作为代表：除标为主角的成分外，数量已按比例放大，使画出的总质量与该区室的大分子总浓度（膜上方约 {above} g/L）相符。',
  'note.land.scaled.below': '真实的细胞里有上千种分子，这里只列出十来种作为代表：除标为主角的成分外，数量已按比例放大，使画出的总质量与该区室的大分子总浓度（膜下方约 {below} g/L）相符。',
  'note.land.scaled.whole': '真实的细胞里有上千种分子，这里只列出十来种作为代表：除标为主角的成分外，数量已按比例放大，使画出的总质量与该区室的大分子总浓度（约 {below} g/L）相符。',
  'note.land.scaled.none': '真实的细胞里有上千种分子，这里只列出十来种作为代表：除标为主角的成分外，数量已按比例放大，使画出的总质量与该区室的大分子总浓度相符。',
  'note.land.membranePlacement': '膜蛋白按分子长轴竖立在膜上或膜中；只解析了膜外段的结构立在膜面上，连膜的一端由链的末端位置判断。这是近似摆放，未使用实验确定的取向和插入深度，膜外段与膜之间缺失的柄部和跨膜段没有画。脂质用同一种磷脂（POPC）的理想构象铺成。',
  'note.land.dna': 'DNA 是程序生成的双螺旋：碱基对的形状量自晶体结构 1BNA，走向是随机弯曲的曲线，序列随机，总长度按约 {mbp} 百万碱基对/μm³（估计）换算（这一片里约 {pairs} 个碱基对）。真实细胞里 DNA 上结合的蛋白和它的超螺旋没有画。',
  'note.land.omittedWithDna': '未画出水、离子、小分子，以及 RNA 长链和细胞骨架纤维。',
  'note.land.omitted': '未画出水、离子、小分子，以及核酸长链和纤维。',
  'note.land.notDrawn': '未能画出：{names}。',
  'note.land.tooFew': '按所给丰度，这么小的体积里不到一个，没有画：{names}。',
  'note.alphafoldPanel': '{id} 是 AlphaFold 预测模型，不是实验结构；低置信度的区域已省略。',
}

export type Key = keyof typeof zh

export const en: Record<Key, string> = {
  'lang.switch': '中文',
  'punct.colon': ': ',
  'punct.semicolon': '; ',
  'punct.list': ', ',
  'etAl': ' et al.',
  'unit.atoms': '{n} atoms',

  // 侧栏 / the sidebar
  'tab.topic': 'Topic',
  'tab.model': 'Models',
  'tab.id': 'By ID',
  'tab.recent': 'Recent',
  'topic.placeholder': 'A virus, gene, protein or mechanism, e.g. CRISPR-Cas9 cutting DNA',
  'topic.submit': 'Generate',
  'server.noClaude': 'The claude command was not found on this machine',
  'server.down': 'The local server is not running (bun run dev)',
  'catalog.cells': 'Whole cells (electron microscopy)',
  'catalog.neurons': 'Neuron morphology',
  'catalog.neuro': 'Molecules of the nervous system',
  'id.placeholder': '2hhb, AF-P04637 or EMD-1080',
  'id.submit': 'Load',

  // 最新发表 / recent releases
  'recent.days30': 'Last 30 days',
  'recent.days90': 'Last 90 days',
  'recent.year': 'Last year',
  'recent.loading': 'Searching RCSB…',
  'recent.count': '{total} structures, newest first.',
  'recent.countShown': '{total} structures; showing the {shown} newest.',

  // 数据来源 / sources
  'section.sources': 'Sources',
  'paper.link': 'Paper',
  'paper.abstract': 'Abstract (open access, {licence})',
  'source.licence': 'Licence: {licence}',
  'source.link': 'Source',
  'source.neuromorpho': 'NeuroMorpho.Org, {archive} archive',
  'tier.measured': 'Measured',
  'tier.curated': 'Curated model',
  'tier.predicted': 'Predicted',
  'tier.estimated': 'Estimated',
  'ingredient.line': '{abundance} ({basis}) → {copies} copies',
  'ingredient.linePlaced': '{abundance} ({basis}) → {copies} copies, {placed} placed',
  'ingredient.measured': 'measured',
  'ingredient.estimated': 'estimate',
  'abundance.perArea': 'about {n} per μm²',
  'abundance.paxdb': 'PaxDb: {genes} {ppm} ppm, about {uM} μM',
  'abundance.concentration': 'about {uM} μM',
  'abundance.paxdbComplex': 'PaxDb: {genes} {ppm} ppm; {per} copies of each subunit in {complex} (Complex Portal), about {uM} μM',
  'abundance.supplied': 'your copy-number table: {genes} {copies} copies, about {uM} μM',
  'membrane.opm': 'Orientation in the membrane: OPM ({matched} residues superposed, RMSD {rmsd} Å)',
  'membrane.pdbtm': 'Orientation in the membrane: PDBTM, with sidedness from UniProt topology ({matched} residues)',
  'assembly.asym': 'Asymmetric unit',
  'assembly.n': 'Assembly {id}',
  'method.alphafold': 'AlphaFold prediction',
  'method.emMap': 'EM density map',
  'method.fibsem': 'FIB-SEM with machine-learning segmentation',
  'method.reconstruction': 'Reconstruction from microscopy',
  'entity.isosurface': 'Isosurface of the density map',

  // 角色与上色 / roles and colouring
  'role.soluble': 'Soluble protein',
  'role.membrane': 'Membrane and membrane protein',
  'role.nucleic': 'Nucleic acid',
  'role.nucleic-binding': 'Nucleic-acid-binding protein',
  'role.focus': 'Focus (virus, subject)',
  'role.extracellular': 'Extracellular molecule',
  'role.ligand': 'Ligand',
  'role.glycan': 'Glycan',
  'role.ion': 'Ion',
  'color.label': 'Colour',
  'colorMode.role': 'By functional role',
  'colorMode.confidence': 'By prediction confidence (pLDDT)',
  'colorMode.domains': 'By domain',
  'colorMode.sites': 'Active and binding sites',
  'colorMode.pathogenicity': 'By predicted pathogenicity (AlphaMissense)',
  'legend.confidence.veryHigh': 'Very high (≥90)',
  'legend.confidence.high': 'High (70–90)',
  'legend.confidence.low': 'Low (50–70)',
  'legend.confidence.about': 'pLDDT is AlphaFold’s confidence in the position of each residue; residues below 50 are not drawn.',
  'legend.confidence.none': 'Only predicted models have a confidence score. This is an experimental structure, so the colours are unchanged.',
  'legend.noAnnotation': 'No annotation was found for this structure (or the local server is not running); the colours are unchanged.',
  'legend.uniprot': ' (UniProt {accession})',
  'legend.noDomains': ' no domains annotated',
  'legend.site.active': 'Active site',
  'legend.site.binding': 'Binding site',
  'legend.site.other': 'Other sites',
  'legend.noSites': 'no sites annotated',
  'legend.sourceUniprot': 'Source: UniProt.',
  'legend.path.benign': 'Likely benign',
  'legend.path.uncertain': 'Uncertain',
  'legend.path.pathogenic': 'Likely pathogenic',
  'legend.path.about': 'The mean AlphaMissense score over the 19 possible amino-acid substitutions at each position. These are predictions, not clinical findings.',
  'legend.path.missing': ' Some proteins have no such data (only human proteins are covered); their colours are unchanged.',

  // 画面说明 / about the picture
  'scene.realAtoms': 'Drawn from real atomic coordinates; water and hydrogen atoms are not shown.',
  'scene.sameScale': ' All panels are at the same scale.',
  'landscape.repack': 'Reshuffle',
  'landscape.size': '{w}×{h} nm, {d} nm deep',
  'landscape.dna': '; DNA: {pairs} base pairs (generated)',

  // 看图精修 / refining by review
  'refine.title': 'Review and refine',
  'refine.placeholder': 'Optional: what you would like, e.g. “make the DNA stand out” or “turn it to show the binding interface”',
  'refine.running': 'Refining…',
  'refine.start': 'Have Claude review and revise',
  'refine.back': 'Return to this version',
  'refine.viewRound': 'View',
  'refine.score': '{score} / 10',
  'refine.comparing': 'Comparing 12 viewing directions…',
  'refine.viewChosen': 'View chosen: {reason}',
  'refine.finalScore': 'Scoring the final version…',
  'refine.round': 'Round {n}: reviewing the picture…',

  // 线条、导出、提示 / lines, export, hints
  'look.cut': 'Cut',
  'style.title': 'Lines and shadows',
  'style.lineWidth': 'Line width',
  'style.innerLines': 'Inner lines',
  'style.shadow': 'Shadow strength',
  'style.darkest': 'Darkest shadow',
  'style.fog': 'Depth fade',
  'export.title': 'Export',
  'view.reset': 'Reset view',
  'hint.landscape': 'Drag to pan · scroll to zoom',
  'hint.molecule': 'Drag to rotate · scroll to zoom · Shift-drag to pan',
  'footer.credit': 'Drawn in homage to David S. Goodsell. Sources and licences are listed with each item above.',
  'stage.atoms': '{ids} · {n} atoms · {ms} ms',
  'stage.spheres': '{ids} · {n} spheres · {ms} ms',
  'stage.empty': 'Enter a topic or a PDB ID to begin',

  // 状态栏 / the status line
  'busy.resolving': 'Reading the topic and searching the structure databases (about half a minute)…',
  'busy.downloading': 'Downloading {name}…',
  'busy.progress': 'Downloading {name}… {received} MB',
  'busy.progressOf': 'Downloading {name}… {received} / {total} MB',
  'busy.picks': 'Downloading particle positions for {name}…',
  'busy.emdbQuery': 'Looking up EMD-{n}…',
  'busy.mapName': 'the {id} density map (about {mb} MB, less when compressed)',
  'busy.isosurface': 'Extracting the isosurface of the {id} density map…',
  'busy.fittedModel': 'Downloading the fitted atomic model {id}…',
  'busy.segmentation': 'Downloading the segmentation of the {name}… {done}/{total} blocks',
  'busy.surface': 'Extracting the surface of the {name}…',
  'busy.annotations': 'Fetching domain and site annotations…',

  // 错误 / errors
  'error.noServer': 'Cannot reach the local server. Run bun run dev to start the web app and the server together.',
  'error.serverHttp': 'The local server returned an error (HTTP {status})',
  'error.badId': 'A PDB ID is 4 characters starting with a digit, e.g. 2HHB. For an AlphaFold model write AF- and the UniProt accession, e.g. AF-P04637; for an EM density map write EMD- and its number, e.g. EMD-1080.',
  'error.noAlphafold': 'The AlphaFold database has no model for {id} (or the local server is not running)',
  'error.notInCatalog': '{id} is not in the catalogue',
  'error.picksFetch': 'Could not fetch the particle positions (HTTP {status}): {host}',
  'error.picksEmpty': 'No positions were found in the particle file',
  'error.emdbMissing': 'EMD-{n} was not found (or the local server is not running)',
  'error.emdbNoContour': 'EMD-{n} gives no contour level, so it cannot be drawn',
  'error.emdbTooBig': 'The EMD-{n} density map is {mb} MB, which is too large',
  'error.emdbFetch': 'Could not fetch the {id} density map. It is downloaded from ftp.ebi.ac.uk; check your connection and try again.',
  'error.emdbNoSurface': '{id} has no isosurface at contour level {contour}',
  'error.cellFetch': 'Could not fetch the data for “{title}”. It is downloaded from OpenOrganelle (Amazon S3); check your connection and try again.',
  'error.neuronFetch': 'Could not fetch “{title}”. It is downloaded from neuromorpho.org; check your connection and try again.',
  'error.cif.field': 'mmCIF field {field} is missing',
  'error.assemblyOperator': 'Assembly {id} refers to a symmetry operator that does not exist: {op}',
  'error.parse': 'Cannot parse {id}: {message}',
  'error.noBlock': '{id} contains no data block',
  'error.noCoordinates': '{id} has no atomic coordinates',
  'error.noAtomsLeft': '{id} has no atoms left once water and hydrogen are removed',
  'error.fetchStructure': 'Could not fetch {id}. It is downloaded from a public database ({host}); check your connection and try again.',
  'error.lipid.parse': 'The coordinate file for {id} cannot be parsed',
  'error.lipid.empty': '{id} has no atoms',
  'error.lipid.fetch': 'Could not download the coordinates of lipid {id}',
  'error.swc.empty': 'No nodes were found in {id}',
  'error.mrc.short': 'The density map file is too short',
  'error.mrc.header': 'The density map header is not recognised',
  'error.mrc.mode': 'Unsupported density map data type (mode {mode})',
  'error.mrc.truncated': 'The density map file is incomplete',
  'error.n5.header': 'The N5 block header is not recognised',
  'error.n5.compression': 'Unsupported N5 compression: {type}',
  'error.n5.dataType': 'Unsupported N5 data type: {type}',
  'error.n5.truncated': 'The N5 block is incomplete',
  'error.n5.missing': 'Dataset {base} was not found (HTTP {status})',
  'error.n5.dims': 'Only three-dimensional N5 datasets are supported',
  'error.n5.tooBig': 'The data at this scale is too large; use a coarser scale',
  'error.webgl2': 'This browser does not support WebGL2',
  'error.shaderCompile': 'Shader failed to compile: {log}',
  'error.shaderLink': 'Shader failed to link: {log}',
  'error.renderTarget': 'Cannot create a {w}×{h} render target',
  'error.notColor': 'Not a colour: {value}',

  // 没有组成数据的膜 / a membrane with no composition data
  'lipid.generic.name': 'A membrane of POPC alone',
  'lipid.generic.basis': 'There is no composition data for this kind of membrane, so it is built from a single phospholipid (POPC).',

  // 说明：网页端写的 / notes written by the web app
  'note.alphafold': 'This is an AlphaFold prediction, not an experimental structure. Regions with confidence below 50 are not drawn ({percent}% of residues score above 70).',
  'note.bfvd': 'This is a predicted model from BFVD (viral proteins predicted with ColabFold), not an experimental structure; the AlphaFold DB does not hold this protein. Regions with confidence below 50 are not drawn.',
  'note.complex': 'This is a predicted complex from the AlphaFold DB, not an experimental structure: how the chains bind is a prediction, with interface confidence ipTM = {iptm} (1 is best; those below 0.6 are not listed).',
  'method.bfvd': 'BFVD prediction',
  'method.complex': 'Predicted complex',
  'complexes.title': 'Predicted complexes containing it (AlphaFold DB)',
  'complexes.none': 'No predicted complex with a reliable interface',
  'neurons.search': 'Search NeuroMorpho.Org',
  'neurons.species': 'Species, e.g. mouse',
  'neurons.region': 'Region, e.g. hippocampus',
  'neurons.cellType': 'Cell type, e.g. pyramidal',
  'neurons.go': 'Search',
  'neurons.total': '{n} found, first {shown} shown. Click a name to draw it alone, + to add it alongside (up to 4).',
  'neurons.noHits': 'Nothing found (use English terms such as mouse, cerebellum, Purkinje)',
  'note.neuron.sideBySide': 'These neurons are set side by side at one scale, to compare shape and size; each has its soma at its own origin, and where they lie relative to one another in the brain is not in the data.',
  'note.neuron.found': 'This is a neuron traced from microscope images ({species}, {region}; {cellType}): {domain}. Coordinates and thicknesses are in microns; this is not an atomic picture.',
  'note.picks': 'The positions of the {count} particles come from annotations of the tomogram (measured). Their orientations are random rather than the dataset’s own: those refer to a coordinate frame that does not match the atomic model used here.',
  'note.coarse': 'The full model has {millions} million atoms, more than can be drawn smoothly, so each residue is drawn as a single sphere (and each lipid as three).',
  'note.publishedModel': 'This is a published whole model. Each molecule in it is a real structure, but positions and copy numbers were arranged by the model’s authors from experimental data, not observed directly.',
  'note.emdb.map': 'This is a three-dimensional density map from electron microscopy ({dims} voxels of {voxel} Å each), drawn as the isosurface at the authors’ recommended contour level, {contour}.',
  'note.emdb.mapBinned': 'This is a three-dimensional density map from electron microscopy ({dims} voxels of {voxel} Å each), drawn as the isosurface at the authors’ recommended contour level, {contour}. Voxels were binned {binned}-fold to keep it drawable.',
  'note.spheresSurface': 'The surface is built from small spheres (one for each grid cell the isosurface passes through), not a triangle mesh. A slightly higher or lower contour level would make it thinner or fatter.',
  'note.emdb.fitted': 'Inside is {id}, the atomic model fitted into this map. The map is cut through the middle (adjust with the Cut slider) and the model is left whole, to show how it fills the density.',
  'note.cell.scale': 'This is not an atomic picture: it shows the outlines of the organelles of a whole cell under the electron microscope, and lengths are in nanometres. The data is used at one sixteenth of its full resolution, about {voxel} nm per voxel, so finer structures (thin ER tubules, small vesicles) are lost or appear broken.',
  'note.cell.segmentation': 'Organelle boundaries were decided voxel by voxel by a machine-learning model, not traced by hand, and are wrong in places. The surfaces are built from small spheres.',
  'note.cell.envelope': 'The data counts the nuclear envelope as endoplasmic reticulum, lying right against the nucleus. ER and other organelles within two voxels of the nucleus are not drawn, so that they do not coincide with its surface.',
  'note.cell.missing': 'Could not be fetched: {names}.',
  'note.neuron.about': 'This is the shape of a neuron traced from microscope images ({species}, {region}): {has}. Coordinates and thicknesses are in microns; this is not an atomic picture.',
  'note.neuron.thin': 'Branches thinner than a line are drawn a little thicker so that they can be seen; each segment tapers linearly between the radii at its two ends. In a reconstruction, thickness is often less reliable than the path.',
  'note.lipids': 'Membrane lipids: {name}. {basis} Each lipid uses its ideal coordinates from the database, with both tails turned to the same side; positions are random and every copy has the same conformation.',
  'note.lipidsCited': 'Membrane lipids: {name}. {basis} Source: {citation}. Each lipid uses its ideal coordinates from the database, with both tails turned to the same side; positions are random and every copy has the same conformation.',
  'note.oriented': 'Position and tilt in the membrane come from databases of membrane-protein orientation (OPM, or PDBTM where OPM has no entry, with sidedness from UniProt topology annotation) for: {list}. These orientations are computed from the experimental structures, not measured directly.',
  'note.oriented.item': '{label} ({source})',
  'note.aligned': 'For ease of comparison, the following are superposed on {ref} by the protein chain they share: {list}.',
  'note.aligned.item': '{id} ({matched} residues, RMSD {rmsd} Å)',

  // 说明：服务端写的（server/landscape.ts、server/resolve.ts）/ notes written by the server
  'note.land.random': 'The molecules are real structures drawn to scale. Their positions and orientations were arranged at random by the program, not observed.',
  'note.land.paxdb': 'The abundances of {measured} ingredients come from PaxDb’s integrated mass-spectrometry data ({dataset}); the other {rest} are the model’s estimates. Each ingredient says which it is.',
  'note.land.paxdbAll': 'The abundances of {measured} ingredients come from PaxDb’s integrated mass-spectrometry data ({dataset}); any others are the model’s estimates. Each ingredient says which it is.',
  'note.land.estimated': 'The proportions between ingredients come from the model’s abundance estimates, not from measurements.',
  'note.land.scaled.both': 'A real cell holds thousands of kinds of molecule; the dozen or so listed here stand for all of them. Except for those marked as the subject, copy numbers have been scaled up so that the total mass drawn matches the overall macromolecule concentration of each compartment (about {above} g/L above the membrane, about {below} g/L below it).',
  'note.land.scaled.above': 'A real cell holds thousands of kinds of molecule; the dozen or so listed here stand for all of them. Except for those marked as the subject, copy numbers have been scaled up so that the total mass drawn matches the overall macromolecule concentration of the compartment (about {above} g/L above the membrane).',
  'note.land.scaled.below': 'A real cell holds thousands of kinds of molecule; the dozen or so listed here stand for all of them. Except for those marked as the subject, copy numbers have been scaled up so that the total mass drawn matches the overall macromolecule concentration of the compartment (about {below} g/L below the membrane).',
  'note.land.scaled.whole': 'A real cell holds thousands of kinds of molecule; the dozen or so listed here stand for all of them. Except for those marked as the subject, copy numbers have been scaled up so that the total mass drawn matches the overall macromolecule concentration of the compartment (about {below} g/L).',
  'note.land.scaled.none': 'A real cell holds thousands of kinds of molecule; the dozen or so listed here stand for all of them. Except for those marked as the subject, copy numbers have been scaled up so that the total mass drawn matches the overall macromolecule concentration of the compartment.',
  'note.land.membranePlacement': 'Membrane proteins stand in or on the membrane along their long axis. Structures that cover only the part outside the membrane stand on its surface, and the end attached to the membrane is inferred from where the chain ends. The placement is approximate: no experimentally determined orientation or insertion depth is used, and the missing stalk and transmembrane segments between the outer part and the membrane are not drawn. The lipids are a single phospholipid (POPC) in its ideal conformation.',
  'note.land.dna': 'The DNA is a generated double helix: the base-pair geometry is measured from the crystal structure 1BNA, the path is a randomly bending curve, the sequence is random, and the total length follows from an estimated {mbp} million base pairs per μm³ (about {pairs} base pairs in this slab). The proteins bound to DNA in a real cell, and its supercoiling, are not drawn.',
  'note.land.omittedWithDna': 'Not drawn: water, ions, small molecules, long RNA and cytoskeletal filaments.',
  'note.land.omitted': 'Not drawn: water, ions, small molecules, long nucleic acids and filaments.',
  'note.land.notDrawn': 'Could not be drawn: {names}.',
  'note.land.tooFew': 'Not drawn, because the stated abundance gives less than one copy in so small a volume: {names}.',
  'note.alphafoldPanel': '{id} is an AlphaFold prediction, not an experimental structure; low-confidence regions are omitted.',
}

const TABLES: Record<Lang, Record<string, string>> = { zh, en }

/**
 * 起始语言：网址里的 ?lang= 优先，其次是上次的选择，最后看浏览器的语言。
 * The starting language: ?lang= in the address wins, then the last choice, then the browser's language.
 */
export function initialLang(): Lang {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('lang') : null
    if (q === 'zh' || q === 'en') return q
  } catch {
    // 没有地址栏 / no address bar
  }
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    // 存储不可用（隐私模式等）/ storage unavailable (private mode and the like)
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : ''
  return /^zh/i.test(nav ?? '') ? 'zh' : 'en'
}

let current: Lang = initialLang()

/** 当前语言（store 里 `lang` 的镜像）/ the current language (a mirror of `lang` in the store) */
export const getLang = (): Lang => current

/**
 * 让 `t` 跟上 store 的语言；只由 store 调用，界面要换语言请用 store 的 `setLang`。
 * Bring `t` in step with the store's language; called by the store only. To change the language of the interface, use the store's `setLang`.
 */
export function syncLang(lang: Lang): void {
  current = lang
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
}

/** 记住这次的选择 / remember the choice */
export function saveLang(lang: Lang): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // 存不了就算了 / if it cannot be stored, so be it
  }
}

/**
 * 把 {name} 换成参数。英文下，如果参数里另有 `nameEn`，就用它：数据里成对的字段
 * （name / nameEn）可以这样一起带进一条说明。
 * Fill {name} placeholders from the parameters. In English, a parameter `nameEn` is used when
 * it is there, so that a paired data field (name / nameEn) can travel inside one note.
 */
function fill(text: string, lang: Lang, params?: Params): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = lang === 'en' && params[name + 'En'] !== undefined && params[name + 'En'] !== '' ? params[name + 'En'] : params[name]
    return v === undefined ? whole : String(v)
  })
}

/** 用指定的语言取一条文字 / a string in a given language */
export function tIn(lang: Lang, key: Key, params?: Params): string {
  return fill(TABLES[lang][key] ?? TABLES.zh[key] ?? key, lang, params)
}

/** 用当前语言取一条文字 / a string in the current language */
export function t(key: Key, params?: Params): string {
  return tIn(current, key, params)
}

/**
 * 成对的字段取当前语言的那个；它是空的就用另一个。
 * Of a pair of fields, the one in the current language; when that is empty, the other.
 */
export function pick(zhText: string | undefined | null, enText: string | undefined | null): string {
  return (current === 'zh' ? zhText || enText : enText || zhText) ?? ''
}

/**
 * 一条说明的文字：模型写的是原样的字符串，代码写的按键查表。
 * The text of a note: a model-written one is a plain string, a code-written one is looked up by its key.
 */
export function noteText(n: Note): string {
  if (typeof n === 'string') return n
  return fill(TABLES[current][n.key] ?? TABLES.zh[n.key] ?? n.key, current, n.params)
}

/** 一条说明的键；模型写的没有键 / a note's key; a model-written note has none */
export const noteKey = (n: Note): string => (typeof n === 'string' ? '' : n.key)

/** 两种语言各拼一份列表，作为说明的参数（`name` 和 `nameEn`）/ a list joined once per language, as a note's parameters (`name` and `nameEn`) */
export function listParams(name: string, item: (lang: Lang) => string[]): Params {
  return { [name]: item('zh').join(zh['punct.list']), [name + 'En']: item('en').join(en['punct.list']) }
}

export const roleLabel = (role: Role): string => t(`role.${role}`)
export const colorModeLabel = (mode: ColorMode): string => t(`colorMode.${mode}`)
export const tierLabel = (tier: Tier): string => t(`tier.${tier}`)

/**
 * 一条“键加参数”的消息，留到显示时才按当时的语言写出，所以切换语言后会跟着变。
 * A message as a key with parameters, worded only when shown, in the language of that moment, so it follows a switch of language.
 */
export const say = (key: string, params?: Params): Note => ({ key, ...(params ? { params } : {}) })

/** 带着消息键的错误：既有当时语言的文字，也能之后重译 / an error that carries its message key: worded in the language of the moment, and re-wordable later */
export function noteError(key: keyof typeof zh, params?: Params): Error & { note: Note } {
  return Object.assign(new Error(t(key, params)), { note: say(key, params) })
}

/** 从捕获到的异常里取出可以显示的消息 / the displayable message of a caught exception */
export function errorNote(e: unknown): Note {
  const note = (e as { note?: Note } | null)?.note
  return note ?? (e instanceof Error ? e.message : String(e))
}

/**
 * 显示一条消息。服务端的报错是“中文 / English”合在一行的，这里只留当前语言的那一半。
 * Show a message. Errors from the server come as "Chinese / English" on one line; only the half in the current language is kept.
 */
export function shown(n: Note | ''): string {
  if (n === '') return ''
  if (typeof n !== 'string') return noteText(n)
  const i = n.indexOf(' / ')
  if (i < 0) return n
  const a = n.slice(0, i), b = n.slice(i + 3)
  const cjk = (x: string) => /[\u4e00-\u9fff]/.test(x)
  return cjk(a) && !cjk(b) ? (current === 'zh' ? a : b) : n
}
