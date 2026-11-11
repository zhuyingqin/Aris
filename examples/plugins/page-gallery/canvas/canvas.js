// Idea canvas. Drag the background to pan, a note to move it; double-click
// empty space for a new note; click one note then shift-click another to link.
(function () {
  const COPY = {
    en: { kinds: { idea: "Idea", question: "Question", evidence: "Evidence" }, hint: "Drag to pan · double-click to add · shift-click to link · Delete removes the selected note", fit: "Fit", ask: "Ask the agent to connect these", fresh: "New note",
      prompt: "Look at the notes on the Idea canvas panel (widget \"board\") and the project. Add the missing questions and evidence and link related notes, writing the result back with PluginPanel." },
    cn: { kinds: { idea: "想法", question: "问题", evidence: "证据" }, hint: "拖动画布平移 · 双击空白处新建 · Shift+点击连线 · Delete 删除选中的便签", fit: "适配视图", ask: "请 AI 把它们连起来", fresh: "新便签",
      prompt: "查看“想法画布”面板（组件 \"board\"）上的便签和这个项目，补上缺失的问题与证据，并把相关的便签连起来，用 PluginPanel 写回。" },
  };
  const KINDS = ["idea", "question", "evidence"];
  let copy = COPY.en, board = { notes: [], links: [] }, view = { x: 80, y: 80 }, selected = null, kind = "idea";
  const world = document.getElementById("world"), paths = document.getElementById("paths"), viewport = document.getElementById("viewport");
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const clean = (v) => {
    const notes = (v && Array.isArray(v.notes) ? v.notes : []).filter((n) => n && typeof n.text === "string").map((n, i) => ({
      id: String(n.id ?? "n" + i), text: n.text, kind: KINDS.includes(n.kind) ? n.kind : "idea", x: Number.isFinite(n.x) ? n.x : 40 + (i % 4) * 240, y: Number.isFinite(n.y) ? n.y : 40 + Math.floor(i / 4) * 170 }));
    const ids = new Set(notes.map((n) => n.id));
    const links = (v && Array.isArray(v.links) ? v.links : []).filter((l) => l && ids.has(String(l.from)) && ids.has(String(l.to))).map((l) => ({ from: String(l.from), to: String(l.to) }));
    return { notes, links };
  };
  const save = () => somniq.set("board", board).catch((e) => { document.getElementById("hint").textContent = e.message; });

  function wires() {
    const at = Object.fromEntries([...world.children].map((node) => [node.dataset.id, node]));
    paths.replaceChildren(...board.links.filter((l) => at[l.from] && at[l.to]).map((l) => {
      const a = at[l.from], b = at[l.to];
      const ax = view.x + a.offsetLeft + a.offsetWidth / 2, ay = view.y + a.offsetTop + a.offsetHeight / 2;
      const bx = view.x + b.offsetLeft + b.offsetWidth / 2, by = view.y + b.offsetTop + b.offsetHeight / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const mx = (ax + bx) / 2;
      // Stop the arrow at the target note's edge.
      const t = Math.min(1, 1 - Math.min(b.offsetWidth / 2 / Math.max(1, Math.abs(bx - ax)), b.offsetHeight / 2 / Math.max(1, Math.abs(by - ay))));
      const ex = ax + (bx - ax) * t, ey = ay + (by - ay) * t;
      path.setAttribute("d", `M${ax},${ay} C${mx},${ay} ${mx},${ey} ${ex},${ey}`);
      return path;
    }));
  }
  function render() {
    world.style.transform = `translate(${view.x}px, ${view.y}px)`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    world.replaceChildren(...board.notes.map((note) => {
      const text = el("div", { className: "text", textContent: note.text, contentEditable: "plaintext-only", spellcheck: false });
      text.onblur = () => { const value = text.textContent.trim(); if (value && value !== note.text) { note.text = value; save(); } };
      text.onpointerdown = (event) => event.stopPropagation();
      const node = el("div", { className: `note ${note.kind}${selected === note.id ? " selected" : ""}`, tabIndex: 0 }, el("div", { className: "kind", textContent: copy.kinds[note.kind] }), text);
      node.dataset.id = note.id;
      node.style.left = note.x + "px"; node.style.top = note.y + "px";
      node.onpointerdown = (event) => {
        event.stopPropagation();
        if (event.shiftKey && selected && selected !== note.id) {
          if (!board.links.some((l) => l.from === selected && l.to === note.id)) { board.links.push({ from: selected, to: note.id }); save(); }
          selected = note.id; render(); return;
        }
        selected = note.id;
        document.querySelectorAll(".note.selected").forEach((n) => n.classList.remove("selected")); node.classList.add("selected");
        const start = { x: event.clientX, y: event.clientY, nx: note.x, ny: note.y };
        node.setPointerCapture(event.pointerId);
        node.onpointermove = (move) => { note.x = start.nx + move.clientX - start.x; note.y = start.ny + move.clientY - start.y; node.style.left = note.x + "px"; node.style.top = note.y + "px"; wires(); };
        node.onpointerup = () => { node.onpointermove = null; if (note.x !== start.nx || note.y !== start.ny) save(); };
      };
      return node;
    }));
    requestAnimationFrame(wires);
  }
  viewport.onpointerdown = (event) => {
    selected = null; document.querySelectorAll(".note.selected").forEach((n) => n.classList.remove("selected"));
    const start = { x: event.clientX - view.x, y: event.clientY - view.y };
    viewport.classList.add("panning"); viewport.setPointerCapture(event.pointerId);
    viewport.onpointermove = (move) => { view.x = move.clientX - start.x; view.y = move.clientY - start.y; world.style.transform = `translate(${view.x}px, ${view.y}px)`; viewport.style.backgroundPosition = `${view.x}px ${view.y}px`; wires(); };
    viewport.onpointerup = () => { viewport.onpointermove = null; viewport.classList.remove("panning"); };
  };
  viewport.ondblclick = (event) => {
    const note = { id: "n" + Date.now().toString(36), text: copy.fresh, kind, x: event.clientX - view.x - 98, y: event.clientY - view.y - 40 };
    board.notes.push(note); selected = note.id; render(); save();
    requestAnimationFrame(() => { const text = world.querySelector(`[data-id="${note.id}"] .text`); text.focus(); document.getSelection().selectAllChildren(text); });
  };
  addEventListener("keydown", (event) => {
    if ((event.key === "Delete" || event.key === "Backspace") && selected && document.activeElement?.className !== "text") {
      board.notes = board.notes.filter((n) => n.id !== selected); board.links = board.links.filter((l) => l.from !== selected && l.to !== selected);
      selected = null; render(); save();
    }
  });
  function dock() {
    const tools = KINDS.map((k) => { const b = el("button", { type: "button", title: copy.kinds[k] }, el("i", { style: `background:var(--${k})` }), copy.kinds[k]); b.onclick = () => { kind = k; if (selected) { const n = board.notes.find((x) => x.id === selected); if (n) { n.kind = k; render(); save(); } } }; return b; });
    const fit = el("button", { type: "button", textContent: copy.fit, onclick: () => {
      if (!board.notes.length) return;
      const minX = Math.min(...board.notes.map((n) => n.x)), minY = Math.min(...board.notes.map((n) => n.y));
      view = { x: 60 - minX, y: 70 - minY }; render();
    } });
    const ask = el("button", { type: "button", textContent: "✦ " + copy.ask, onclick: () => somniq.prompt(copy.prompt) });
    document.getElementById("dock").replaceChildren(...tools, el("span", { className: "sep" }), fit, ask);
  }
  somniq.ready().then(({ language, data }) => {
    copy = COPY[language] ?? COPY.en;
    document.getElementById("hint").textContent = copy.hint;
    board = clean(data.board); dock(); render();
    somniq.onData((next) => { board = clean(next.board); render(); });
  });
  addEventListener("resize", wires);
})();
