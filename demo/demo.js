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
const state = { token: SCENARIOS[0].token, model: null, axis: "lateral", idx: 3,
                compare: false, cam: "auto", show: "both" };
const CAM_LABEL = { CAM_F0: "Front", CAM_L0: "Left", CAM_R0: "Right", CAM_B0: "Rear" };
//: How much ground the plan view always shows, in metres. Chosen so a junction
//: fits: below roughly this the panel crops to a patch of road with no context
//: in it, and the trajectory has nothing to be read against.
const MIN_SPAN_LAT = 48, MIN_SPAN_FWD = 48;
const bevOf = data => data && data.bev;

const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmt = (v, d = 1) => (v > 0 ? "+" : "") + v.toFixed(d);

async function payload(token) {
  if (!cache.has(token)) {
    // The map ships beside the run. It is the SAME nuPlan geometry the
    // evaluator scored drivable-area against, already rotated into the
    // baseline ego's frame, so the road under a plan is the road the run was
    // graded on and not a redrawing of it.
    const [r, b] = await Promise.all([
      fetch(`data/${token}.json`),
      fetch(`data/${token}.bev.json`).catch(() => null),
    ]);
    if (!r.ok) throw new Error(`${token}: HTTP ${r.status}`);
    const p = await r.json();
    p.bev = b && b.ok ? await b.json() : null;
    cache.set(token, p);
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
/** A cell's plan, candidate fan, driven path and ego, all in the baseline
 *  ego's frame. `executed_xy` is already world, so it only needs the second
 *  half of the transform — it is where the car GOT TO, not what it intended. */
function inBaseFrame(cell, baseCell) {
  if (!cell || !baseCell || !cell.selected_ego || !cell.ego_xy || cell.ego_xy[0] === null) return null;
  const b = baseCell.ego_xy, bh = baseCell.ego_heading;
  return {
    plan: toBaseFrame(toWorld(cell.selected_ego, cell.ego_xy, cell.ego_heading), b, bh),
    fan: cell.candidates
      ? cell.candidates.map(c => toBaseFrame(toWorld(c, cell.ego_xy, cell.ego_heading), b, bh))
      : null,
    driven: cell.executed_xy && cell.executed_xy.length > 1
      ? toBaseFrame(cell.executed_xy, b, bh) : null,
    // Everything before this index is the shared warm-up: identical in every
    // arm, so it is drawn once and faintly rather than seven times.
    handoffIdx: Math.max(0, cell.handoff_idx || 0),
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

/** The camera that actually shows this plan: most waypoints on frame, front
 *  preferred on a tie because it is the view a reader expects. */
function bestCamera(data, cell) {
  if (!cell || !cell.selected_ego || !data.cameras) return "CAM_F0";
  const order = ["CAM_F0", ...(data.surround || [])];
  let best = "CAM_F0", bestN = -1;
  for (const name of order) {
    const cam = data.cameras[name];
    if (!cam) continue;
    if (name !== "CAM_F0" && !(cell.surround || {})[name]) continue;
    const n = onFrame(cell.selected_ego, cam);
    if (n > bestN) { bestN = n; best = name; }
  }
  return best;
}

function renderShots(data) {
  // While the compare button is held, both views show the UNPERTURBED run at
  // the same instant. Flipping in place is the only way to see half a metre:
  // side by side the eye reads two pictures, not one picture that moved.
  const armId = state.compare && data.arms.base ? "base" : armAt(data, state.axis, state.idx);
  const cell = cellAt(data, armId, state.model);

  const box = $("shotCam"), img = $("imgCam");
  let chosen = "CAM_F0";
  if (cell) {
    chosen = state.cam === "auto" ? bestCamera(data, cell) : state.cam;
    const src = chosen === "CAM_F0" ? cell.cam : (cell.surround || {})[chosen];
    if (src) { box.classList.remove("empty"); img.src = `data/${src}`; }
    else { box.classList.add("empty"); box.dataset.msg = `${CAM_LABEL[chosen]} camera was not written for this cell.`; }
  } else {
    box.classList.add("empty");
    box.dataset.msg = armId ? "This model has not finished this displacement yet."
                            : "This displacement has not been evaluated yet.";
  }
  renderOverlay(data, cell, chosen);
  renderCamBar(data, cell, chosen);

  for (const j of [state.idx - 1, state.idx + 1]) {   // warm the neighbours
    const c = cellAt(data, armAt(data, state.axis, j), state.model);
    if (!c) continue;
    const nxt = state.cam === "auto" ? bestCamera(data, c) : state.cam;
    const src = nxt === "CAM_F0" ? c.cam : (c.surround || {})[nxt];
    if (src) new Image().src = `data/${src}`;
  }
}

/** The camera picker, with each camera's plan coverage on its chip. */
function renderCamBar(data, cell, chosen) {
  const order = ["CAM_F0", ...(data.surround || [])];
  const items = [{ id: "auto", label: "Auto", sub: CAM_LABEL[chosen] || "" }];
  for (const name of order) {
    const cam = data.cameras && data.cameras[name];
    const n = cam && cell && cell.selected_ego ? onFrame(cell.selected_ego, cam) : 0;
    const tot = cell && cell.selected_ego ? cell.selected_ego.length : 0;
    items.push({
      id: name, label: CAM_LABEL[name] || name,
      sub: tot ? `${n}/${tot} wp` : "",
      disabled: name !== "CAM_F0" && !((cell || {}).surround || {})[name],
    });
  }
  segButtons($("segCam"), items, c => c.id === state.cam,
             c => { state.cam = c.id; update(); });
  // Say plainly whose overlay is on screen: the evaluator burns its own into
  // CAM_F0, and the surround plates are clean, so the page draws those itself.
  $("camNote").textContent = chosen === "CAM_F0"
    ? "Overlay rendered by the evaluator."
    : `Plan projected onto the ${CAM_LABEL[chosen].toLowerCase()} camera by this page — CAM_F0's 63.7° field of view does not contain it.`;
}

/** Draw the plan (and candidate fan) onto a clean surround plate. */
function renderOverlay(data, cell, chosen) {
  const svg = $("camOverlay");
  if (!cell || chosen === "CAM_F0" || !data.cameras || !data.cameras[chosen]) {
    svg.innerHTML = ""; svg.removeAttribute("viewBox"); return;
  }
  const cam = data.cameras[chosen];
  svg.setAttribute("viewBox", `0 0 ${cam.width} ${cam.height}`);
  const poly = (pts, stroke, w, op) => {
    const p = projectEgo(pts, cam).filter(Boolean)
      .filter(q => q.u > -cam.width && q.u < 2 * cam.width && q.v > -cam.height && q.v < 2 * cam.height);
    if (p.length < 2) return "";
    return `<polyline points="${p.map(q => `${q.u.toFixed(1)},${q.v.toFixed(1)}`).join(" ")}" `
         + `fill="none" stroke="${stroke}" stroke-width="${w}" stroke-opacity="${op}" `
         + `stroke-linecap="round" stroke-linejoin="round"/>`;
  };
  let out = "";
  for (const c of cell.candidates || []) out += poly(c, css("--ghost"), 5, .5);
  out += poly(cell.selected_ego, css("--a6"), 13, .95);
  for (const q of projectEgo(cell.selected_ego, cam)) {
    if (q) out += `<circle cx="${q.u.toFixed(1)}" cy="${q.v.toFixed(1)}" r="9" fill="${css("--a6")}"/>`;
  }
  svg.innerHTML = out;
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
    let body = `Its 4 s plan ends <b>${Math.abs(dLat).toFixed(2)} m</b> further `
             + `${dLat >= 0 ? "left" : "right"} than the baseline's, and the episode still `
             + `<b>${TERM[cell.termination] || cell.termination || "ends"}</b>.`;
    if (carried !== null) {
      const pct = Math.round(Math.max(0, Math.min(1.4, carried)) * 100);
      body += ` That is <b>${pct}%</b> of the ${Math.abs(v)} m it was moved, `
            + (pct < 35 ? "so most of it is steered away inside the planning horizon."
             : pct > 80 ? "so almost none of it is corrected inside the planning horizon — "
                          + "check the spread row for whether the episode recovers later."
             : "so part of it is corrected inside the planning horizon and part carried.");
    }
    set(`${fmt(v)} ${ax.unit} ${ax.label.toLowerCase()}`, body);
    return;
  }
  set(`${fmt(v)} ${ax.unit} ${ax.label.toLowerCase()}`,
      `The episode <b>${TERM[cell.termination] || cell.termination || "ends"}</b> after `
      + `${(cell.executed_frames / 10).toFixed(1)} s.`);
}

/** Lateral spread of this axis's runs at hand-off and at the end of the
 *  episode. The chart cannot show this: three metres of spread across a
 *  170 m drive is under two percent of the frame, so the seven paths overlay
 *  into one line however they are scaled. The numbers do not have that
 *  problem, and convergence-or-divergence is the whole question. */
function spread(data) {
  const base = cellAt(data, "base", state.model);
  if (!base) return null;
  const ax = data.axes[state.axis];
  const start = [], end = [];
  for (let i = 0; i < ax.arms.length; i++) {
    const cell = cellAt(data, armAt(data, state.axis, i), state.model);
    const t = cell && inBaseFrame(cell, base);
    if (!t || !t.driven) continue;
    start.push(t.ego[0]);
    end.push(t.driven[t.driven.length - 1][0]);
  }
  if (start.length < 2) return null;
  const rng = a => Math.max(...a) - Math.min(...a);
  return { n: start.length, start: rng(start), end: rng(end) };
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
    const sp = spread(data);
    if (sp) {
      const verdict = sp.end < sp.start * 0.5 ? "converges"
                    : sp.end > sp.start * 1.5 ? "diverges" : "holds";
      add(`Spread of ${sp.n} runs`,
          `${sp.start.toFixed(1)} m at hand-off &rarr; ${sp.end.toFixed(1)} m when the episodes end `
          + `<span class="pill ${verdict === "diverges" ? "bad" : "ok"}">${verdict}</span>`);
    }
  } else add("Status", "not evaluated yet");
  $("readout").innerHTML = rows.join("");
}

// ------------------------------------------------------- distribution

function draw() {
  const data = cache.get(state.token);
  const cv = $("dist");
  if (!data || !cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 480, H = cv.clientHeight || 330;
  if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const wantPlan = state.show !== "executed";
  const wantDriven = state.show !== "plan";
  const ax = data.axes[state.axis];
  const base = cellAt(data, "base", state.model);
  const armId = armAt(data, state.axis, state.idx);
  const cell = cellAt(data, armId, state.model);
  const cur = cell && base && inBaseFrame(cell, base);
  // The baseline is drawn as a ghost REFERENCE whenever it is not itself the
  // selection. Showing one displacement alone answers "what did it do"; the
  // page's question is "what did it do DIFFERENTLY", and that needs the thing
  // it differs from on the same axes.
  const ref = base && armId !== "base" ? inBaseFrame(base, base) : null;

  if (!cur) {
    g.fillStyle = css("--ink-faint");
    g.font = "13px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText("This cell has not been evaluated yet.", W / 2, H / 2);
    $("distLegend").innerHTML = "";
    return;
  }

  let lo = 0, hi = 0, fwdHi = 1, fwdLo = 0;
  const scan = pts => { for (const [l, f] of pts) { lo = Math.min(lo, l); hi = Math.max(hi, l); fwdHi = Math.max(fwdHi, f); fwdLo = Math.min(fwdLo, f); } };
  for (const t of [cur, ref]) {
    if (!t) continue;
    scan([t.ego]);
    if (wantPlan) { scan(t.plan); if (t.fan) t.fan.forEach(scan); }
    if (wantDriven && t.driven) scan(t.driven.slice(t.handoffIdx));
  }
  const m = Math.max((hi - lo) * 0.08, 0.7);
  lo -= m; hi += m; fwdHi *= 1.06; fwdLo -= 0.7;
  // Frame the SCENE, not the trajectory. A tight fit around a 15 m plan crops
  // to a patch of tarmac with no junction in it, and then the one thing the
  // panel is for -- seeing where on the road the car went -- has nowhere to
  // happen. Grow the box to a minimum span, keep it centred on what is drawn,
  // and stop at the radius the map was exported with so it never opens onto
  // blank canvas.
  const R = (bevOf(data) || {}).radius_m || 70;
  const grow = (a, b, min) => {
    if (b - a >= min) return [a, b];
    const c = (a + b) / 2;
    return [c - min / 2, c + min / 2];
  };
  [lo, hi] = grow(lo, hi, MIN_SPAN_LAT);
  [fwdLo, fwdHi] = grow(fwdLo, fwdHi, MIN_SPAN_FWD);
  lo = Math.max(lo, -R); hi = Math.min(hi, R);
  fwdLo = Math.max(fwdLo, -R); fwdHi = Math.min(fwdHi, R);

  const pad = { l: 40, r: 12, t: 12, b: 22 };
  const s = Math.min((W - pad.l - pad.r) / (hi - lo), (H - pad.t - pad.b) / (fwdHi - fwdLo));
  const ox = pad.l + ((W - pad.l - pad.r) - (hi - lo) * s) / 2 + hi * s;
  const oy = H - pad.b - ((H - pad.t - pad.b) - (fwdHi - fwdLo) * s) / 2 + fwdLo * s;
  const X = l => ox - l * s;
  const Y = f => oy - f * s;

  const line = pts => {
    g.beginPath();
    pts.forEach(([l, f], i) => (i ? g.lineTo(X(l), Y(f)) : g.moveTo(X(l), Y(f))));
    g.stroke();
  };
  const haloed = (pts, w) => {
    const ss = g.strokeStyle, lw = g.lineWidth, al = g.globalAlpha;
    g.strokeStyle = css("--panel"); g.lineWidth = lw + w; g.globalAlpha = al * 0.55;
    line(pts);
    g.strokeStyle = ss; g.lineWidth = lw; g.globalAlpha = al;
    line(pts);
  };
  const egoBox = (t, fill, outline, alpha) => {
    const [EL, EW] = (data.bev && data.bev.ego_box) || [4.515, 2.0];
    g.save();
    g.translate(X(t.ego[0]), Y(t.ego[1]));
    g.rotate(-Math.PI / 2);            // every arm keeps the baseline heading
    g.globalAlpha = alpha;
    g.fillStyle = fill;
    g.fillRect(-EL * s / 2, -EW * s / 2, EL * s, EW * s);
    if (outline) {
      g.strokeStyle = outline; g.lineWidth = 1.4; g.setLineDash([]);
      g.strokeRect(-EL * s / 2, -EW * s / 2, EL * s, EW * s);
    }
    g.globalAlpha = 1;
    g.restore();
  };

  // ── the road, underneath ────────────────────────────────────────────
  const bev = bevOf(data);
  g.save();
  g.beginPath();
  g.rect(pad.l - 2, pad.t - 2, W - pad.l - pad.r + 4, H - pad.t - pad.b + 4);
  g.clip();
  if (bev) {
    g.fillStyle = css("--road");
    for (const lane of bev.lanes) {
      g.beginPath();
      lane.forEach(([l, f], i) => (i ? g.lineTo(X(l), Y(f)) : g.moveTo(X(l), Y(f))));
      g.closePath(); g.fill();
    }
    g.strokeStyle = css("--roadline"); g.lineWidth = 1.2; g.setLineDash([7, 7]);
    for (const c of bev.lane_centres) line(c);
    g.setLineDash([]);
    g.lineWidth = 1.6;
    for (const c of bev.crosswalks) line(c);
    for (const a of bev.actors) {
      g.fillStyle = a.t === "VEHICLE" ? css("--actor") : css("--actor-2");
      g.save();
      g.translate(X(a.xy[0]), Y(a.xy[1]));
      g.rotate(-(a.h + Math.PI / 2));   // see the note on egoBox's rotation
      g.fillRect(-a.l * s / 2, -a.w * s / 2, a.l * s, a.w * s);
      g.restore();
    }
  }

  // ── the baseline, as a reference ────────────────────────────────────
  if (ref) {
    egoBox(ref, css("--ghost"), null, .45);
    g.strokeStyle = css("--ink-dim"); g.globalAlpha = .5;
    if (wantPlan) { g.lineWidth = 1.6; g.setLineDash([]); line(ref.plan); }
    if (wantDriven && ref.driven) {
      g.lineWidth = 1.3; g.setLineDash([5, 4]);
      line(ref.driven.slice(ref.handoffIdx)); g.setLineDash([]);
    }
    g.globalAlpha = 1;
  }

  // ── the selected displacement ───────────────────────────────────────
  const v = ax.values[state.idx];
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));
  const vmax = Math.max(...ax.values.map(Math.abs)) || 1;
  const t01 = v / vmax;
  const rgb = t01 < 0 ? mix(hex(css("--ink-dim")), hex(css("--a1")), -t01)
                      : mix(hex(css("--ink-dim")), hex(css("--a5")), t01);
  const col = `rgb(${rgb.join(",")})`;

  if (wantPlan && cur.fan) {
    g.strokeStyle = css("--ghost"); g.globalAlpha = .5; g.lineWidth = 1.2;
    cur.fan.forEach(line);
    g.globalAlpha = 1;
  }
  g.strokeStyle = col; g.fillStyle = col;
  if (wantDriven && cur.driven) {
    const after = cur.driven.slice(cur.handoffIdx);
    if (cur.handoffIdx > 0) {                    // the shared warm-up, faintly
      g.strokeStyle = css("--ghost"); g.setLineDash([2, 3]);
      g.lineWidth = 1.2; g.globalAlpha = .6;
      line(cur.driven.slice(0, cur.handoffIdx + 1));
      g.strokeStyle = col; g.globalAlpha = 1;
    }
    g.setLineDash([5, 4]); g.lineWidth = 2.2;
    haloed(after.length > 1 ? after : cur.driven, 2.4);
    g.setLineDash([]);
    const end = (after.length > 1 ? after : cur.driven).slice(-1)[0];
    const bad = cell.collided || cell.termination === "off_drivable";
    if (bad) {
      g.strokeStyle = css("--a5"); g.lineWidth = 2.4;
      const r = 5;
      g.beginPath();
      g.moveTo(X(end[0]) - r, Y(end[1]) - r); g.lineTo(X(end[0]) + r, Y(end[1]) + r);
      g.moveTo(X(end[0]) + r, Y(end[1]) - r); g.lineTo(X(end[0]) - r, Y(end[1]) + r);
      g.stroke(); g.strokeStyle = col;
    } else {
      g.lineWidth = 2; g.beginPath(); g.arc(X(end[0]), Y(end[1]), 3.6, 0, 2 * Math.PI); g.stroke();
    }
  }
  if (wantPlan) { g.lineWidth = 3.2; haloed(cur.plan, 2.6); }
  egoBox(cur, col, css("--ink"), 1);
  g.restore();

  g.strokeStyle = css("--line-soft"); g.lineWidth = 1;
  g.fillStyle = css("--ink-faint");
  g.font = "10px ui-monospace, Menlo, monospace";
  g.textAlign = "left"; g.textBaseline = "middle";
  const step = fwdHi > 120 ? 50 : fwdHi > 60 ? 20 : fwdHi > 30 ? 10 : 5;
  for (let f = step; f <= fwdHi; f += step) {
    g.beginPath(); g.moveTo(pad.l, Y(f)); g.lineTo(W - pad.r, Y(f)); g.stroke();
    g.fillText(`${f} m`, 4, Y(f));
  }

  const u = AXIS[state.axis].unit;
  let leg = `<span><i style="background:${col}"></i>${fmt(v)} ${u} &mdash; this run</span>`;
  if (ref) leg += `<span><i style="background:${css("--ink-dim")};opacity:.5"></i>baseline, for reference</span>`;
  if (wantPlan) leg += `<span><i class="solid"></i>plan (4 s)</span>`;
  if (wantPlan && cur.fan) leg += `<span><i style="background:${css("--ghost")}"></i>candidates weighed</span>`;
  if (wantDriven) leg += `<span><i class="dash"></i>driven (whole episode)</span>`
                       + `<span>&#9675;&nbsp;ended cleanly &nbsp; &#10005;&nbsp;off-road or contact</span>`;
  $("distLegend").innerHTML = leg;

  segButtons($("segShow"),
    [{ id: "both", label: "Both" }, { id: "plan", label: "Plan only" },
     { id: "executed", label: "Driven only" }],
    o => o.id === state.show,
    o => { state.show = o.id; draw(); });
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

/* ======================================================================
   Camera projection.

   Ported line for line from nexussim/evaluation/vis_utils.py's
   project_ego_to_camera, because the page must land the plan on the same
   pixels the evaluator did. Two details carry the whole thing:

   * the focal length comes from the HORIZONTAL fov, not the nominal ~70°
     diagonal one the config also carries. Using the diagonal under-zooms and
     floats the overlay a few percent of image height off the ground.
   * `cam = (rig - t) @ R_c2r` is a ROW vector times the matrix, i.e. the
     transpose of the usual column-vector convention. Getting that backwards
     mirrors the image and looks almost right.

   Why it exists at all: CAM_F0 sees 63.7°, and a hard turn puts the whole
   plan outside it — on C-5, PDM-Closed turns 40-58° off axis and not one of
   its eight waypoints lands on the front frame. The surround plates are
   written unannotated, so the page has to draw on them itself.
   ====================================================================== */
const D2R = Math.PI / 180;

function camMatrix(cam) {
  const yaw = (cam.yaw || 0) * D2R, pitch = (cam.pitch || 0) * D2R, roll = (cam.roll || 0) * D2R;
  const cz = Math.cos(yaw), sz = Math.sin(yaw);
  const cyp = Math.cos(pitch), syp = Math.sin(pitch);
  const cxr = Math.cos(roll), sxr = Math.sin(roll);
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const Ry = [[cyp, 0, syp], [0, 1, 0], [-syp, 0, cyp]];
  const Rx = [[1, 0, 0], [0, cxr, -sxr], [0, sxr, cxr]];
  const Rb = [[0, 0, 1], [-1, 0, 0], [0, -1, 0]];
  const mul = (A, B) => A.map(r => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
  return mul(mul(mul(Rz, Ry), Rx), Rb);          // camera -> rig
}

/** Ego-frame [lateral(+left), forward] -> {u, v} in the camera's OWN pixels. */
function projectEgo(pts, cam) {
  const W = cam.width, H = cam.height;
  const fovH = cam.fov_h || cam.fov || 70;
  const f = W / (2 * Math.tan(fovH * D2R / 2));
  const R = camMatrix(cam);
  const t = [cam.x || 0, cam.y || 0, cam.z || 0];
  return pts.map(([lat, fwd]) => {
    const d = [fwd - t[0], lat - t[1], 0 - t[2]];           // rig FLU, plan on the ground
    const c = [0, 1, 2].map(j => d[0] * R[0][j] + d[1] * R[1][j] + d[2] * R[2][j]);
    if (c[2] <= 0.1) return null;                           // behind the camera
    // Clamped exactly as the source does. A waypoint just off the edge
    // otherwise projects to thousands of pixels away and drags the polyline
    // with it; the clamp keeps the segment heading off-frame in the right
    // direction instead of across it.
    const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
    return {
      u: clamp(f * c[0] / c[2] + W / 2, -W, 2 * W),
      v: clamp(f * c[1] / c[2] + H / 2, -H, 2 * H),
    };
  });
}

/** How many of a path's points land on this camera's frame. */
function onFrame(pts, cam) {
  return projectEgo(pts, cam).filter(p => p && p.u >= 0 && p.u < cam.width && p.v >= 0 && p.v < cam.height).length;
}
