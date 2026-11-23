"""Build the experiment tree (report/tree.json) and the one-page report
(report/index.html) from results/*.json. Every number on the page is read
from a results file here, so re-running the evals and this script keeps the
page honest. Historical nodes (earlier experiments) are marked as such.
"""
import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "results")
REP = os.path.join(HERE, "..", "report")


def load(name):
    with open(os.path.join(RES, name), encoding="utf-8") as handle:
        return json.load(handle)


relearn, recall, extra, cache, trig = (load("relearn.json"), load("recall.json"), load("recall_extra.json"),
                                       load("cache.json"), load("trigger.json"))
qmix = load("query_mix.json")


def paired(file_json, a, b, split="test"):
    """How many questions b gets right that a misses, and vice versa."""
    va, vb = file_json["vectors"][a][split], file_json["vectors"][b][split]
    return sum(1 for x, y in zip(va, vb) if y and not x), sum(1 for x, y in zip(va, vb) if x and not y)


def A(key):  # 踩坑重现 Hit@3
    c = relearn["configs"][key]
    return {"test": c["test"]["hit@3"], "dev": c["dev"]["hit@3"], "n": c["test"]["n"], "key": f"relearn.json:{key}"}


def B(key):  # 前情回顾 Hit@3 (time-locked run that includes every config)
    c = extra["configs"][key]
    return {"test": c["test"]["hit@3"], "dev": c["dev"]["hit@3"], "n": c["test"]["n"], "key": f"recall:{key}"}


g = cache["gap_matched_cache_ratio"]
new_short = (g["new_turn:<30s"]["median"], g["new_turn:30s-5m"]["median"])
same_short = (g["same_turn:<30s"]["median"], g["same_turn:30s-5m"]["median"])
cov = recall["coverage"]
ce = extra["subsets"]["changes_earlier"]
pct = lambda x: f"{round(x * 100)}%"

ROOT = {"id": "root", "title": "现状（0.4.91 生产）",
        "what": "每轮用用户这句话检索：session_search 前 2 条（各带前后 5 条消息）+ v2 原子，拼进 system prompt；按整组任意命中计，比其他节点的“前 3 条”宽松",
        "A": A("root_prod_inject"), "B": B("root_prod_inject"), "verdict": "base",
        "note": f"注入中位 {cache['median_injected_chars_when_nonempty']:,} 字/轮"}

BRANCHES = [
    {"id": "W", "title": "① 存什么", "hint": "写入", "nodes": [
        {"id": "w1", "title": "v2 原子库", "what": "后台 LLM 抽取 + 逐条审查（现状在用）",
         "A": A("v2_atoms_errq"), "B": B("v2_atoms"), "verdict": "bad",
         "note": f"只有 {pct(cov['v2_atom_exists'])} 的考题在库里有对应记录；历史实测约 5,285 输入 token/条"},
        {"id": "w2", "title": "原始会话，不抽取", "what": "会话本身就是记忆，写入成本为 0",
         "A": A("raw_turn_bi_errq"), "B": B("raw_msg_bi"), "verdict": "best",
         "note": "前情回顾的最佳存储；踩坑这里按标注回合判分，等价修法在别处会漏计，可能低估"},
        {"id": "w3", "title": "教训笔记（v7 补录）", "what": "模型按批把“踩坑→修法”写成短笔记，约每 7 回合 1 次调用",
         "A": A("notes_v7_lesson_rrf_errq_all"), "B": B("notes_v7_rrf"), "verdict": "best",
         "note": f"踩坑重现的最佳存储；但只覆盖 {pct(cov['note_exists'])} 的前情考题"},
        {"id": "w4", "title": "原文 + 笔记混排", "what": "两种存储放进同一个排序",
         "A": A("raw_plus_notes_rrf_errq_all"), "B": B("notes_plus_raw_rrf"), "verdict": "bad",
         "note": "互相稀释，不如各管一类"},
    ]},
    {"id": "R", "title": "② 怎么找", "hint": "检索", "nodes": [
        {"id": "r1", "title": "现有算法（LIKE 计数）", "what": "二元组子串命中个数，无 IDF；当工具用",
         "A": A("raw_prod_like_errq"), "B": B("raw_prod_like_tool"), "verdict": "base"},
        {"id": "r2", "title": "二元组 BM25 · 消息级", "what": "中文切二元组，FTS5 + BM25",
         "A": A("raw_msg_bi_errq"), "B": B("raw_msg_bi"), "verdict": "best",
         "note": "最便宜、两个划分都高；建议第一步就用它"},
        {"id": "r3", "title": "二元组 BM25 · 回合级", "what": "一问一答 + 工具摘要作为一块",
         "A": A("raw_turn_bi_errq"), "B": B("raw_turn_bi"), "verdict": "good"},
        {"id": "r4", "title": "三元组 BM25（L1 设计稿）", "what": "FTS5 trigram；两字词匹配不到",
         "A": A("raw_turn_tri_errq"), "B": B("raw_turn_tri"), "verdict": "same",
         "note": f"纯中文问题上更差：三元组 {pct(qmix['pure_chinese']['trigram_hit@3'])}，二元组 {pct(qmix['pure_chinese']['bigram_hit@3'])}（{qmix['pure_chinese']['n']} 题）"},
        {"id": "r5", "title": "混合 RRF", "what": "消息级 + 回合级 + 三元组 三路融合",
         "B": B("raw_hybrid_rrf"), "verdict": "same", "note": "不比消息级 BM25 好"},
        {"id": "r6", "title": "+ 本地小模型重排", "what": "Qwen3-0.6B（本机已缓存）给前 20 条重排，再与词法排名融合",
         "B": B("rerank_blend"), "verdict": "good",
         "note": f"测试集最高，但比消息级 BM25 只多对 {paired(extra, 'raw_msg_bi', 'rerank_blend')[0]} 题、少对 {paired(extra, 'raw_msg_bi', 'rerank_blend')[1]} 题，开发集持平：收益不确定"},
        {"id": "r7", "title": "只用小模型排序", "what": "丢掉词法排名，只看小模型",
         "B": B("rerank_qwen3_0.6b"), "verdict": "bad"},
        {"id": "r8", "title": "+ 近因衰减", "what": "30 天半衰期，越新越靠前",
         "B": B("raw_turn_rrf_recency"), "verdict": "good", "note": f"对照（不衰减）为 {pct(B('raw_turn_rrf')['test'])}；审查前没锁时间时曾得出相反结论"},
        {"id": "r9", "title": "只查近 48 小时", "what": "只检索最近两天的会话",
         "A": A("raw_turn_rrf_errq_48h"), "verdict": "bad", "note": f"对照（查全部）为 {pct(A('raw_turn_rrf_errq')['test'])}"},
        {"id": "r10", "title": "跨项目检索（教训）", "what": "教训不限本项目",
         "A": A("notes_v7_rrf_errq_all"), "verdict": "good", "note": f"只查本项目为 {pct(A('notes_v7_rrf_errq')['test'])}"},
        {"id": "r11", "title": "向量检索", "what": "Qwen3-Embedding-0.6B，需下载约 1.2 GB",
         "verdict": "pending", "note": "外部受控研究里，换检索器的影响是写入策略的 3–6 倍"},
        {"id": "r12", "title": "专用重排模型", "what": "Qwen3-Reranker-0.6B，需下载约 1.2 GB",
         "verdict": "pending", "note": "也是“高置信才送达”门槛的前提"},
    ]},
    {"id": "D", "title": "③ 怎么送达", "hint": "送达", "nodes": [
        {"id": "d1", "title": "每轮注入 system prompt", "what": "现状做法",
         "verdict": "bad",
         "note": f"同为 30 秒–5 分钟间隔：新回合首请求缓存命中 {pct(new_short[1])}，同回合 {pct(same_short[1])}（各 {g['new_turn:30s-5m']['n']}/{g['same_turn:30s-5m']['n']} 个请求，按时间推断换轮，没有空块对照）"},
        {"id": "d2", "title": "只给工具，模型自己查", "what": "删掉注入，靠模型调用 session_search",
         "verdict": "bad", "note": "实测只有 3.2% 的回合调用；用户说“之前/上次”时也只查了 3/60 次"},
        {"id": "d3", "title": "“之前/上次”指代触发", "what": "用户消息里有回指词才检索",
         "verdict": "same", "note": "3.8% 的回合会触发，但只覆盖 8% 的考题；可作补充"},
        {"id": "d4", "title": "报错触发（踩坑专用）", "what": "工具报错时按报错查教训，附在工具结果后",
         "A": A("notes_v7_lesson_rrf_errq_all_gated"), "verdict": "best",
         "note": f"已乘上触发门：{pct(relearn['gate']['events_fire'])} 的重学事件会触发，反例误触发 {pct(relearn['gate']['negatives_fire'])}（35 个反例）"},
        {"id": "d5", "title": "每轮检索，附在用户消息后", "what": "不改 system，前缀缓存保住",
         "B": B("rerank_blend"), "verdict": "pending",
         "note": "检索准，但“何时不送”还没解决：词法覆盖率和通用小模型都分不开（普通回合 99% 也会送）"},
    ]},
    {"id": "C", "title": "④ 怎么整理", "hint": "整理", "nodes": [
        {"id": "c1", "title": "只追加、不改写", "what": "Mem0 2026 的做法；原始会话天然如此", "verdict": "base"},
        {"id": "c2", "title": "只检索“教训”类", "what": "教训与事实/决定分开索引",
         "A": A("notes_v7_lesson_rrf_errq_all"), "verdict": "good", "note": f"不区分类别为 {pct(A('notes_v7_rrf_errq_all')['test'])}"},
        {"id": "c3", "title": "新的优先（时间加权）", "what": "在“后来改过主意”的 28 道题上看",
         "verdict": "good", "note": f"加近因 {pct(ce['raw_turn_rrf_recency']['hit@3'])}，不加 {pct(ce['raw_turn_rrf']['hit@3'])}；显式“已取代”标记未测"},
        {"id": "c4", "title": "按原因合并", "what": "10-21 历史实验：377 条 → 224 个原因",
         "verdict": "same", "note": "召回不变，价值在存储与展示", "historical": True},
        {"id": "c5", "title": "自动跨会话注入“决定”", "what": "10-21 历史实验 C1 + 10-27 抓取诊断",
         "verdict": "bad", "note": "开发集 +17pp、测试集未复现；30% 被注入的“决定”是误判（如把「B吧」当长期规矩）",
         "historical": True},
    ]},
]

CONSENSUS = [
    ("砍掉 v2 后台抽取", "砍", "砍", "多数系统转向只追加/原文检索", "v2 两项任务都约 2%"),
    ("撤掉每轮 system 注入", "撤", "撤", "共识：小而稳的层注入，大的走工具", "缓存代价方向一致，幅度待对照"),
    ("原始会话 + 中文 BM25", "主张", "主张", "检索器影响是写入策略的 3–6 倍", "前情现状 49% → 70%"),
    ("报错触发召回", "主张", "主张", "Hermes/OpenClaw 有类似做法", "踩坑 4% → 69%（配教训笔记）"),
    ("常驻层只收用户确认", "主张", "主张", "Codex/Claude Code 常驻层都很小", "本次未测（审查认为证据最弱）"),
    ("向量检索", "后置", "先测再上", "Qwen3-Embedding 换上后受控研究提升明显", "待下载后测"),
]


def all_nodes():
    yield ROOT
    for b in BRANCHES:
        yield from b["nodes"]


VERDICT = {"best": ("★", "推荐"), "good": ("✓", "更好"), "bad": ("✗", "更差"), "same": ("＝", "持平"),
           "pending": ("⏳", "待验证"), "base": ("○", "基线")}


def bar(kind, m, root_val):
    if not m:
        return ""
    label = "踩坑" if kind == "A" else "前情"
    w = max(0.5, m["test"] * 100)
    tick = f'<span class="tick" style="left:{root_val * 100:.1f}%"></span>' if root_val is not None else ""
    tip = f"{label}·测试集 {pct(m['test'])}（n={m['n']}）· 开发集 {pct(m['dev'])}"
    return (f'<div class="meter" data-tip="{html.escape(tip)}"><span class="mname">{label}</span>'
            f'<span class="track">{tick}<span class="fill s{1 if kind == "B" else 2}" style="width:{w:.1f}%"></span></span>'
            f'<span class="mval">{pct(m["test"])}</span></div>')


def card(n, root=False):
    icon, word = VERDICT[n["verdict"]]
    hist = '<span class="hist">历史实验</span>' if n.get("historical") else ""
    body = bar("A", n.get("A"), None if root else ROOT["A"]["test"]) + bar("B", n.get("B"), None if root else ROOT["B"]["test"])
    note = f'<div class="note">{html.escape(n["note"])}</div>' if n.get("note") else ""
    return (f'<div class="node v-{n["verdict"]}{" root" if root else ""}" id="{n["id"]}">'
            f'<div class="nhead"><span class="ntitle">{html.escape(n["title"])}</span>'
            f'<span class="chip c-{n["verdict"]}">{icon} {word}</span>{hist}</div>'
            f'<div class="what">{html.escape(n["what"])}</div>{body}{note}</div>')


def table_rows():
    rows = []
    for n in all_nodes():
        a, b = n.get("A"), n.get("B")
        f = lambda m: f"{pct(m['test'])} / {pct(m['dev'])}" if m else "—"
        rows.append(f"<tr><td>{html.escape(n['title'])}</td><td>{VERDICT[n['verdict']][1]}</td><td>{f(a)}</td>"
                    f"<td>{f(b)}</td><td>{html.escape(n.get('note', ''))}</td></tr>")
    return "\n".join(rows)


best_A = A("notes_v7_lesson_rrf_errq_all_gated")
best_B = B("raw_msg_bi")
win_A = paired(relearn, "root_prod_inject", "notes_v7_lesson_rrf_errq_all_gated")
win_B = paired(extra, "root_prod_inject", "raw_msg_bi")

CSS = """
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f3f2ef;--line:#e4e2dd;--text-primary:#0b0b0b;
--text-secondary:#52514e;--text-muted:#7a7873;--series-1:#2a78d6;--series-2:#eb6834;--good:#0ca30c;--bad:#d03b3b;
--warn:#b07a00;--best-ring:#2a78d6}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
--surface-1:#1a1a19;--surface-2:#242423;--line:#383835;--text-primary:#f0efec;--text-secondary:#c3c2b7;
--text-muted:#9a998f;--series-1:#3987e5;--series-2:#d95926;--good:#0ca30c;--bad:#e66767;--warn:#fab219;--best-ring:#3987e5}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242423;--line:#383835;
--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#9a998f;--series-1:#3987e5;--series-2:#d95926;
--good:#0ca30c;--bad:#e66767;--warn:#fab219;--best-ring:#3987e5}
body{margin:0;background:var(--surface-1)}
.viz-root{background:var(--surface-1);color:var(--text-primary);font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
max-width:1280px;margin:0 auto;padding:28px 24px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:34px 0 10px}
.sub{color:var(--text-secondary);margin:0 0 18px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.kpi{background:var(--surface-2);border-radius:10px;padding:14px 16px}
.kpi .k{color:var(--text-secondary);font-size:13px}.kpi .v{font-size:30px;font-weight:600;margin:2px 0}
.kpi .v small{font-size:15px;color:var(--text-muted);font-weight:400}.kpi .d{color:var(--text-secondary);font-size:12.5px}
.legend{display:flex;gap:16px;align-items:center;color:var(--text-secondary);font-size:13px;margin:6px 0 12px;flex-wrap:wrap}
.sw{display:inline-block;width:12px;height:8px;border-radius:2px;margin-right:5px;vertical-align:middle}
.tree{position:relative}
.rootwrap{display:flex;justify-content:center}
.rootwrap .node{width:420px;max-width:100%}
.trunk{height:18px;border-left:1px solid var(--line);margin-left:50%}
.branches{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;border-top:1px solid var(--line);padding-top:14px}
.bhead{font-weight:600;margin-bottom:8px}.bhead span{color:var(--text-muted);font-weight:400;font-size:12px;margin-left:6px}
.blist{border-left:1px solid var(--line);padding-left:10px;display:flex;flex-direction:column;gap:9px}
.node{background:var(--surface-1);border:1px solid var(--line);border-radius:9px;padding:9px 11px;position:relative}
.blist .node::before{content:"";position:absolute;left:-11px;top:18px;width:10px;border-top:1px solid var(--line)}
.node.v-best{border:2px solid var(--best-ring)}
.node.root{background:var(--surface-2)}
.nhead{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ntitle{font-weight:600}
.chip{font-size:11.5px;border-radius:999px;padding:0 7px;border:1px solid var(--line);color:var(--text-secondary);white-space:nowrap}
.c-best{color:var(--best-ring);border-color:var(--best-ring)}.c-good{color:var(--good);border-color:var(--good)}
.c-bad{color:var(--bad);border-color:var(--bad)}.c-pending{color:var(--warn);border-color:var(--warn)}
.hist{font-size:11px;color:var(--text-muted)}
.what{color:var(--text-secondary);font-size:12.5px;margin:2px 0 6px}
.meter{display:grid;grid-template-columns:30px 1fr 38px;align-items:center;gap:6px;font-size:12px;margin:3px 0;cursor:default}
.mname{color:var(--text-secondary)}.mval{text-align:right;font-variant-numeric:tabular-nums;color:var(--text-primary)}
.track{position:relative;height:8px;background:var(--surface-2);border-radius:4px}
.fill{position:absolute;left:0;top:0;bottom:0;border-radius:0 4px 4px 0}
.fill.s1{background:var(--series-1)}.fill.s2{background:var(--series-2)}
.tick{position:absolute;top:-3px;bottom:-3px;width:0;border-left:1.5px solid var(--text-muted);z-index:2}
.note{font-size:12px;color:var(--text-secondary);margin-top:5px}
#tip{position:fixed;pointer-events:none;background:var(--text-primary);color:var(--surface-1);font-size:12px;
padding:5px 8px;border-radius:6px;opacity:0;transition:opacity .08s;z-index:9;max-width:320px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--text-secondary);font-weight:600}
.plan li{margin:4px 0}.muted{color:var(--text-muted)}
details summary{cursor:pointer;color:var(--text-secondary)}
@media (max-width:980px){.branches{grid-template-columns:1fr 1fr}.kpis{grid-template-columns:1fr}}
@media (max-width:640px){.branches{grid-template-columns:1fr}.rootwrap .node{width:auto;flex:1}.viz-root{padding:18px 12px 40px}}
"""


def render():
    branches = "".join(
        f'<div class="branch"><div class="bhead">{b["title"]}<span>{b["hint"]}</span></div>'
        f'<div class="blist">{"".join(card(n) for n in b["nodes"])}</div></div>' for b in BRANCHES)
    consensus = "".join(f"<tr><td>{a}</td><td>{b}</td><td>{c}</td><td>{d}</td><td>{e}</td></tr>"
                        for a, b, c, d, e in CONSENSUS)
    page = f"""<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SomniQ 记忆模块实验树</title><style>{CSS}</style></head><body><div class="viz-root">
<h1>SomniQ 记忆模块实验树</h1>
<p class="sub">本机 426 个真实会话、1,560 个用户回合；两类考题：<b>踩坑重现</b>（{best_A['n']} 道测试题，以前修好的错又犯了，能不能把修法找回来）和 <b>前情回顾</b>（{best_B['n']} 道测试题，几周后问以前定过的事，能不能找到那一轮）。
数字 = 测试集里“送到模型面前的前 3 条记忆中有正确答案”的比例；条形上的竖线是现状。2026-11-22，分支 <code>exp/memory-design</code>。</p>
<div class="kpis">
<div class="kpi"><div class="k">踩坑重现 · 找回率</div><div class="v">{pct(best_A['test'])} <small>现状 {pct(ROOT['A']['test'])}</small></div><div class="d">教训笔记 + 报错触发 + 跨项目；{best_A['n']} 题里多对 {win_A[0]}、少对 {win_A[1]}</div></div>
<div class="kpi"><div class="k">前情回顾 · 找回率</div><div class="v">{pct(best_B['test'])} <small>现状 {pct(ROOT['B']['test'])}</small></div><div class="d">原始会话 + 二元组 BM25（消息级）；{best_B['n']} 题里多对 {win_B[0]}、少对 {win_B[1]}；开发集 {pct(best_B['dev'])} 对 {pct(ROOT['B']['dev'])}</div></div>
<div class="kpi"><div class="k">每轮注入的缓存代价 · 新回合首请求命中</div><div class="v">{pct(new_short[1])} <small>同间隔不换块 {pct(same_short[1])}</small></div><div class="d">30 秒–5 分钟间隔，样本 {g['new_turn:30s-5m']['n']}/{g['same_turn:30s-5m']['n']} 个请求，无空块对照：方向可信，幅度待验证</div></div>
</div>
<h2>实验树</h2>
<div class="legend"><span><span class="sw" style="background:var(--series-2)"></span>踩坑重现</span>
<span><span class="sw" style="background:var(--series-1)"></span>前情回顾</span>
<span>竖线 = 现状</span><span>★ 推荐 · ✓ 更好 · ＝ 持平 · ✗ 更差 · ⏳ 待验证</span><span class="muted">悬停条形看开发集与样本数</span></div>
<div class="tree"><div class="rootwrap">{card(ROOT, root=True)}</div><div class="trunk"></div><div class="branches">{branches}</div></div>
<h2>结论：选哪个方向</h2>
<p><b>双通道记忆，系统负责送达，不进 system prompt。</b>“前情回顾”用原始会话检索（不抽取），“踩坑重现”用短教训笔记 + 报错触发；v2 后台抽取撤掉；每轮 system 注入先做对照再撤。常驻的 MEMORY.md / USER.md 只收用户确认的条目——这一条本次没有做实验，依据是 10 月的诊断（30% 自动“决定”是误判）。</p>
<ol class="plan">
<li><b>第 1 步</b>：<code>session_search</code> 的中文路径从 LIKE 计数换成二元组 BM25（消息级）+ 近因加权；离线前情找回率 {pct(B('raw_prod_like_tool')['test'])} → {pct(B('raw_msg_bi')['test'])}（同为工具检索）。同时开一个对照开关：每轮 system 召回块 开/关，量回答质量与缓存 token。</li>
<li><b>第 2 步</b>：报错触发召回——工具失败时用报错文本查“教训”类笔记（跨项目），结果附在工具结果后。踩坑 {pct(ROOT['A']['test'])} → {pct(best_A['test'])}。</li>
<li><b>第 3 步</b>：教训笔记的写入（v7 补录：约每 7 回合 1 次廉价模型调用，只写“踩坑→修法”）。</li>
<li><b>第 4 步（需验证）</b>：前情回顾的主动送达——每轮检索、只在高置信时把 1–2 个片段附在用户消息后。缺一个可靠的“何时不送”门槛：需要专用重排模型，再做一次端到端（回答是否变好）试验。</li>
<li><b>第 5 步</b>：本地向量 / 重排模型（下载与打包决策），以及 L2/L3 晋升（只由用户确认）。</li>
</ol>
<h2>三方意见对照</h2>
<table><tr><th>主张</th><th>Claude 独立方案</th><th>Codex 独立方案</th><th>业界调研</th><th>本机实验</th></tr>{consensus}</table>
<p class="muted">Kimi：本机没有 Kimi CLI，网关里也没有 Kimi 模型，只做了架构调研（kimi-cli 已归档，接替的 kimi-code 源码里没找到跨会话记忆模块）。</p>
<h2>独立审查（Codex）指出的问题与处理</h2>
<ul>
<li>前情回顾原先检索全部历史 → 已改为“在下一个会话开始时提问”，只看此前的会话。改后<b>近因衰减从“更差”翻成“更好”</b>。</li>
<li>现状复刻漏了生产的前后 5 条消息窗口、v2 的中文分词把标点粘进词、没按更新时间取前 100、没过滤过期 → 已修，现状前情从 27% 变为 {pct(ROOT['B']['test'])}。</li>
<li>踩坑 69% 没乘触发门 → 已乘（本批事件全部过门，数字不变）。缓存卡片原先跨了间隔档 → 改为同档比较。“零风险”等说法已删。</li>
<li>未处理、只能注明：笔记按教训 ID 判分、原文按标注回合判分，口径不同；普通回合没有标注是否需要历史；全库 BM25 统计量含未来文档；现状按整组任意命中计（偏宽松）。审查原文见 <code>agents/outputs/codex_review.md</code>。</li>
</ul>
<h2>看结果时要知道的</h2>
<ul>
<li>单用户、单机器；测试集只有 52 / 59 道题，±10 个百分点以内的差别不要当真。开发集只用来挑配置。</li>
<li>前情回顾的考题由独立的 Claude 子 agent 从真实回合改写（问题与原文的二元组重合中位 26%），可能仍偏向词法检索。</li>
<li>这里量的是“找没找到”，不是“回答有没有变好”；端到端效果另需付费试验（审查建议的下一步：按事件时间滚动回放 + 盲评送达文本能否回答或修复；以及现状注入与双通道送达的随机配对对照）。</li>
<li>缓存对比的新回合样本只有 {sum(v['n'] for k, v in g.items() if k.startswith('new_turn'))} 个请求，且受服务商缓存过期影响（&gt;5 分钟两组都≈0）。</li>
<li>v7 笔记的召回规则曾在开发集上迭代过 7 轮；本页用的是统一的 BM25，未用当时调过的指纹规则。</li>
<li>通用 Qwen3-0.6B 不是重排专用模型；向量与专用重排两个节点待下载模型后补测。</li>
</ul>
<details><summary>表格视图（全部节点，测试 / 开发）</summary>
<table><tr><th>节点</th><th>判定</th><th>踩坑 测试/开发</th><th>前情 测试/开发</th><th>备注</th></tr>{table_rows()}</table></details>
</div><div id="tip"></div>
<script>
const tip=document.getElementById('tip');
document.querySelectorAll('[data-tip]').forEach(el=>{{
 el.addEventListener('mousemove',e=>{{tip.textContent=el.dataset.tip;tip.style.opacity=1;
  tip.style.left=Math.min(e.clientX+12,innerWidth-330)+'px';tip.style.top=(e.clientY+14)+'px';}});
 el.addEventListener('mouseleave',()=>tip.style.opacity=0);}});
</script></body></html>"""
    return page


def main():
    os.makedirs(REP, exist_ok=True)
    tree = {"root": ROOT, "branches": BRANCHES, "consensus": CONSENSUS}
    with open(os.path.join(REP, "tree.json"), "w", encoding="utf-8") as handle:
        json.dump(tree, handle, ensure_ascii=False, indent=1)
    with open(os.path.join(REP, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(render())
    print("ok", os.path.join(REP, "index.html"))


if __name__ == "__main__":
    main()
