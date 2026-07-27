# 无 Embedding 的 LLM 辅助检索架构

通过离线生成可检索的文本描述、在线多查询 FTS 召回、LLM 重排和独立证据复核，在不生成向量的情况下实现接近语义检索的文献问答流程。

```mermaid
flowchart LR
    subgraph ingest["离线入库：一次生成，可重复检索"]
        direction TB
        pdf["PDF / 网页 / 补充材料"]
        parse["LiteParse 解析<br/>页面、章节、图表、OCR、引用"]
        normalize["规范化证据单元<br/>document / page / chunk / asset"]
        sourceFts[("原文 FTS5<br/>正文、标题、caption、OCR")]
        descriptors["LLM 检索卡生成<br/>概念、别名、缩写、可能问题、跨语言术语"]
        generatedFts[("扩展 FTS5<br/>检索卡与实体别名")]
        graph[("关系与元数据索引<br/>作者、年份、引用、章节、实体")]
        assets[("原始证据存储<br/>文本、页图、图表、content hash")]

        pdf --> parse --> normalize
        normalize --> sourceFts
        normalize --> descriptors --> generatedFts
        normalize --> graph
        normalize --> assets
    end

    subgraph online["在线检索：不扫描全库"]
        direction TB
        question["用户问题"]
        planner["快速 LLM 查询规划<br/>实体、同义词、英文术语、子问题、过滤条件"]
        recall["并行多路召回<br/>原文 / 扩展词 / metadata / 引用关系"]
        merge["候选合并与去重<br/>RRF + 字段权重 + 文档多样性"]
        snippets["证据压缩<br/>只提取命中窗口、标题、caption 和页号"]
        rerank["快速 LLM 分批重排<br/>相关 / 部分相关 / 不相关"]
        evidence["读取 Top 5–8 原始证据<br/>必要时加载页面截图"]
        executor["Executor 引用约束回答"]
        reviewer{"独立 Reviewer<br/>证据充分且引用正确？"}
        gap["生成缺口查询<br/>最多追加一轮召回"]
        final["可引用回答<br/>paper id + page + quote / asset"]

        question --> planner --> recall --> merge --> snippets --> rerank --> evidence --> executor --> reviewer
        reviewer -->|"通过"| final
        reviewer -->|"证据不足"| gap --> recall
    end

    sourceFts --> recall
    generatedFts --> recall
    graph --> recall
    assets --> evidence

    classDef input fill:#D1FAE5,stroke:#10B981,color:#064E3B,stroke-width:2px;
    classDef index fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A,stroke-width:2px;
    classDef llm fill:#EDE9FE,stroke:#7C3AED,color:#4C1D95,stroke-width:2px;
    classDef evidence fill:#FFEDD5,stroke:#EA580C,color:#7C2D12,stroke-width:2px;
    classDef decision fill:#FEF3C7,stroke:#D97706,color:#78350F,stroke-width:2px;

    class pdf,question input;
    class sourceFts,generatedFts,graph index;
    class descriptors,planner,rerank,executor,gap llm;
    class normalize,assets,evidence,final evidence;
    class reviewer decision;
```
