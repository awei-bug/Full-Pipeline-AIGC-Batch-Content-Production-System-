"""多智能体协作层：角色 Agent + Supervisor 编排。

这一层把原本线性的「调研→撰写→润色→审核」链路，升级为带共享记忆、
跨 agent 消息传递、以及自主自我修正闭环的协作系统。状态字段全部保持
JSON 可序列化，以兼容 MemorySaver 与 Redis checkpointer。
"""
