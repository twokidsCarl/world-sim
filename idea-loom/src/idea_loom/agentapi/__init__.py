"""给外来的 AI Agent 用的那一层：一份说明，三个出口（文档、/api/v1、MCP）。

每个子项目在 sim.json 的 `agent` 一节里说清楚它有哪些数据集、能跑哪些计算；
这里的目录、数据查询、文档和 MCP 工具都从那一节生成，所以三个出口不会对不上。

The layer for outside AI agents: one description, three outlets (documents, /api/v1, MCP).
Each subproject states its datasets and the computations it can run in the `agent` section
of its sim.json; the catalogue, dataset queries, documents and MCP tools here are all
generated from that section, so the three outlets cannot drift apart.
"""
