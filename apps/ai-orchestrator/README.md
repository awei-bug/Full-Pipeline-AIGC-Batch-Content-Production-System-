# ai-orchestrator

这是当前三层架构里的 Python 编排服务。

当前已经落地两条主要链路：

1. 单任务创作链路
   - 接收 `POST /internal/workflows/generate`
   - 根据任务类型选择图片或视频 provider
   - 轮询模型任务结果并下载本地文件
   - 回调 `api-server` 的 `/internal/orchestrator/task-events`
   - 可通过 `GET /internal/workflows/{workflowTaskId}` 查询本地运行状态

2. 批量商品内容生产链路
   - 接收 `POST /internal/batch-jobs/items`
   - 读取商品上下文
   - 生成营销文案、视频脚本、海报提示词
   - 生成商品配图
   - 回调 `api-server` 的 `/internal/batch-items/events`

## 需要的环境变量

- `MODELSCOPE_API_TOKEN`
- `AGNES_API_KEY`
- `API_SERVER_BASE_URL`，例如 `http://127.0.0.1:3100`
- `MODELSCOPE_IMAGE_MODEL`，默认 `Qwen/Qwen-Image`
- `MODELSCOPE_VIDEO_MODEL`，默认 `wanx2.1-t2v-turbo`
- `AGNES_BASE_URL`，默认 `https://apihub.agnes-ai.com/v1`
- `AGNES_TEXT_MODEL`，默认 `agnes-2.5-flash`
- `AGNES_IMAGE_MODEL`，默认 `agnes-image-2.5-flash`
- `AGNES_VIDEO_MODEL`，默认 `agnes-video-v2.0`
- `AI_ORCHESTRATOR_ASSETS_DIR`，默认 `storage/generated`

可选：

- `MODELSCOPE_BASE_URL`
- `MODELSCOPE_DATA_INSPECTION`
- `AI_TEXT_PROVIDER`
- `AI_IMAGE_PROVIDER`
- `AI_VIDEO_PROVIDER`
- `AI_CREATE_TIMEOUT_SEC`
- `AI_CALLBACK_MAX_ATTEMPTS`，默认 `3`
- `AI_CALLBACK_BACKOFF_SEC`，默认 `1`
- `AI_POLL_TIMEOUT_SEC`
- `AI_DOWNLOAD_TIMEOUT_SEC`
- `AGENT_TEAM_MODE`，默认 `1`；置 `0` 关闭多智能体协作层，回退线性链路
- `AGENT_MAX_REVISIONS`，默认 `3`；审核 agent 连续拒绝达到该次数后升级人工复核
- `OBJECT_STORE_BACKEND`，默认 `local`；可设 `s3` / `none`
- `OBJECT_STORE_LOCAL_DIR`，本地后端目录，默认 `storage/generated`
- `OBJECT_STORE_BUCKET`、`OBJECT_STORE_PREFIX`、`OBJECT_STORE_ENDPOINT`，S3 兼容后端配置
- `QUEUE_BACKEND`，默认随 Redis 配置取 `redis` / `memory`
- `EVAL_ENABLED`，默认 `1`；确定性多维评测
- `EVAL_THRESHOLD`，默认 `0.7`；评测通过阈值
- `PROMPT_OPT_ENABLED`，默认 `0`；开启后评测未通过且批次含 `projectId` 时自动改写并持久化角色提示词
- `SAFETY_LLM_ENABLED`，默认 `0`；开启第二层 LLM 安全审核（第一层规则审核始终开启）
- `SAFETY_DENY_WORDS`，逗号分隔的额外违禁词
- `COST_PRICING_JSON`，覆盖模型单价（元/千 token），如 `{"agnes-2.5":[0.004,0.012]}`

## 启动方式

```powershell
cd apps/ai-orchestrator
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8100 --reload
```

## 当前限制

- 视频链路目前仍按实验能力管理，不是当前 MVP 的主验收标准。
- 默认对象存储后端为本地磁盘（`storage/generated`）；配置 `OBJECT_STORE_BACKEND=s3`
  后落 S3 兼容存储，但尚未在真实对象存储上验收。
- 多智能体协作层已实现（见下文），默认开启；关闭后回退为原线性链路。
- 评测、内容安全双层审核、成本核算、对象存储与任务队列均已落地（见下文）；
  其中提示词自优化与 LLM 安全层默认关闭，需显式开启。
- 仍未纳入：真实账单对账、租户隔离与鉴权、生产级观测（指标/分布式追踪）。

## 多智能体协作层（Multi-Agent Team）

`app/agents/` 把「调研→撰写→润色→审核」从固定线性链升级为协作系统。默认
开启（`AGENT_TEAM_MODE=1`），关闭后 `IPContentService` 仍走原 `build_graph` 线性链。

设计要点：

- 角色 Agent（`roles.py`）：调研员、编剧、叙事编辑、审核员，各自持有独立 system
  身份与工具（调研员与审核员可查设定库）。每个 `act` 产出状态更新、一条跨 agent
  消息与一个 trace 条目。
- Supervisor（`team.py`）：基于各角色产物是否齐备做路由决策，是协作的协调者。
- 共享记忆：以 `memory_constraints` / `memory_issues` 列表存入图状态，全角色可读写，
  全部 JSON 可序列化以兼容 Redis checkpointer。
- 跨 agent 消息：`agent_messages` 列表承载「审核员→撰写员」的结构化反馈等协作通信。
- 自主自我修正闭环：审核 agent 给出 `FAIL` 时写入结构化反馈，supervisor 据此把任务
  交还撰写 agent 改写，再经编辑、审核；达到 `AGENT_MAX_REVISIONS` 仍未通过则置
  `needsHumanReview` 升级人工复核，避免死循环。
- 人工退回（`revise`）：以 `supervisor` 为起点重放，把退回意见注入为反馈并清空下游产物。

结果对象新增 `agentTrace`（协作轨迹）与 `needsHumanReview` 两个字段，便于观测与前端展示。
`build_team(prompt_overrides=...)` 还可注入由评测自优化闭环产出的角色 system 提示词。

## 评测 / 安全 / 成本 / 存储与队列（生产级增强层）

四项能力都在 `IPContentService.run_item` 的成稿之后执行，均为增强层：单项异常只记日志、
不中断生成主链路（章节仍按多智能体结果落库）。

- 模型评测与提示词自优化（`app/evaluation/`）
  - `evaluate_chapter` 做确定性多维评分：设定扎根（BM25 召回片段的字符二元组覆盖率）、
    约束合规、可读性、篇幅，加权得出总分与改进建议，写入结果 `evalReport`。
  - `PromptOptimizer` 在评分低于 `EVAL_THRESHOLD` 且批次带 `projectId` 时，用 LLM 依据
    评测报告改写四个角色的 system 提示词，持久化为 `promptProfile:{projectId}`；后续同库
    章节经 `build_team(prompt_overrides=...)` 加载，形成「评测→改写→复用」闭环
    （需 `PROMPT_OPT_ENABLED=1`）。
- 内容安全双层审核（`app/safety/`）
  - 第一层规则（始终开启）：提示注入、PII（手机号/邮箱/身份证）、违禁词、空内容，确定性零延迟。
  - 第二层 LLM（`SAFETY_LLM_ENABLED=1`）：按合规红线语义判定 `PASS/FAIL`，依据不足判 `FAIL`。
  - 任一层不通过即 `safetyHold=true`，章节强制转 `needs_review` 待人工复核，结果写入 `safety`。
- 成本核算（`app/cost/`）
  - `compute_cost` 依据 usage 与内置单价表（`COST_PRICING_JSON` 可覆盖）计算单章节成本，
    写入结果 `cost`；`get_batch` 聚合为 `costSummary`（总成本 + 按模型拆分）。
- 生产级存储与队列（`app/storage/`、`app/queue/`）
  - `ObjectStore` 抽象（本地磁盘 / S3 兼容）：成稿与评测/安全/成本报告序列化后落对象存储，
    结果写入 `objectKey`/`objectUri`，使任务元数据不随正文膨胀。
  - `JobQueue` 抽象：`MemoryJobQueue`（单机、分优先级）与 `RedisJobQueue`（跨进程持久）。
    `MemoryStore`/`RedisStore` 内嵌对应队列，对外保留 `schedule/unschedule/candidates/recover`
    接口；`worker_loop` 在两种后端下都能领取任务。

## Agnes 接入协议

当前 Agnes 模型、请求参数和异步视频轮询约定见 docs/agnes-provider.md。

## 数字 IP 多 Agent 生成

新增 `POST /internal/ip-content/projects`、`GET /internal/ip-content/projects`、
`GET /internal/ip-content/projects/{id}` 用于保存、列出和读取带版本号的 IP 设定库。
`POST /internal/ip-content/batches`、`GET /internal/ip-content/batches/{id}`、
`POST /internal/ip-content/batches/{id}/items/{itemId}/retry` 管理批次；
`POST /internal/ip-content/batches/{id}/items/{itemId}/review` 接收
`{"decision":"approved"}` 或 `{"decision":"rejected","note":"修改原因"}`，
被退回后使用 `POST .../revise` 从撰写节点开始重写。api-server 以
`/api/ip-content` 同名路径转发给 React 工作台。提交体示例：

```json
{"ipName":"星港纪事","projectId":"已保存设定库ID","strategy":"auto","chapters":[{"title":"第一章","brief":"章节目标……"}]}
```

不使用设定库时，提交体可用 `"lore":"世界观……"` 替代 `projectId`。
同一批次按章节顺序生成，调研、撰写和审核节点读取相关设定片段、最近三章的
成稿摘录与更早章节的目标及成稿结尾线索。历史线索超过上下文预算时，章节
强制转入人工复核，不会仅因模型返回 PASS 就自动推进后续章节。审核结论
要求独立的 PASS/FAIL 首行与依据行，格式不符也进入人工复核。摘要和模型
审核不能保证发现所有设定冲突；编辑应对照完整设定与成稿最终验收。
设定检索由 LangChain 文本切分、jieba 分词与 BM25 排序实现。
已保存的设定更新会增加版本号，批次持有提交时的快照。
模型审核 `FAIL` 时暂停后续章节，等待人工通过或退回；退回的旧成稿保留在
`revisions` 中。前章退回后，下游已产出的章节会标记 `staleContext`，
无法直接人工通过，须退回重新生成。A/B Prompt 策略可以自动交替分配或固定
选择，接口按人工审核结果分别记录通过数，不把模型审核计为人工通过。

调研节点可以调用当前批次的 IP 设定查询工具；配置 `BRAVE_SEARCH_API_KEY` 后
才会启用联网搜索。模型请求统一通过 `LLMRouter`：优先 `AI_TEXT_PROVIDER`，
可用时切换另一模型；共享连接池、并发上限、每模型每分钟请求窗口（`IP_LLM_RPM`，
默认 60；Redis 模式跨进程共享）、超时和短时熔断。模型密钥仍通过
`AGNES_API_KEY` / `MODELSCOPE_API_TOKEN` 配置。

设置 `IP_REDIS_URL=redis://127.0.0.1:6379/0` 启用 Redis 任务状态和 LangGraph
官方 Redis checkpointer。**此配置要求 Redis Stack 或启用了 RedisJSON + RediSearch 的
Redis 实例**；启动时会检查连接与索引，失败即报错。Redis 模式在有序集合中
持久排队、用续租锁跨实例认领、启动时扫描未完成批次；worker 进程异常退出后，
任务仍在队列中，锁租期（最长 120 秒）到期后会由存活实例继续领取。失败
章节保留最后的 LangGraph 检查点，经重试接口重新排队。任务元数据保留 7 天，
检查点持久性由 Redis 配置决定；Redis 必须配置持久化与备份，否则 Redis
自身故障仍可能丢失任务。**模型请求是至少一次执行**：如果进程恰好在模型
返回后、检查点写入前退出，恢复时可能再次调用模型并产生费用。

本地 Redis Stack 示例（需要 Docker Desktop 已启动）：

```powershell
docker compose -f infra/redis-stack.compose.yml up -d
$env:IP_REDIS_URL = "redis://127.0.0.1:6379/0"
npm run dev:orchestrator
```

示例只绑定 `127.0.0.1:6379`，开启 AOF 和快照持久化；生产环境另需认证、
监控、备份与故障切换。多实例共享任务和限流计数，但实际可承载批次数仍需压测。

未配置 Redis 时使用进程内状态、MemorySaver 与 FastAPI BackgroundTasks，
只适合本地体验，重启后不能续传。当前项目尚未提供登录、租户隔离和编辑者身份
校验；不要把上述 API 直接暴露给不可信网络，生产部署须先接入鉴权。

可从工作台提交最多 50 章节的批次，但“50+ 并发批次”、Token 节省 28%、TTFT
降低 35%、成功率/通过率及零宕机等数字是目标陈述，不是当前实现的实测结果。
要验证这些指标需要固定样本、模型、并发负载、人工评分规则与 A/B 基线。当前
运行环境没有可用的 Redis Stack，Redis 实例上的索引初始化、故障恢复与并发压测
尚未在真实服务上验收；测试使用模拟队列验证了重领和 LangGraph 断点恢复。

业务验收应使用经授权的真实 IP 设定和连续章节任务：记录人工从接稿到可用稿的
耗时、设定冲突的人工判定及返工次数；同批素材采用一致的质量标准对比原人工
流程。自动化测试验证了早期章节线索会传递给后续章节、无效模型审核不能自动
通过、长批次上下文不足会要求人工复核，但不能替代真实编辑的质量评估。

```powershell
cd apps/ai-orchestrator
python -m unittest discover -s tests -p 'test_*.py' -q
```
