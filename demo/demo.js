/* ---------------------------------------------------------------------
   Hand-off perturbation explorer.

   One payload per scenario (written by export_demo.py) holding, per
   (displacement arm, model): two pre-rendered views of the hand-off frame
   and the numbers behind them. This file is the reading surface.

   Two things here are not decoration:

   * Every plan is drawn in the BASELINE ego's frame, not in its own. Each
     arm's plan comes out of the exporter in ITS OWN ego frame, and drawing
     those from a shared origin silently subtracts the displacement — the
     one quantity the page exists to show. Transforming through the recorded
     world pose puts the moved car where it actually was.
   * The caption is COMPUTED. "The plan ends 0.8 m further left" is a claim
     the run either supports or does not; a sentence written by hand would
     keep reading well after the data stopped agreeing with it.
   ------------------------------------------------------------------ */

// ---- theme toggle. Identical contract to /internal/plan.js: the stylesheet
// already follows prefers-color-scheme, and the button only writes an explicit
// override, so an untouched visit keeps tracking the OS setting.
const themebtn = document.getElementById("themebtn");
const savedTheme = localStorage.getItem("navsafe-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
if (themebtn) themebtn.addEventListener("click", e => {
  e.stopPropagation();
  const dark = getComputedStyle(document.documentElement)
    .getPropertyValue("color-scheme").trim() === "dark";
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("navsafe-theme", next);
  draw();                       // the canvas is painted, not styled
});

const SCENARIOS = [
  { token: "58d69daf413c5d5a", label: "Intersection", sub: "C-5" },
  { token: "3a0e2f53c9585e94", label: "Angle / T-bone", sub: "C-2" },
];
const AXIS = {
  lateral:      { label: "Lateral",      unit: "m", pos: "left",             neg: "right" },
  longitudinal: { label: "Longitudinal", unit: "m", pos: "forward",          neg: "back" },
  yaw:          { label: "Yaw",          unit: "°", pos: "counter-clockwise", neg: "clockwise" },
};
const TERM = {
  goal_reached: "reaches the goal",
  off_drivable: "leaves the drivable area",
  contact_at_fault: "hits something",
  contact_not_at_fault: "is hit by another vehicle",
  trace_exhausted: "runs to the end of the log",
  deadlock: "deadlocks",
  infra_failure: "was cut short by the harness",
};

const cache = new Map();        // token -> payload
const state = { token: SCENARIOS[0].token, model: null, axis: "lateral", idx: 3, compare: false };

const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmt = (v, d = 1) => (v > 0 ? "+" : "") + v.toFixed(d);

async function payload(token) {
  if (!cache.has(token)) {
    const r = await fetch(`data/${token}.json`);
    if (!r.ok) throw new Error(`${token}: HTTP ${r.status}`);
    cache.set(token, await r.json());
  }
  return cache.get(token);
}

const armAt = (data, axis, i) => {
  const id = data.axes[axis].arms[i];
  return data.arms[id] ? id : null;
};
const cellAt = (data, armId, model) =>
  armId && data.arms[armId] ? (data.arms[armId].models[model] || null) : null;

/** An ego-frame path [lateral, forward] placed in the world. */
function toWorld(pts, [ex, ey], h) {
  const c = Math.cos(h), s = Math.sin(h);
  return pts.map(([l, f]) => [ex + c * f - s * l, ey + s * f + c * l]);
}
/** World points expressed in the frame of the baseline ego. */
function toBaseFrame(pts, [bx, by], bh) {
  const c = Math.cos(-bh), s = Math.sin(-bh);
  return pts.map(([x, y]) => {
    const dx = x - bx, dy = y - by;
    return [s * dx + c * dy, c * dx - s * dy];   // [lateral(+left), forward]
  });
}
/** A cell's plan (and its ego) in the baseline ego's frame. */
function inBaseFrame(cell, baseCell) {
  if (!cell || !baseCell || !cell.selected_ego || !cell.ego_xy || cell.ego_xy[0] === null) return null;
  const b = baseCell.ego_xy, bh = baseCell.ego_heading;
  return {
    plan: toBaseFrame(toWorld(cell.selected_ego, cell.ego_xy, cell.ego_heading), b, bh),
    fan: cell.candidates
      ? cell.candidates.map(c => toBaseFrame(toWorld(c, cell.ego_xy, cell.ego_heading), b, bh))
      : null,
    ego: toBaseFrame([cell.ego_xy], b, bh)[0],
  };
}

function segButtons(host, items, isOn, onPick) {
  host.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = it.sub ? `${it.label}<span class="sub">${it.sub}</span>` : it.label;
    b.setAttribute("aria-pressed", String(isOn(it)));
    if (it.disabled) b.disabled = true;
    b.addEventListener("click", () => onPick(it));
    host.appendChild(b);
  }
}

// ---------------------------------------------------------------- controls

function renderControls(data) {
  segButtons($("segScenario"), SCENARIOS, s => s.token === state.token,
    async s => { state.token = s.token; await load(); });

  segButtons($("segModel"),
    data.models.map(m => ({ id: m, label: data.model_labels[m] || m })),
    m => m.id === state.model,
    m => { state.model = m.id; update(); });

  segButtons($("segAxis"),
    Object.keys(data.axes).map(a => {
      const n = data.axes[a].arms.filter(id => data.arms[id]).length;
      return { id: a, label: AXIS[a].label, sub: `${n}/7`, disabled: n === 0 };
    }),
    a => a.id === state.axis,
    a => { state.axis = a.id; snapToRun(data); update(); });
}

/** Keep the slider on a position that actually has data. */
function snapToRun(data) {
  const arms = data.axes[state.axis].arms;
  if (data.arms[arms[state.idx]]) return;
  for (let d = 1; d < arms.length; d++) {
    for (const j of [state.idx - d, state.idx + d]) {
      if (j >= 0 && j < arms.length && data.arms[arms[j]]) { state.idx = j; return; }
    }
  }
}

function renderTicks(data) {
  const ax = data.axes[state.axis];
  $("ticks").innerHTML = ax.values.map((v, i) => {
    const cls = [i === state.idx ? "on" : "",
                 armAt(data, state.axis, i) ? "" : "missing"].join(" ").trim();
    return `<span class="${cls}">${v > 0 ? "+" : ""}${v}</span>`;
  }).join("");
  const v = ax.values[state.idx];
  $("readValue").textContent = `${AXIS[state.axis].label} offset: ${fmt(v)} ${AXIS[state.axis].unit}`;
  $("readHint").textContent = v === 0
    ? "the unperturbed run"
    : `to the ego's ${v > 0 ? AXIS[state.axis].pos : AXIS[state.axis].neg}, applied on the hand-off frame`;
}

// ---------------------------------------------------------------- views

function renderShots(data) {
  // While the compare button is held, both views show the UNPERTURBED run at
  // the same instant. Flipping in place is the only way to see half a metre:
  // side by side the eye reads two pictures, not one picture that moved.
  const armId = state.compare && data.arms.base ? "base" : armAt(data, state.axis, state.idx);
  const cell = cellAt(data, armId, state.model);
  for (const [boxId, imgId, key] of [["shotCam", "imgCam", "cam"], ["shotBev", "imgBev", "bev"]]) {
    const box = $(boxId), img = $(imgId);
    if (cell) { box.classList.remove("empty"); img.src = `data/${cell[key]}`; }
    else {
      box.classList.add("empty");
      box.dataset.msg = armId ? "This model has not finished this displacement yet."
                              : "This displacement has not been evaluated yet.";
    }
  }
  for (const j of [state.idx - 1, state.idx + 1]) {   // warm the neighbours
    const c = cellAt(data, armAt(data, state.axis, j), state.model);
    if (c) { new Image().src = `data/${c.cam}`; new Image().src = `data/${c.bev}`; }
  }
}

// ---------------------------------------------------------------- caption

/** One computed sentence about what this displacement did to the policy. */
function renderCaption(data) {
  const armId = armAt(data, state.axis, state.idx);
  const cell = cellAt(data, armId, state.model);
  const base = cellAt(data, "base", state.model);
  const v = data.axes[state.axis].values[state.idx];
  const ax = AXIS[state.axis];
  const set = (kicker, body, tone = "") => {
    $("capKicker").textContent = kicker;
    $("capBody").innerHTML = body;
    $("caption").dataset.tone = tone;
  };

  if (!cell) { set("Not run yet", "This cell has not finished evaluating.", "wait"); return; }
  if (!base) { set("No baseline", "The unperturbed run for this model is still evaluating.", "wait"); return; }
  if (armId === "base") {
    set("Unperturbed baseline",
        `Every other position on the slider is measured against this run. It `
        + `<b>${TERM[cell.termination] || cell.termination || "ends"}</b>`
        + `${cell.driving_score != null ? `, scoring <b>${cell.driving_score.toFixed(0)}</b>` : ""}.`);
    return;
  }

  // Ending first: a different outcome outranks any amount of geometry.
  if (cell.termination && base.termination && cell.termination !== base.termination) {
    set(`${fmt(v)} ${ax.unit} changes the outcome`,
        `The episode <b>${TERM[cell.termination] || cell.termination}</b> after `
        + `${(cell.executed_frames / 10).toFixed(1)} s, where the unperturbed run `
        + `<b>${TERM[base.termination] || base.termination}</b>.`,
        cell.success === false && base.success !== false ? "bad" : "note");
    return;
  }
  if (cell.collided && !base.collided) {
    set(`${fmt(v)} ${ax.unit} causes a collision`,
        `The ego makes contact during this run; the unperturbed one does not.`, "bad");
    return;
  }

  // Otherwise: how much of the displacement does the plan still carry at the
  // end of its horizon? Measured in the BASELINE frame, so "further left"
  // means further left on the road, not in the moved car's own axes.
  const a = inBaseFrame(cell, base), b = inBaseFrame(base, base);
  if (a && b && a.plan.length && b.plan.length) {
    const dLat = a.plan[a.plan.length - 1][0] - b.plan[b.plan.length - 1][0];
    const carried = state.axis === "lateral" && Math.abs(v) > 1e-6 ? dLat / v : null;
    let body = `Its plan ends <b>${Math.abs(dLat).toFixed(2)} m</b> further `
             + `${dLat >= 0 ? "left" : "right"} than the baseline's, and the episode still `
             + `<b>${TERM[cell.termination] || cell.termination || "ends"}</b>.`;
    if (carried !== null) {
      const pct = Math.round(Math.max(0, Math.min(1.4, carried)) * 100);
      body += ` That is <b>${pct}%</b> of the ${Math.abs(v)} m it was moved — `
            + (pct < 35 ? "the policy steers most of it away within the horizon."
             : pct > 80 ? "the policy carries the displacement rather than correcting it."
             : "the policy corrects part of it and carries the rest.");
    }
    set(`${fmt(v)} ${ax.unit} ${ax.label.toLowerCase()}`, body);
    return;
  }
  set(`${fmt(v)} ${ax.unit} ${ax.label.toLowerCase()}`,
      `The episode <b>${TERM[cell.termination] || cell.termination || "ends"}</b> after `
      + `${(cell.executed_frames / 10).toFixed(1)} s.`);
}

function renderReadout(data) {
  const cell = cellAt(data, armAt(data, state.axis, state.idx), state.model);
  const rows = [];
  const add = (k, v) => rows.push(`<tr><th>${k}</th><td>${v}</td></tr>`);
  if (cell) {
    add("Candidates", cell.candidates ? cell.candidates.length : "1 (single-trajectory policy)");
    add("Chosen", cell.selected_index == null ? "&mdash;" : `#${cell.selected_index}`);
    add("Episode", `${(cell.executed_frames / 10).toFixed(1)} s &middot; ${cell.termination || "—"}`);
    add("Driving score", cell.driving_score == null ? "&mdash;" : cell.driving_score.toFixed(1));
    add("Contact", cell.collided ? '<span class="pill bad">yes</span>'
                                 : '<span class="pill ok">none</span>');
  } else add("Status", "not evaluated yet");
  $("readout").innerHTML = rows.join("");
}

// ------------------------------------------------------- distribution

function draw() {
  const data = cache.get(state.token);
  const cv = $("dist");
  if (!data || !cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 700, H = Math.round(W * 0.62);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = `${H}px`;
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const ax = data.axes[state.axis];
  const base = cellAt(data, "base", state.model);
  const picked = [];
  let fan = null;
  if (base) {
    for (let i = 0; i < ax.arms.length; i++) {
      const cell = cellAt(data, armAt(data, state.axis, i), state.model);
      const t = cell && inBaseFrame(cell, base);
      if (!t) continue;
      picked.push({ v: ax.values[i], pts: t.plan, ego: t.ego, current: i === state.idx });
      if (i === state.idx) fan = t.fan;
    }
  }
  if (!picked.length) {
    g.fillStyle = css("--ink-faint");
    g.font = "13px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText("No plans on this axis yet.", W / 2, H / 2);
    $("distLegend").innerHTML = "";
    return;
  }

  let lo = 0, hi = 0, fwdHi = 1, fwdLo = 0;
  const scan = pts => { for (const [l, f] of pts) { lo = Math.min(lo, l); hi = Math.max(hi, l); fwdHi = Math.max(fwdHi, f); fwdLo = Math.min(fwdLo, f); } };
  picked.forEach(p => { scan(p.pts); scan([p.ego]); });
  if (fan) fan.forEach(scan);
  const m = Math.max((hi - lo) * 0.08, 0.7);
  lo -= m; hi += m; fwdHi *= 1.06; fwdLo -= 0.7;

  const pad = { l: 40, r: 12, t: 12, b: 22 };
  const s = Math.min((W - pad.l - pad.r) / (hi - lo), (H - pad.t - pad.b) / (fwdHi - fwdLo));
  const ox = pad.l + ((W - pad.l - pad.r) - (hi - lo) * s) / 2 + hi * s;
  const oy = H - pad.b - ((H - pad.t - pad.b) - (fwdHi - fwdLo) * s) / 2 + fwdLo * s;
  const X = l => ox - l * s;
  const Y = f => oy - f * s;

  const step = fwdHi > 60 ? 20 : fwdHi > 30 ? 10 : 5;
  g.strokeStyle = css("--line-soft"); g.lineWidth = 1;
  g.fillStyle = css("--ink-faint");
  g.font = "10px ui-monospace, Menlo, monospace";
  g.textAlign = "left"; g.textBaseline = "middle";
  for (let f = step; f <= fwdHi; f += step) {
    g.beginPath(); g.moveTo(pad.l, Y(f)); g.lineTo(W - pad.r, Y(f)); g.stroke();
    g.fillText(`${f} m`, 4, Y(f));
  }
  g.strokeStyle = css("--line");
  g.beginPath(); g.moveTo(X(0), pad.t); g.lineTo(X(0), H - pad.b); g.stroke();

  const path = pts => {
    g.beginPath();
    pts.forEach(([l, f], i) => (i ? g.lineTo(X(l), Y(f)) : g.moveTo(X(l), Y(f))));
    g.stroke();
  };
  if (fan) { g.strokeStyle = css("--ghost"); g.globalAlpha = .45; g.lineWidth = 1.1; fan.forEach(path); g.globalAlpha = 1; }

  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));
  const cNeg = hex(css("--a1")), cPos = hex(css("--a5")), cMid = hex(css("--ink-dim"));
  const vmax = Math.max(...ax.values.map(Math.abs)) || 1;
  for (const p of picked) {
    const t = p.v / vmax;
    const rgb = t < 0 ? mix(cMid, cNeg, -t) : mix(cMid, cPos, t);
    const col = `rgb(${rgb.join(",")})`;
    g.strokeStyle = col; g.lineWidth = p.current ? 3.2 : 1.5; g.globalAlpha = p.current ? 1 : .55;
    path(p.pts);
    // where that arm's ego actually stood — the displacement itself
    g.fillStyle = col; g.globalAlpha = p.current ? 1 : .6;
    g.beginPath(); g.arc(X(p.ego[0]), Y(p.ego[1]), p.current ? 4 : 2.6, 0, 2 * Math.PI); g.fill();
    g.globalAlpha = 1;
  }

  const u = AXIS[state.axis].unit;
  $("distLegend").innerHTML =
      `<span><i style="background:${css("--a1")}"></i>${-vmax} ${u}</span>`
    + `<span><i style="background:${css("--ink-dim")}"></i>baseline</span>`
    + `<span><i style="background:${css("--a5")}"></i>+${vmax} ${u}</span>`
    + `<span><i style="background:${css("--ghost")}"></i>candidates weighed here</span>`
    + `<span>&#9679;&nbsp;where each run's ego stood</span>`;
}

// ---------------------------------------------------------------- wiring

function update() {
  const data = cache.get(state.token);
  if (!data) return;
  renderControls(data);
  renderTicks(data);
  renderShots(data);
  renderCaption(data);
  renderReadout(data);
  draw();
  $("slider").value = String(state.idx);
  $("cmpBtn").disabled = armAt(data, state.axis, state.idx) === "base" || !data.arms.base;
}

async function load() {
  const data = await payload(state.token);
  if (!state.model || !data.models.includes(state.model)) state.model = data.models[0];
  snapToRun(data);
  update();
}

// Hold-to-compare. Pointer events cover mouse, pen and touch; the window-level
// release matters because letting go off the button would otherwise leave the
// page stuck on the baseline.
const cmp = $("cmpBtn");
const setCompare = on => {
  const data = cache.get(state.token);
  const useful = data && data.arms.base && armAt(data, state.axis, state.idx) !== "base";
  const next = Boolean(on) && Boolean(useful);
  if (next === state.compare) return;
  state.compare = next;
  cmp.dataset.on = next ? "1" : "0";
  renderShots(data);
};
cmp.addEventListener("pointerdown", e => { e.preventDefault(); setCompare(true); });
window.addEventListener("pointerup", () => setCompare(false));
window.addEventListener("pointercancel", () => setCompare(false));
cmp.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setCompare(true); } });
cmp.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") setCompare(false); });
cmp.addEventListener("blur", () => setCompare(false));

$("slider").addEventListener("input", e => {
  state.idx = Number(e.target.value);
  const data = cache.get(state.token);
  if (data && !armAt(data, state.axis, state.idx)) snapToRun(data);
  update();
});
window.addEventListener("resize", draw);

load().catch(err => { $("capBody").textContent = `Could not load the sweep: ${err.message}`; });
