"""
make_figures.py
===============
Publication-style figures for the report, produced from the analysis data:

  Figure 1 (argument_structure):  networkx DAG of the supplied argument --
      premises -> intermediate conclusions -> final claim.
  Figure 2 (evidence_taxonomy):   bar chart of the epistemic categories in
      the supplied evidence (definitional / empirical / metaphysical /
      axiological).
  Figure 3 (unity_schematic):     conceptual two-panel illustration of the
      proposition: (a) the nucleus as a locus of structure, (b) the thesis
      that cosmic order and human ethics co-originate from the same intrinsic
      moral force, i.e. matter and spirit as one continuum of meaning.

All figures are written to outputs/ as PNG (300 dpi) and PDF.
"""

import os, json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT  = os.path.join(ROOT, "outputs")
os.makedirs(OUT, exist_ok=True)

# ---- shared styling -----------------------------------------------------
plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 10,
    "axes.titlesize": 11,
    "figure.dpi": 150,
})

def save(fig, name):
    for ext in ("png", "pdf"):
        fig.savefig(os.path.join(OUT, f"{name}.{ext}"), dpi=300,
                    bbox_inches="tight", facecolor="white")
    print(f"wrote {name}.png / {name}.pdf")

# ---- Figure 1: argument structure DAG -----------------------------------
import networkx as nx

G = nx.DiGraph()
# premise nodes (left)
premises = {
    "P1": "Nucleus is a\nfundamental unit",
    "P2": "Nucleus has\nphysical props",
    "P3": "Nucleus has\nmoral energy",
    "P4": "Intrinsic,\nnot imposed",
    "P5": "Intrinsic to\nmaterial world",
    "P6": "Cosmic order\n<-- moral force",
    "P7": "Ethics\n<-- moral force",
    "P9": "Nuclear study reveals\nmatter-spirit unity",
}
middle = {
    "M1": "Moral force is an intrinsic\nproperty of matter (i)",
    "M2": "Order & ethics share\none foundation (o ^ e)",
    "M3": "Matter and spirit are one\nreality (u)",
}
claim  = {"CLAIM": "Nucleus contains an intrinsic moral\nforce; origin of cosmic order\nand human ethics"}

for k, lab in {**premises, **middle, **claim}.items():
    G.add_node(k, label=lab, layer=("P" if k[0]=="P" else
                                    ("M" if k.startswith("M") else "C")))

# premise -> intermediate edges
edges = [
    ("P3", "M1"), ("P4", "M1"), ("P5", "M1"),
    ("P6", "M2"), ("P7", "M2"),
    ("P9", "M3"),
    ("M1", "CLAIM"), ("M2", "CLAIM"), ("M3", "CLAIM"),
]
G.add_edges_from(edges)

pos = nx.multipartite_layout(G, subset_key="layer",
                             align="horizontal", scale=3.0)
# manual vertical nudge for readability
pos = {k: (x, y) for k, (x, y) in pos.items()}

fig, ax = plt.subplots(figsize=(11, 6.2))
colors = {"P": "#7f9cbb", "M": "#7fb285", "C": "#d9a441"}
for n, d in G.nodes(data=True):
    nx.draw_networkx_nodes(G, pos, nodelist=[n], node_color=colors[d["layer"]],
                           node_size=2600, node_shape="s", ax=ax)
    ax.text(*pos[n], d["label"], ha="center", va="center", fontsize=8.6,
            fontweight="bold", color="white")
nx.draw_networkx_edges(G, pos, ax=ax, arrows=True, arrowsize=16,
                       edge_color="#555555", width=1.4,
                       connectionstyle="arc3,rad=0.08", min_source_margin=34,
                       min_target_margin=34)
legend = [mpatches.Patch(color=colors[k], label={
    "P": "Premises (supplied evidence)",
    "M": "Intermediate conclusions",
    "C": "Final claim"}[k]) for k in ("P", "M", "C")]
ax.legend(handles=legend, loc="upper left", frameon=False, fontsize=9)
ax.set_title("Figure 1. Argument structure of the supplied proposition "
             "(premises -> intermediate conclusions -> claim)")
ax.axis("off")
save(fig, "argument_structure")
plt.close(fig)

# ---- Figure 2: evidence taxonomy ----------------------------------------
cats = ["definitional", "empirical", "metaphysical", "axiological"]
counts = [1, 1, 8, 1]          # from analysis (P-categories)
colors2 = ["#8fa8c8", "#7fb285", "#c98a8a", "#d9a441"]
fig, ax = plt.subplots(figsize=(8.2, 4.6))
bars = ax.bar(cats, counts, color=colors2, edgecolor="white", linewidth=1.2)
for b, c in zip(bars, counts):
    ax.text(b.get_x() + b.get_width()/2, b.get_height() + 0.1, str(c),
            ha="center", va="bottom", fontsize=11, fontweight="bold")
ax.set_ylabel("Number of supplied propositions")
ax.set_ylim(0, 9.5)
ax.set_title("Figure 2. Epistemic composition of the supplied evidence")
ax.spines[["top", "right"]].set_visible(False)
ax.annotate("", xy=(-0.5, 0), xytext=(-0.5, 0))
save(fig, "evidence_taxonomy")
plt.close(fig)

# ---- Figure 3: unity schematic ------------------------------------------
fig, axes = plt.subplots(1, 2, figsize=(11.5, 4.8))

# panel (a): the nucleus as locus of physical structure
ax = axes[0]
ax.set_xlim(0, 10); ax.set_ylim(0, 10); ax.set_aspect("equal"); ax.axis("off")
ax.add_patch(mpatches.Circle((5, 5), 3.4, fill=True, facecolor="#dfeaf6",
                             edgecolor="#4a6b8a", linewidth=1.6, alpha=0.5))
for i, (dx, dy, r) in enumerate([(5.0, 5.0, 1.1), (3.9, 4.4, 0.7),
                                 (6.1, 4.6, 0.7), (4.4, 6.1, 0.6),
                                 (5.8, 6.2, 0.6), (5.0, 3.4, 0.5)]):
    ax.add_patch(mpatches.Circle((dx, dy), r, facecolor="#c0392b", alpha=0.72,
                                 edgecolor="black", linewidth=0.6))
ax.text(5, 9.1, "nucleus: charge, mass,\nspin, isospin, ...",
        ha="center", va="top", fontsize=10, fontweight="bold", color="#4a4a4a")
ax.text(5, 0.6, "(a) Physical structure is measurable &\nwell understood",
        ha="center", va="bottom", fontsize=9, style="italic", color="#666666")

# panel (b): matter/spirit continuum under the thesis
ax = axes[1]
ax.set_xlim(0, 10); ax.set_ylim(0, 10); ax.axis("off")
ax.annotate("", xy=(5, 8.6), xytext=(5, 1.4),
            arrowprops=dict(arrowstyle="<->", color="#4a6b8a", lw=2))
for yy, lab, col in [(8.0, "intrinsic moral force", "#a15b8c"),
                     (6.2, "cosmic order (natural law)", "#2e7d6b"),
                     (4.4, "human ethics (moral law)", "#b8860b"),
                     (2.6, "psychophysical unity of reality", "#7f9cbb")]:
    ax.plot([4.0, 6.0], [yy, yy], color=col, lw=6, solid_capstyle="round")
    ax.text(5, yy, lab, ha="center", va="center", fontsize=9.6,
            color="white", fontweight="bold")
ax.text(5, 9.5, "one reality", ha="center", va="center", fontsize=10,
        fontweight="bold", color="#4a6b8a")
ax.text(5, 0.6, "(b) Thesis: order & ethics co-originate from one\nintrinsic moral force (matter-spirit continuum)",
        ha="center", va="bottom", fontsize=9, style="italic", color="#666666")

fig.suptitle("Figure 3. From measurable structure (a) to the moral-force thesis (b)",
             fontsize=11, y=1.02)
fig.tight_layout()
save(fig, "unity_schematic")
plt.close(fig)

print("figures done")