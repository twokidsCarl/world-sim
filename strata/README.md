# strata

从微观规则到涌现。只模拟最底层的规则，所有更高层级的描述都从微观数据实时算出，并把已知理论叠在实测曲线上，让"More is Different"（Anderson 1972）可以被检验，而不只是被观看。

## 模拟什么

两个底座，在界面右上角切换：

- **分子动力学**：牛顿定律加一条可编辑的两体势（Mie n–m、Morse、纯排斥），二维周期盒。由粒子数据算出：
  - 微观：能量与动量守恒仪表。
  - 动理：速率分布对麦克斯韦–玻尔兹曼分布，径向分布函数 g(r) 对低密度极限。
  - 热力学：温度、压强对第二维里系数的预言。
- **Ising 自旋**：近邻与次近邻耦合加外场，四子格 Metropolis 更新。由自旋数据算出：
  - 热力学：磁化强度与能量对 Onsager–Yang 精确解。
  - 元：块自旋多数表决的重整化金字塔，以及磁化强度和近邻关联随尺度的流向。

每个可调参数都带标签，说明它是改变普适类、仅改变数值、状态变量还是数值方法。

## 运行

需要 [Bun](https://bun.sh)。WebGPU 可用时自动使用 GPU 后端（Chrome 113 以上），否则退回 CPU 参考实现。

```sh
bun install
bun run dev        # http://localhost:5184
```

## 测试

```sh
bun run test       # CPU 参考实现的解析与统计测试
bun run typecheck
```

GPU 内核没有独立的单元测试，而是逐个对照 f64 的 CPU 参考实现。启动开发服务器后打开 `http://localhost:5184/?harness`，结果同时写入 `window.__strataHarness`。

## 结构

```
src/core/         底座、派生量、调度器的接口；计数器式随机数
src/substrates/   md/ 与 ising/：参数表、CPU 参考实现（ref）、WGSL 内核、后端
src/levels/       每个底座的层级阶梯：派生量及其理论对照
src/theory/       麦克斯韦分布、维里系数、Onsager 精确解
src/render/       WebGPU 粒子与晶格渲染
src/plot/         Canvas2D 绘图
src/harness/      GPU 与 CPU 交叉校验
tests/            analytic/（解析）与 slow/（统计）
```

CPU 参考实现先写，是规范；WGSL 内核是它的优化，并用同一份势表、同一个整数哈希。

## 已知边界

- 分子动力学目前只有二维、单一粒子种类。
- 压强的理论线只展开到第二维里系数，仅在低密度有效；稠密时与实测不符是预期的。
- 临界点附近 Metropolis 更新平衡极慢，大晶格可能长时间达不到平衡。
- GPU 后端用 f32：能量仪表有约 1e-4 ε 每粒子的噪声底。

## 数据来源

没有外部数据。理论对照来自公开文献：Onsager (1944)、Yang (1952)、Kadanoff (1966)、Verlet (1967)、Irving & Kirkwood (1950)。
