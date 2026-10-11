"""统一入口：由 idea-loom 一个进程托管所有模拟。

每个模拟在自己的子域名下（http://<项目>.localhost:<端口>/），所以彼此是不同的源。
代码取自 origin/main 的快照，不碰工作目录。需要后端的项目，后端由这里按需启动并转发。

The single entry point: one idea-loom process hosts every simulation. Each simulation
lives on its own subdomain (http://<project>.localhost:<port>/), so each is its own
origin. The code is a snapshot of origin/main and the working tree is never touched.
A project that needs a backend has it started on demand here and proxied.
"""
