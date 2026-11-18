# lazy-comfy

> 让 ComfyUI 按需启动、空闲休眠、自动省显存。

一个零依赖的本地反向代理：监听 `127.0.0.1:8189`，把请求转发给内部 `8188` 的 ComfyUI。
没人用时逐级降档，真正发图时自动唤醒——不用每次打开网页都等 50 秒冷启动。

**lazy-comfy** is a zero-dependency local proxy for ComfyUI. It starts the backend on demand,
unloads models after 10 minutes idle, stops the process after 30 minutes, and restarts it
eagerly if it crashes. Background polling from the ComfyUI web UI does not keep it awake.

## 快速开始

要求：Node.js **20+**（18 已 EOL，CI 也不再覆盖），ComfyUI 已经能在本机正常启动。

```bash
# 在仓库目录
node lazy-comfy.mjs --root "D:\ComfyUI"
```

然后把浏览器里的 ComfyUI 地址从 `http://127.0.0.1:8188` 改成
**`http://127.0.0.1:8189`** 即可。

### Windows

普通整合包 / 手动安装：

```bat
node lazy-comfy.mjs --root "D:\ComfyUI"
```

ComfyUI 便携包（`ComfyUI_windows_portable`）的目录结构是：

> 注意：`--root` 要指向**内层** `ComfyUI` 文件夹，不是外层的 `ComfyUI_windows_portable`。

```text
ComfyUI_windows_portable\
├─ ComfyUI\                 <- --root 指向这里
└─ python_embeded\
   └─ python.exe
```

```bat
node lazy-comfy.mjs --root "D:\ComfyUI_windows_portable\ComfyUI"
```

代理会自动在 `ComfyUI` 旁边找到 `python_embeded\python.exe`；也会找
`ComfyUI\.venv\Scripts\python.exe`。

也可以直接双击仓库里的 [`start.bat`](start.bat)，先把里面的 `D:\ComfyUI` 改成你的路径。

### Linux / macOS

```bash
node lazy-comfy.mjs --root ~/ComfyUI
```

默认依次查找 `ComfyUI/.venv/bin/python`、`ComfyUI/venv/bin/python`，
找不到就退回 PATH 里的 `python3`。建议用 ComfyUI 自己的 venv。

### 安装成命令（可选）

```bash
npm install -g .
lazy-comfy --root ~/ComfyUI
```

### 常用参数

```bash
# 默认状态：空闲 10 分钟卸载模型，30 分钟结束进程
node lazy-comfy.mjs --root ~/ComfyUI

# 想更省显存，可以调小（例：5 分钟卸模型，20 分钟结束进程）
node lazy-comfy.mjs --root ~/ComfyUI --idle 5 --stop 20

# 调试：打印每个请求，看看是谁在续命
node lazy-comfy.mjs --root ~/ComfyUI --debug

# 代理退出时把后端也关掉（默认保留，下次启动更快）
node lazy-comfy.mjs --root ~/ComfyUI --stop-on-exit
```

### 使用说明（完整命令行帮助）

以下为 `node lazy-comfy.mjs --help` 的完整输出：

```text
lazy-comfy 1.1.9 — ComfyUI 按需启动 + 分级休眠代理

用法:
  node lazy-comfy.mjs [选项]

选项:
  -p, --port <端口>           代理监听端口（默认 8189，env LAZY_PORT）
  -b, --backend <端口>        ComfyUI 后端端口（默认 8188，env COMFY_PORT）
  -r, --root <目录>           ComfyUI 根目录（默认自动查找，env COMFY_ROOT）
      --python <路径>         Python 解释器（默认自动查找 venv / python_embeded）
      --idle <分钟>           空闲多久卸载模型（默认 10，0 = 关闭，env LAZY_IDLE_MIN）
      --stop <分钟>           空闲多久结束后端（默认 30，0 = 关闭，env LAZY_STOP_MIN）
      --log <文件>            日志文件（默认 <state-dir>/lazy.log，env LAZY_LOG）
      --state-dir <目录>      PID / 日志目录（默认 ~/.lazy-comfy，env LAZY_STATE_DIR）
      --start-timeout <毫秒>  冷启动超时（默认 180000，env LAZY_START_TIMEOUT_MS）
      --wait-timeout <毫秒>   请求等待后端就绪的上限（默认比启动超时多 10s，env LAZY_WAIT_TIMEOUT_MS）
      --upstream-timeout <毫秒> 单个转发的静默超时（默认 600000，0 = 关闭该超时，env LAZY_UPSTREAM_TIMEOUT_MS）
      --request-timeout <毫秒> 单请求无数据往来的兜底（默认 7200000，只在 --upstream-timeout 0 时生效，0 = 关闭，env LAZY_REQUEST_TIMEOUT_MS）
      --check-interval <毫秒> 空闲检查间隔（默认 30000，env LAZY_CHECK_MS）
      --hibernate-retry <次数> /free 连续失败多少次后放弃休眠（默认 3，env LAZY_HIBERNATE_RETRY）
      --probe-fail-limit <次数> 探活连续失败多少次后强制重启（默认 0=关闭，env LAZY_PROBE_FAIL_LIMIT）
      --passive-extra <正则>  追加被动路由正则，可重复（env LAZY_PASSIVE_EXTRA，逗号分隔）
      --stop-on-exit          代理退出时同时结束后端（默认保留，下次免冷启动）
      --debug                 打印每个请求（env LAZY_DEBUG=1）
  -h, --help                  显示帮助
  -v, --version               显示版本

示例:
  node lazy-comfy.mjs --root "D:\ComfyUI"
  node lazy-comfy.mjs --idle 5 --stop 20 --stop-on-exit

Windows 便携包：--root 指向 ...\ComfyUI_windows_portable\ComfyUI，
代理会自动使用旁边的 python_embeded\python.exe。

只监听 127.0.0.1；ComfyUI 工作流可执行本机代码，请勿暴露到公网。
```

## 它解决什么问题，以及它怎么工作

ComfyUI 冷启动通常要 40–60 秒。很多人为了省显存，用完就关，下次出图再等一遍；
一直开着又占着几 GB 显存。lazy-comfy 把「开关」变成自动档：

| 状态 | 触发条件 | 动作 | 下次出图 |
| --- | --- | --- | --- |
| 运行 | 有主动请求 | 正常转发 | 立即 |
| 休眠 | 空闲 10 分钟 | `POST /free` 卸载模型，进程保留 | 重新加载模型，几秒 |
| 停止 | 空闲 30 分钟 | 结束由代理启动的后端进程 | 冷启动，几十秒 |
| 崩溃 | 后端意外退出 | 看门狗 5 秒后自动重启 | 自动恢复 |

空闲时间都可以改，也可以设为 `0` 关闭对应档位。

```text
浏览器 / 插件
     │  http://127.0.0.1:8189
     ▼
┌──────────────┐   主动请求    ┌──────────────────┐
│ lazy-comfy   │ ───────────▶ │ ComfyUI :8188    │
│              │              │                  │
│  空闲 10min  │ ── /free ──▶ │ 卸载模型，进程保留 │
│  空闲 30min  │ ── kill ───▶ │ 结束进程          │
│  崩溃看门狗  │ ── 重启 ───▶ │ 退避后自动拉起     │
└──────────────┘              └──────────────────┘
```

### 请求分级

只有「主动请求」才算有人在干活：

| 类型 | 例子 | 记活跃 | 唤醒后端 |
| --- | --- | :---: | :---: |
| 被动探测 | `GET /prompt`、`GET /queue`、`GET /history/*`、`GET /models`、`GET /embeddings` | ✗ | ✗ |
| 主动请求 | `POST /prompt`、`POST /interrupt`、`GET /view`、`GET /`（加载页面） | ✓ | ✓ |
| 健康检查 | `GET /system_stats` | ✗（1.1.3 起） | ✓（仅 stopped，10 分钟冷却） |
| WebSocket | `/ws` 升级 | ✗ | ✗（后端睡着时直接断开） |

新版 ComfyUI 前端会给请求加 `/api` 前缀，代理会先去掉前缀再分类，两套路由都兼容。
后端休眠时 ws 升级会直接断开，浏览器控制台会出现重连失败，这是预期行为，不会唤醒后端。

被动探测在后端休眠时直接返回 `503`，不会触发启动；网页的轮询会自动重试，
真正点「生成」时再唤醒。这样一个开着的网页不会把省电策略废掉。

`GET /system_stats` 从 1.1.3 起不再刷新活跃时间：运行中只转发真实 stats，不续命；
只在后端 `stopped` 时作为健康检查拉起后端，最多每 10 分钟一次，冷却期返回
`x-lazy-state: cooldown`。这样监控轮询不会阻止休眠。

### 高级：自定义被动路由（`--passive-extra`）

默认只把 `/prompt`、`/queue`、`/history/*`、`/models`、`/embeddings` 当作被动探测。
如果你用的插件、监控或自己的脚本还有别的**只读 GET** 路由，可以用正则追加：

```bash
# 单个路由
node lazy-comfy.mjs --root ~/ComfyUI --passive-extra '^/my-plugin/status$'

# 多个路由：CLI 可以重复
node lazy-comfy.mjs --root ~/ComfyUI \
  --passive-extra '^/metrics$' \
  --passive-extra '^/health$'
```

环境变量用逗号分隔（正则本身不要带逗号）：

```bash
LAZY_PASSIVE_EXTRA='^/metrics$,^/health$' node lazy-comfy.mjs --root ~/ComfyUI
```

规则：

- 只对 `GET` 生效，`POST` 一律算主动。
- 匹配前会先去掉 `/api` 前缀，所以 `^/metrics$` 也能匹配 `/api/metrics`。
- 后端休眠时，被动路由直接返回 `503`，不会唤醒后端。
- 只把纯查询路由加进来；`/view`、`/object_info` 这类会触发实际工作的不要加。
- 用 `--debug` 可以看到每个请求被分成 `PASSIVE` 还是 `ACTIVE`。

这个开关适合把「状态查询」和「真正干活」分开，不用改代码就能适配自己的插件。

### 三级策略

1. **空闲 `--idle` 分钟**：调用 ComfyUI 的 `POST /free`
   （`{"unload_models":true,"free_memory":true}`）卸载模型，进程保留。
   下一次出图只需重新加载 checkpoint，通常几秒。
2. **空闲 `--stop` 分钟**：结束由本代理启动的后端进程，彻底释放显存和内存。
3. **后端崩溃**：看门狗每 30 秒探活一次，发现进程没了就按
   5s → 10s → 20s → 40s → 60s 退避重启；连续失败超过 5 次后暂停自动重启，
   等下一次主动请求再试，避免崩溃循环刷日志。

如果 `/free` 返回 404/405（明确不支持），或连续失败达到 `--hibernate-retry` 次（默认 3），
代理会停止尝试休眠，但**不会**在 idle 时提前杀进程；等 `--stop` 时间到再结束后端。
临时 5xx / 超时会在下一次检查时自动重试。如果后端是**你自己手动启动的**，
代理会接管转发和休眠，但不会杀它——避免误杀。

空闲到点时，代理还会先问后端一句 `GET /queue`：`queue_running` 或 `queue_pending` 非空就跳过这一轮，
既不卸模型也不结束进程（队列非空时会把空闲计时重置）。`/queue` 自己超时或返回 5xx 时同样跳过——
检查失败不能当成「确认没人在用」。因为出图期间客户端只发 ws 进度和被动轮询，看门狗光看请求时间
会以为没人在用（长任务：视频模型、大 upscale、批量队列）。

### 健康检查占位

ComfyUI 冷启动要 40–60 秒，但很多客户端对 `GET /system_stats` 只等 5 秒。
所以后端没起来时代理会立刻返回一份 `200` 的占位 stats：

```json
{
  "system": { "comfyui_version": "starting" },
  "devices": [{ "name": "starting", "vram_total": 0, "vram_free": 0 }]
}
```

同时后台开始启动。真正需要后端的请求（例如 `POST /prompt`）会等到后端就绪后再转发，
不会拿到假结果。

### 退出行为

- 默认：代理退出时**保留**后端进程，PID 写入状态目录；下次启动自动复用，省掉一次冷启动。
- `--stop-on-exit`：代理退出时结束后端，显存立刻释放。
- 系统重启后 PID 文件会失效，代理会清理掉，不会误杀复用了同一 PID 的其它进程。
- **Windows 注意**：`--stop-on-exit` 依赖进程收到 SIGINT/SIGTERM 才能跑清理逻辑。用 `Ctrl+C` 关控制台、或在任务栏关闭窗口都会触发；但用 `taskkill /F`、任务管理器「结束任务」、或从另一个 Node 进程 `child.kill()` 都是强制终止，清理不会执行，后端会留下来（下次启动会被识别并复用，不会重复启动）。遇到这种情况按状态目录里的 `comfy-<端口>.pid` 手动结束即可。

## 适合谁，不适合谁

### 适合

- **单机、单卡自用**的 ComfyUI，尤其是 8–16 GB 显存这一档：跑 SDXL / Flux / 视频模型时显存紧，不跑时又不想白白占着 6–8 GB。
- 想做到「**打开网页就能出图**」，同时不想让 ComfyUI 24 小时常驻。
- **笔记本 / 游戏兼工作机**：不画图时立刻把显存还回去，打游戏、开会、跑别的模型都不打架。
- **长期挂机、偶尔使用**（远程桌面、家里小主机、工作室里的出图机）：今天想起来才用一次，不想它一直烧着。
- 出图**单张就要 1–3 分钟、甚至十几分钟**的场景（高步数、大尺寸、视频模型、批量队列）：1.1.7 起有队列守卫，任务在跑时不会卸模型、不会被结束。

### 不适合

- **多人共用的出图服务器**：它不管鉴权、限流、队列公平和按人计费，那是另一层的事。
- **多机 / 多卡集群**：一个代理只托管本机的一个 ComfyUI 进程。
- **要求首包延迟极低**：停止状态下仍然要 40–60 秒冷启动（休眠状态只要几秒重载模型）。
- **要对外暴露**：默认只监听 `127.0.0.1`，没有 TLS、没有账号体系，别直接拿它当公网网关。
- **非 ComfyUI 的后端**：判定依赖 ComfyUI 的 `/system_stats`、`/queue`、`/free` 语义。

## 典型场景，以及和其他做法比

### 典型场景（包括「跑很久」的那种）

| 场景 | 为什么需要它 | 运行时的样子 |
| --- | --- | --- |
| **视频生成**（Wan2.2 / SVD / AnimateDiff 等） | 单条 5–30 分钟，中途**没有任何前端请求**，只有服务端往 ws 推进度 | 队列守卫每轮先问 `GET /queue`，`queue_running` 非空就完全不动；跑完才开始计算空闲 |
| **高步数大图 / 大尺寸 upscale** | 一张图十几分钟，同样「没人操作」 | 同上；`/queue` 里排着队也照样算忙 |
| **批量队列**（一次提交几十个任务） | `queue_running` 可能只有 1 条，其余在 `queue_pending` | running 和 pending **任意一个非空**都不休眠、不结束进程 |
| 白天写代码、晚上画图 | 一天只用两小时，剩下 22 小时白占 6–8 GB 显存 | 10 分钟卸模型（显存回落到几百 MB），30 分钟结束进程，明天第一次出图自动拉起 |
| 远程桌面 / 家里小主机 | 机器一直开着，ComfyUI 只是偶尔用 | 没人用就逐级降档，不用记得手动关 |
| 换端口多开 | 想同时留一个「常驻快」的实例和一个「按需省显存」的实例 | `--port 8190` 起第二个代理，各自独立管理各自的后端 |

> 关键点：**「有没有人操作浏览器」和「后端有没有在干活」是两件事。**
> 绝大多数省显存方案看的是前者（有没有 HTTP 请求），所以视频这种「提交后就走开、等 20 分钟回来拿片」的场景必被杀。
> lazy-comfy 看的是后者——`GET /queue` 才是权威信号。

### 和其他常见做法比

| 做法 | 代价 | 用了 lazy-comfy 之后 |
| --- | --- | --- |
| 用完手动关，下次手动开 | 每次都要等 40–60 秒冷启动，还得记得开 | 空闲自动关，来的第一个请求自动开 |
| 一直开着 | 常驻 4–8 GB 显存，其他活干不了 | 空闲 10 分钟卸模型（显存回落到几百 MB），进程留着 |
| ComfyUI 的 `--auto-launch` | 只负责「启动后自动开浏览器」，不省显存 | 真的按需启停 |
| 定时脚本 `cron` + `/free` | 可能正好把正在出图的进程卸了 | 唤醒/休眠前先问 `/queue`，有任务就不动 |
| 开机计划任务常驻 | 不管有没有人在用 | 按请求驱动，没人用就降档 |

## 特性与优势

### 特性

- **按需启动**：第一个主动请求到来时才启动 ComfyUI。
- **三级降档**：卸载模型 → 结束进程 → 崩溃自动重启。
- **请求分级**：网页断线后的 `GET /prompt`、`GET /queue`、`GET /history/*` 轮询，
  以及每 300ms 一次的 WebSocket 重连，都不会把刚睡下的后端吵醒。
- **健康检查占位**：冷启动期间 `GET /system_stats` 先返回 200 占位数据，
  避免只等 5 秒的客户端直接报错；真正干活的请求会排队等后端就绪。
- **跨平台**：Windows（含 ComfyUI 便携包 `python_embeded`）、Linux、macOS。
- **零依赖**：只需要 Node.js，不用 `npm install`。
- **安全默认**：只监听 `127.0.0.1`，不对外网开放。
- **可运维**：PID 文件、日志轮转、`--stop-on-exit`、可配置超时和检查间隔。

### 不太显眼的优势

这些不是宣传点，是实际踩过坑才补上的：

1. **长任务不会被打断**：视频模型、大 upscale、批量队列，只要 `/queue` 里还有东西，就不卸模型、不结束进程。
2. **网页挂在后台不会「续命」**：ComfyUI 前端断线后每 300ms 重连 ws，还会每秒轮询 `GET /prompt`；这些都被识别成被动流量，不会把刚睡下的后端吵醒。
3. **冷启动时前端不报错**：`GET /system_stats` 先返回 200 占位（`x-lazy-state: starting`），只等 5 秒就超时的客户端也不会弹红字；真正干活的请求才排队等后端。
4. **后端偷死能自己救回来**：看门狗发现进程没了，5 秒后自动重启——不需要你重启代理。
5. **不会误杀你自己开的 ComfyUI**：代理检查 PID 与命令行，发现是外部启动的，空闲时只 `/free` 卸载模型，**绝不动进程**。
6. **冷启动被打断也不丢托管**：`spawn` 成功就立刻写 PID 文件（状态 `starting`），下次启动能认出「上次没启动完的那个」并接管；接管来的如果没有启动超时兜底，会一直卡在 `starting`——1.1.8 补了 deadline。
7. **杀不掉时不假装成功**：`taskkill` 失败会重试、指数退避、日志写清 pid 和次数，而不是打完一行「已结束」就当成功。
8. **Windows 上真的能用**：便携包 `python_embeded`、中文与空格路径、进程树结束（`taskkill /T`）、`--stop-on-exit` 退出清理都验过。
9. **零依赖单文件**：只有一个 `.mjs`，不用 `npm install`，不改 ComfyUI 源码、不装自定义节点、工作流原样可用。
10. **显存回落可量化**：实测同一台机器（12 GB 显存），出图后 `7158 MiB` → 卸模型后约 `800 MiB`，回来后第一次出图约 20 秒恢复。

## 它不做什么，以及已知限制

- 不改 ComfyUI 源码、不装自定义节点、不动你的工作流。
- 不管理模型文件，也不自动下载。
- 不替你做请求重试（除了「冷启动期间排队等后端就绪」）。

### 已知限制

- **ws 连接不受任何超时约束**：`/ws` 是长连接，超时只作用于 HTTP 转发。前端断线由浏览器自己重连。
- **生成期间只有 `GET /queue` 能证明后端在干活**：出图时的流量是 ws 进度推送 + 被动轮询，
  不刷新「最后活跃时间」。代理靠 `queue_running` 判断，所以如果你绕开 `/queue` 直接驱动
  ComfyUI（比如自己写脚本调 API 又不排队），空闲策略可能在你还在用时休眠模型。
- **Windows 的清理依赖 SIGINT/SIGTERM**：`Ctrl+C`、关控制台窗口会触发清理；`taskkill /F`、
  任务管理器结束、别的进程 `child.kill()` 都是强制终止，后端会留下（下次启动自动复用）。
- **队列非空会重置空闲计时**：批量任务跑完后，还要再等满一个空闲窗口（默认 10 分钟卸载 / 30 分钟结束）
  才释放，所以「我早就不出图了，怎么还占着显存」通常是这个原因——不是泄漏，是故意不打断刚结束的批次。
- **`/queue` 长期异常时会一直保守跳过**：后端活着但 `/queue` 持续 5xx/超时（或队列响应超过 256 KB 被截断），
  代理按「不知道就别杀」处理，`--stop` 到点也不会结束它；日志里显示为「/queue 检查失败」。
  真需要强制收回就手动结束进程。
- **两个超时都设 0 时没有任何兜底**：挂死的请求会让空闲策略一直不生效，日志每 10 分钟提示一次。
- Windows 上的完整链路（真实 Python 冷启动、`/free`、结束进程）靠人手工冒烟，CI 只跑假后端用例。

同一个后端端口只建议运行一个代理；两个代理共用一个后端时，PID 文件和空闲策略会互相干扰。

## 出发点与创作理念

### 出发点：网页开着，和后端该睡，本来就是矛盾的

ComfyUI 的前端一旦打开，它就不停地「呼吸」：

- 每 **300ms** 重连一次 WebSocket（断线状态无限重试）；
- **每秒** `GET /prompt` 轮询队列，断线时更频繁；
- 出图时靠 ws 接收进度推送，客户端本身不发任何上行数据。

于是任何「看有没有 HTTP 请求、没请求就休眠」的方案都会卡在两难里：

- **网页开着 → 请求不断 → 永远不休眠**，省显存失败；
- **想让网页一直可用 → 就不敢真睡**，只能常驻，白占几 GB 显存。

lazy-comfy 的出发点就是把这两件事拆开：**「网页在呼吸」不等于「后端在干活」**。

- `/prompt`、`/queue`、`/history/*`、`/models`、`/embeddings` 这些被动轮询，以及 ws 重连，都**不算活跃**；
- 真正的繁忙判定交给 `GET /queue`——队列里有没有任务在跑（或排着队）。

这样网页可以一直开着，后端照样能睡；出图时哪怕前端没在轮询（你切走了、关屏了、远程断开了），只要队列里有任务，它就不会被卸模型、不会被结束。

### 创作理念

这工具最初只是为了一件事：**让家里的显卡在不用的时候真的能空出来，用的时候又不用等。** 做着做着发现，难点不在「启停」，而在「判断该不该启停」。所以定了下面几条，后面每个版本都在往这个方向收：

1. **按需，不多占一秒钟。**
   没人用就该退，退得越彻底越好：先卸模型（显存立刻回来），再结束进程（内存和端口也还回来）。反过来，有人要用就得快——所以才有冷启动占位、被动路由不唤醒这些细节。

2. **判断依据是「后端在不在干活」，不是「有没有人碰浏览器」。**
   这是全项目最核心的一条。前端会一直呼吸（ws 重连、每秒轮询），把它当活跃信号，等于永远不休眠；把它当噪音，又得另找一个权威信号——`GET /queue`。宁可多问一次后端，也不猜。

3. **不打扰用户原本的工作方式。**
   不改 ComfyUI 源码、不装自定义节点、不动工作流；你要做的只是把地址从 `8188` 换成 `8189`。开关、卸载、重启都发生在「你没看见」的地方。

4. **失败要看得见，不许假装成功。**
   杀不掉进程、日志写不进去、`/free` 失败——都写清 pid、次数、下一步会怎样，而不是打一行「已结束」继续下一轮。这类「看起来成功了其实没有」的坑，是显存泄漏最常见的来源。

5. **安全默认，边界清楚。**
   只监听 `127.0.0.1`；不是本代理启动的后端，只休眠、绝不结束进程；鉴权、队列公平、模型管理这些不归它管，也不假装管。

6. **极简落地。**
   零依赖、单文件 `.mjs`、不用 `npm install`；配置就是几个数字（端口、空闲分钟数、超时）。能用一个数字表达的策略，不引入第二套机制。

7. **文档写清「不适用」。**
   一个只说优点的工具是不负责任的。所以 README 里专门有「不适合」和「它不做什么」——先让人确认自己不该用它，再谈怎么用。

## 关于作者

这个项目是 **大肥鱼** 写的——由**小白主人**指派、在主人自己的机器上（**12 GB 显存**）针对每天真实遇到的麻烦做出来的：
网页不敢关、显存不敢占、关了就等 50 秒、开着又没法跑别的模型。**一气之下的产物**。

所以它的每一条设计都带着具体场景：视频模型跑二十分钟不敢走开、笔记本打完游戏想立刻把显存还回去、
冷启动期间前端弹红字让人心慌、以及「看出来了但没修干净」的那些边界（1.1.4 的吞请求体、1.1.6 的生成期误杀）。
如果你在自己的机器上遇到这里没写到的情况，欢迎开 Issue——把日志和参数贴全，比什么都管用。

## 配置

命令行参数优先于环境变量。

| 命令行 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `-p, --port` | `LAZY_PORT` | `8189` | 代理监听端口 |
| `-b, --backend` | `COMFY_PORT` | `8188` | ComfyUI 后端端口 |
| `-r, --root` | `COMFY_ROOT` | 自动查找 | ComfyUI 根目录（含 `main.py`） |
| `--python` | `COMFY_PYTHON` / `LAZY_PYTHON` | 自动查找 | Python 解释器 |
| `--idle` | `LAZY_IDLE_MIN` | `10` | 空闲多少分钟卸载模型，`0` = 关闭 |
| `--stop` | `LAZY_STOP_MIN` | `30` | 空闲多少分钟结束后端，`0` = 关闭 |
| `--log` | `LAZY_LOG` | `<state-dir>/lazy.log` | 日志文件 |
| `--state-dir` | `LAZY_STATE_DIR` | `~/.lazy-comfy` | PID / 日志目录 |
| `--start-timeout` | `LAZY_START_TIMEOUT_MS` | `180000` | 冷启动超时（毫秒），超时会杀掉重试 |
| `--wait-timeout` | `LAZY_WAIT_TIMEOUT_MS` | 启动超时 + 10s | 单个请求等待后端就绪的上限 |
| `--check-interval` | `LAZY_CHECK_MS` | `30000` | 空闲检查间隔（毫秒） |
| `--upstream-timeout` | `LAZY_UPSTREAM_TIMEOUT_MS` | `600000` | 单个请求的静默超时（无数据往来），`0` = 完全关闭；挂死请求可能让空闲策略停摆，不建议关闭（0-86400000） |
| `--request-timeout` | `LAZY_REQUEST_TIMEOUT_MS` | `7200000` | 单请求无数据往来的兜底，**只在 `--upstream-timeout 0` 时生效**；超时只断开这一条请求（0-86400000） |
| `--hibernate-retry` | `LAZY_HIBERNATE_RETRY` | `3` | `/free` 连续失败多少次后放弃休眠（1-20） |
| `--probe-fail-limit` | `LAZY_PROBE_FAIL_LIMIT` | `0` | 探活连续失败多少次后强制重启，`0` = 关闭（0-20） |
| `--passive-extra` | `LAZY_PASSIVE_EXTRA` | 空 | 追加被动路由正则，CLI 可重复，env 用逗号分隔（正则里别用逗号） |
| `--stop-on-exit` | `LAZY_STOP_ON_EXIT=1` | 关闭 | 代理退出时同时结束后端 |
| `--debug` | `LAZY_DEBUG=1` | 关闭 | 打印每个请求的主动/被动分类 |

`--idle` 和 `--stop` 支持小数，方便调试（例如 `0.05` 表示 3 秒）。

> ⚠️ `--probe-fail-limit` 是高危选项：连续探活失败也可能只是模型正在加载。
> 默认 `0` 关闭；除非你确认后端已经卡死，否则不要设得太小，建议 `5` 以上。

`--wait-timeout` 小于 `--start-timeout` 时，请求会先收到 `503`，但后台仍会继续启动。
只有明确想「快速失败」时才这样配；一般保持默认即可。

### 四个超时各管什么

名字很像，管的事情完全不同；用错会「明明调了却没效果」：

| 参数 | 管哪一段 | 默认 | 触发后发生什么 | 什么时候才需要改 |
| --- | --- | --- | --- | --- |
| `--start-timeout` | **冷启动后端**（从 spawn 到 `/system_stats` 正常） | 180000（3 分钟） | 判为启动失败，结束这个半启动的进程，后续请求走「后端不可用」分支 | 首次加载大模型/慢盘明显超过 3 分钟 |
| `--wait-timeout` | **单个请求等后端就绪**（请求已进来，后端还在起） | 启动超时 + 10s | 这条请求回 `503`，但后台继续启动（不是失败） | 想要「快速失败」而不是干等，可设得比启动超时小 |
| `--upstream-timeout` | **单条转发多久没有数据往来**（静默超时，边聊边传的慢请求不算） | 600000（10 分钟） | 断开本机这一侧、回 `504`（未发头时）；ComfyUI 里的任务不会被取消 | 有真正超过 10 分钟不吐数据的长任务（大 upscale、视频） |
| `--request-timeout` | 单条请求的**无数据兜底**：从请求进来到结束都计时，任何数据往来都会重置；只在 `--upstream-timeout 0` 时生效 | 7200000（2 小时） | 只断开这一条请求（未发头 `504` / 已发头 `res.destroy()`），不动别的连接 | 关了上游静默超时之后，仍想有个「绝对不会永久挂住」的保险 |

两个容易搞混的点：

- **静默 ≠ 总时长**：`--upstream-timeout` 计的是「多久没数据」，一条持续在传但很慢的请求不会超时；
  `--request-timeout` 才是「从进来到结束，多久没数据就砍」（任何数据往来都重置），且平时不启用。
- **`0` 的含义都是「关闭这个超时」**，不是「立即超时」。两个都设 `0` 就没有任何兜底了，
  挂死的请求会让空闲策略停摆（日志里会周期性提示你）。

状态目录默认是 `~/.lazy-comfy`（Windows 为 `%USERPROFILE%\.lazy-comfy`），里面有：

- `lazy.log`：代理日志 + ComfyUI 的 stdout/stderr；超过 5MB 轮转为 `lazy.log.1`。
- `comfy-<端口>.pid`：后端 PID、端口、根目录，用于重启后复用和安全结束进程。后端刚 spawn
  就会写一次（`"state":"starting"`），所以冷启动期间代理被杀，下次启动仍然知道这个后端归自己管。

## 常见问题
**不出图很久了，显存还占着？**
先看日志有没有「队列里还有任务在跑」。队列非空时代理会不断重置空闲计时（避免打断正在跑的批次），
所以最后一张出完还要再等一个完整窗口才卸载或结束。想立刻释放：执行 `node lazy-comfy.mjs --stop`，
或直接结束后端进程（下次请求会自动拉起）。

**第一次请求还是要等 50 秒？**
只有第一次冷启动需要。之后空闲 10 分钟是卸载模型（几秒恢复），30 分钟才是杀进程。
觉得杀得太早可以把 `--stop` 调大，或设 `0` 永不杀；想更省显存就调小。

**网页开着挂机，为什么还是休眠了？**
这是设计目标。ComfyUI 网页断线后的轮询和 ws 重连不算活跃。用 `--debug` 可以看到
每个请求被分成 `PASSIVE` 还是 `ACTIVE`；如果某个插件一直发主动请求，可以把它特有的
只读路由加进 `LAZY_PASSIVE_EXTRA`。

**日志里出现「卸载模型失败」？**
`/free` 在高负载、模型加载中可能临时失败，代理会按 `--hibernate-retry` 重试；
连续失败或返回 404/405 才停止尝试休眠。它不会在 idle 时提前杀进程，而是等 `--stop`
时间到再结束后端；手动启动的后端只跳过休眠，不会杀。

**端口被占用？**
`8189` 或 `8188` 被别的程序占了。改 `--port` / `--backend`，同时把浏览器地址改成新的代理端口。
如果日志提示「是不是已经有一个 lazy-comfy 在运行」，先关掉旧的。

**为什么结束进程失败？**
代理只结束自己启动、且在 PID 文件里记录的后端。如果状态目录被删、PID 被系统复用，
它会选择不动手，避免误杀其它 Python 进程。查看日志确认后端是否还在，必要时手动结束。

**Windows 上代理重启后没有复用后端？**
少数精简系统或权限受限环境读不到进程命令行，代理会保守地把已有后端当作外部后端：
不会误杀，但也不会按空闲策略结束它。日志里会有「无法确认 PID」提示。
极端情况下，如果旧后端还在启动中，代理可能把它当外部后端并另起一个；
看到这条日志时，先手动结束残留的 ComfyUI，再启动代理。

**Windows 日志文件一直变大？**
Windows 下 ComfyUI 持有日志写句柄，`copy + truncate` 轮转可能失败。代理不会崩溃，
但 `lazy.log` 可能继续增长；定期重启代理或手动清理即可。

**后端进程还在，但所有请求都超时？**
代理会优先避免把「忙」误判成「死」：健康检查超时但 PID 仍存活时默认不自动重启，
空闲达到 `--stop` 会结束它。

每个转发请求都有 `--upstream-timeout`（默认 600000 = 10 分钟）：
超过这么久**没有任何数据往来**（静默超时，不是请求总时长），代理会断开这条连接并返回 `504`，
日志写「转发超时 POST /prompt（600s 没有数据往来），只断开本机这一侧；ComfyUI 里的任务不会被取消」。

1.1.3 删掉了 1.1.2 的「按请求总时长强制释放所有连接」逻辑：那个逻辑会在慢速下载、
大图传输这类**一直有数据**但总时长较长的请求上误杀。现在只按静默时间判断；
只要数据在流动，请求就可以继续。

`--upstream-timeout 0` 会完全关闭静默超时。为了不让挂死请求把空闲策略永久卡住，
1.1.4 起有 `--request-timeout`（默认 2 小时，`0` = 关闭）：只在关掉上游超时时生效，
按「多久没有数据往来」计时，超时**只断开那一条请求**，不影响别的请求，也不会清零计数。
除非你明确知道自己在做什么，否则保持默认的 10 分钟静默超时就好。

出图时卡死又不想等 10 分钟，可以调小：

```bash
--upstream-timeout 120000
```

想更快恢复「进程活着但没反应」的后端，可以加 `--probe-fail-limit 5`：
连续 5 次探活失败（默认检查间隔下约 2.5 分钟）后，即使进程还活着也会先结束后端再重启。
默认是 `0`（关闭），避免把正在加载大模型的进程误杀。

**会不会「杀不掉」，一直占着显存？**
结束不了只有两类情况，两类都不会假装成功：

1. 结束后端失败（权限不足，或进程被别的程序保护）。从 1.1.1 起 `taskkill` 会重试一次；
   仍失败就保留 PID 和托管状态，日志写「结束后端失败（pid … 仍在，第 N 次）」。
   1.1.2 起按 30 秒 → 1 分钟 → 2 分钟 → 5 分钟指数退避重试（不再每 30 秒刷一次），
   连续 3 次提示手动处理。状态不会被错标成「已停止」。
2. 后端不是这个代理启动的。按设计只休眠不杀，避免误伤你手动开的 ComfyUI；
   日志会写「发现已在运行的后端（不是本代理启动的）」。想让它受管，就由代理来启动。

另外两处「差点变成孤儿」的路径，1.1.2 已堵住：

- **启动超时**：冷启动超过 `--start-timeout` 会 abort。以前如果这时杀进程失败，
  半启动的 Python 会留在后台并被下次探活当成「外部后端」，从此不受空闲策略管辖。
  现在会把它接管为托管后端，按上面的退避节奏继续重试。
- **健康检查**：`GET /system_stats` 运行中不再刷新活跃时间；`stopped` 时最多每 10 分钟
  拉起一次后端，冷却期返回 `x-lazy-state: cooldown`；`stopping` 时只返回占位，
  不会把刚停下的后端又拉起来。

判断当前是否托管：看启动日志有没有上面那句。没有就是托管中，空闲到 `--stop` 一定会被结束。

**能远程访问吗？**
默认不能，也不建议。代理和 ComfyUI 都只绑定 `127.0.0.1`。ComfyUI 工作流可以执行本机代码，
暴露到公网等于把机器交出去。确有需要请用 SSH 隧道或带认证的反向代理。

**ComfyUI 更新后路径变了？**
重新用 `--root` 指向新的 `main.py` 所在目录；如果 Python 环境也换了，用 `--python` 指定。

### 开机自启

Linux（systemd 用户服务）：

```ini
# ~/.config/systemd/user/lazy-comfy.service
[Unit]
Description=lazy-comfy
After=network.target

[Service]
ExecStart=/usr/bin/node %h/lazy-comfy/lazy-comfy.mjs --root %h/ComfyUI
Restart=on-failure
RestartSec=5
Environment=LAZY_STOP_ON_EXIT=1

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now lazy-comfy
```

上面是 systemd `--user` 单元，`%h` 会展开成用户目录。如果放到 `/etc/systemd/system`
作为系统服务，`%h` 不会展开，请改成绝对路径并补上 `User=`。

Windows：任务计划程序新建任务，程序填 `node.exe`，参数填
`"C:\path\to\lazy-comfy.mjs" --root "D:\ComfyUI"`，起始于脚本所在目录，
勾选「不管用户是否登录都要运行」。也可以把 `start.bat` 放进启动文件夹。

## 安全

- 代理只监听 `127.0.0.1`，并以 `--listen 127.0.0.1` 启动后端。
- 没有任何认证；不要绑定到 `0.0.0.0`，不要端口转发到公网。
- ComfyUI 的自定义节点和工作流可以执行任意本机代码，请只加载信任的模型和节点。
- 开启 `--debug` 时日志会记录每个请求路径；后端 stdout/stderr 始终写入日志。分享前先检查是否含敏感信息（模型名、路径等）。

## 开发

```bash
npm test          # 单元 + 集成测试
npm run check     # 语法检查
```

集成测试会起一个假的 ComfyUI 后端，验证「被动 503 → 主动冷启动 → `/free` 临时失败重试
→ 休眠 → 结束 → 再次唤醒 → 退出复用 PID」的完整链路。它把 `main.py` 写成 JS、直接拿 node
当「python」跑，所以三平台同一套用例，不需要 shell 垫片。

1.1.3 起另有一组**纯 Node 的跨平台回归**（`test/proxy-loopback.test.mjs`）：
慢上游 → `504`、`--upstream-timeout 0` 的关闭提示、后端睡着时被动路由 `503`、
**持续有数据的慢请求不会被误杀**、**`/system_stats` 轮询不会阻止休眠**。
1.1.4 又补了两条兜底回归：`--request-timeout 1200` 下挂死请求 1.2s 拿到 `504` 且代理仍可服务；
同样的 `--request-timeout` 下，持续有数据的请求不会被掐断。
1.1.5 又补了一条：冷启动期间到达的请求体必须完整送达（200 KB body，假后端晚 900 ms 才监听）。
当前 30 个用例：本地（Windows 11 + Node 22.19）实测 30/30；
CI 矩阵覆盖 **Ubuntu / Windows × Node 20 / 22 / 24**（六种组合）—— 本地单平台跑绿不等于多平台都绿，发版前以 CI 绿灯为准。

macOS 暂未纳入 CI：这台账号的 macOS 作业从来没被分配过 runner（三次实测都是等 22~46 分钟后被判 cancelled）。用例本身是跨平台的，等 macOS runner 可用时把 macos-latest 加回矩阵即可。
测试把后端入口写成 `main.cjs`，用 `LAZY_ENTRY` 指过去（默认入口仍是 `main.py`）——
这样就不依赖 Node 对 `.py` 这种未知扩展名的处理方式（Node 23+ 会直接报
`ERR_UNKNOWN_FILE_EXTENSION`，Node 22 却能当 CommonJS 跑）。
GitHub Actions 跑 `ubuntu-latest` + `windows-latest` × Node 20 / 22 / 24，
覆盖「旧 LTS 到最新major」这条线，Node 23/24 上的扩展名行为差异由 CI 兜住。
发布前仍建议在 Windows 上手工验证：便携包路径、PID 复用、`taskkill /T` 进程树结束、
以及 `/free` 失败降级。

```text
lazy-comfy/
├─ lazy-comfy.mjs          # 全部逻辑，单文件
├─ test/
│  ├─ lazy-comfy.test.mjs       # 配置解析、路由分类
│  ├─ proxy-loopback.test.mjs   # 纯 Node 的跨平台转发回归
│  └─ proxy.test.mjs            # 端到端生命周期
├─ examples/
│  └─ lazy-comfy.service        # systemd 用户服务示例
├─ .github/workflows/test.yml
├─ CHANGELOG.md                 # 逐版变更（发版时本版那一节即 Release 正文）
├─ PUBLISH.md                   # 发布清单（建库、推送、发 Release）
├─ start.bat                    # Windows 双击启动示例（COMFY_ROOT 留空则自动查找）
├─ package.json
├─ LICENSE
└─ README.md
```

## License

[MIT](LICENSE) © 2026 大肥鱼

欢迎提 issue / PR。改动请求分级或进程管理前，建议先跑一遍 `npm test`。
