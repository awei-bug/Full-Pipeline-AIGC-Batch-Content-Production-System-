# 多智能体协作层 · 设计与定位

> 面向面试与复盘：讲清楚「我们做的是 agent 还是 workflow、agent 成分落在哪、为什么不做全自主」。

## 1. 定位：agentic workflow，不是全自主 agent

内容生成主链路（调研 → 撰写 → 润色 → 审核）由 LangGraph 编排的 **Supervisor + 四角色 Agent** 协作完成。
按 Anthropic 对 agent 的严格定义（控制流由 LLM 在运行期动态决定才算 agent），本项目的**控制流由 `route_next`（纯函数）+ 图结构固定**，因此归类为 **agentic workflow（受监督的多步协作）** 更准确。

刻意不做「全自主 agent」的原因（产品视角，也是面试加分点）：

- 内容生成要的是**稳定、可复现、可评估**的产出；全自主 agent 会引入结果漂移、成本不可控、行为不可预测——这是内容业务的反模式。
- 我们把 agentic 能力用在**最该用的地方**：工具自主调用、审核失败自主改写闭环、运行期条件化规划；而**全局控制流仍由 Supervisor 约束**，保证确定性。

行业口径佐证：Gartner 调研显示多数所谓 agentic 部署仍停留在「受监督」阶段（对应其成熟度路线图 Stage 3），本项目正好落在这个区间。

## 2. agent 成分落在哪（已做实的三处）

### 2.1 多轮工具循环（`app/agents/_llm.py` 的 `call_stage`）
模型可在一轮内多次发起工具调用，并在拿到工具结果后**继续推理**，直到产出最终正文（上限 5 轮防失控）。这正是「agentic」与「一次性提示词链路」的本质区别——而不是把工具结果塞进 prompt 的伪工具。

### 2.2 角色工具自主（`app/agents/roles.py`）
四个角色不再由代码预填设定检索结果，而是把 IP 设定库作为 `query_ip_lore` 工具交给模型**自主选择何时调用**：
- `ResearcherAgent`：持有 `query_ip_lore` + `web_search`，自主检索世界观设定；
- `WriterAgent` / `EditorAgent` / `CriticAgent`：均持有 `query_ip_lore`，按需核对官方设定。
- 工具调用全程写入 `agentTrace`（见 §4），可观测。

### 2.3 条件化编排（可选 planning，`app/agents/team.py`）
`build_team(enable_planning=True)` 时，Supervisor 在运行期生成 `plan`（如「无设定库可查则跳过调研员」），`route_next` 尊重该 plan 跳过不必要的步骤——打破了「永远固定四步」的硬编排。
**默认关闭**：保持四步全跑、可复现、测试稳定。开启方式见 §5。

### 2.4 评测层与 critic 打通（`app/agents/roles.py` + `app/evaluation/score.py`）
`CriticAgent` 在给出 PASS/FAIL 前，调用确定性的 `evaluate_chapter` 拿到
`lore_consistency / constraint_compliance / readability / length` 指标，作为审核的**客观证据**写入 trace，也让反馈有结构化依据，而非纯拍脑袋。

## 3. 质量闭环（核心卖点）

```
Critic FAIL ──feedback──▶ Supervisor ──▶ Writer 改写 ──▶ Editor 润色 ──▶ Critic
   │                                                                          │
   │ 达到 max_revisions 仍不过                                                ▼
   └────────────────────────▶ needsHumanReview（升级人工接管，安全网）
```

- 自修正有上限（`max_self_revisions`，默认 3），避免死循环；
- 人工接管是最后一道安全网：审核未过、安全巡检拦截（`safetyHold`）、或前文已变更都可能触发 `needsHumanReview`；
- 这与「半自动优于全自动」的工程判断一致：AI 生成走草稿态，人工保留最终判断权。

## 4. 可观测性（让协作从黑盒变透明）

每次运行产生三类记录，前端「协作轨迹」面板直接展示：

| 字段 | 内容 |
|------|------|
| `agentTrace` | 每一步的 `role` / `action` / `tool_calls`（工具名与成败）/ `eval`（评测指标）/ `plan`（规划决策） |
| `agentMessages` | 跨角色消息，例如 `critic → writer` 的审核反馈 |
| `needsHumanReview` | 布尔；前端显式提示「已转入人工接管流程」 |

## 5. 如何开启 planning

```python
# 服务层（默认关闭，保持确定性）
IPContentService(router, enable_agent_team=True, enable_planning=True)

# 或在构造处按环境变量传入 AGENT_PLANNING=1（由你的 config 读取后传入）
```

开启后，无设定库（lore 为空）的章节会跳过调研员，直接进入撰写——这正是「受监督的条件化」而非写死流程。

## 6. 面试 elevator pitch（可直接用）

> 我们用 LangGraph 把内容生成做成**受监督的多角色 agentic workflow**：一个 Supervisor 协调调研 / 撰写 / 润色 / 审核四个角色 Agent，每个角色拥有工具（查询 IP 设定库）并自主决定何时调用；审核不通过时，Supervisor 会把结构化反馈自动交还撰写 Agent 改写，超上限则转人工接管。
> 我们**刻意不做全自主 agent**——内容业务要确定性、可复现、可评估，所以把 agentic 用在工具调用和质量闭环上，而全局控制流仍由 Supervisor 约束。这样既拿到了多角色协作的质量保障，又守住了可控性。

## 7. 关键文件索引

- `app/agents/protocol.py`：AgentRole / AgentMessage / AgentOutput
- `app/agents/_llm.py`：`call_stage`（多轮工具循环 + usage 累加 + 退避重试）
- `app/agents/roles.py`：四角色 Agent（工具自主、critic 评测打通）
- `app/agents/team.py`：`route_next`（Supervisor 路由）/ `make_plan`（条件化规划）/ `build_team`
- `app/agents/prompts.py`：角色 system 提示词注册表（要求模型调工具）
- `app/evaluation/score.py`：确定性多维评分（与 critic 打通）
- `app/ip_content/service.py`：接入 `build_team`、返回 `agentTrace / agentMessages / needsHumanReview`
