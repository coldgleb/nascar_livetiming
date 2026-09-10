// NASCAR Live Timing — vanilla JS, без сборки.
// Данные: публичный фид https://cf.nascar.com/live/feeds/live-feed.json (CORS открыт).

const FEED_URL = "https://cf.nascar.com/live/feeds/live-feed.json";
const POLL_MS = 2000;          // период опроса
const STALE_MS = 8000;         // после этого помечаем данные «устаревшими»

// ---------- Справочники ----------
const FLAGS = {
  1: { cls: "green",    text: "Зелёный" },
  2: { cls: "yellow",   text: "Кошн" },
  3: { cls: "red",      text: "Красный" },
  4: { cls: "checkered",text: "Финиш" },
  8: { cls: "warmup",   text: "Прогрев" },
  9: { cls: "",         text: "Не активна" },
};

const SERIES = {
  1: "NASCAR Cup Series",
  2: "Xfinity Series",
  3: "Craftsman Truck Series",
};

const MANUFACTURERS = {
  chv: "Chevrolet", chevrolet: "Chevrolet", chevy: "Chevrolet",
  frd: "Ford", ford: "Ford",
  tyt: "Toyota", toyota: "Toyota",
  dge: "Dodge", dodge: "Dodge",
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  flagChip: $("flagChip"),
  runName: $("runName"),
  trackName: $("trackName"),
  seriesBadge: $("seriesBadge"),
  lapValue: $("lapValue"),
  toGoValue: $("toGoValue"),
  stageValue: $("stageValue"),
  cautionValue: $("cautionValue"),
  leadersValue: $("leadersValue"),
  emptyState: $("emptyState"),
  emptyTitle: $("emptyTitle"),
  emptyText: $("emptyText"),
  demoBtn: $("demoBtn"),
  board: $("board"),
  rows: $("rows"),
  refreshStatus: $("refreshStatus"),
  modeNote: $("modeNote"),
};

// ---------- Состояние ----------
let timer = null;
let lastOkAt = 0;
let demoMode = false;
const openRows = new Set(); // какие строки (по номеру машины) раскрыты

// ---------- Утилиты форматирования ----------
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

function fmtLapTime(t) {
  const n = num(t);
  if (n === null || Number.isNaN(n) || n <= 0) return "—";
  if (n >= 60) {
    const m = Math.floor(n / 60);
    const s = (n % 60).toFixed(3).padStart(6, "0");
    return `${m}:${s}`;
  }
  return `${n.toFixed(3)} с`;
}

function fmtSpeed(v) {
  const n = num(v);
  if (n === null || Number.isNaN(n) || n <= 0) return null;
  return `${n.toFixed(1)} mph`;
}

function fmtGap(delta, position) {
  if (position === 1) return { text: "Лидер", leader: true };
  const n = num(delta);
  if (n === null || Number.isNaN(n)) return { text: "—", leader: false };
  const abs = Math.abs(n);
  // Целое = отставание по кругам, дробное = секунды.
  if (Number.isInteger(abs) && abs >= 1) {
    return { text: `+${abs} ${abs === 1 ? "круг" : "кр."}`, leader: false };
  }
  return { text: `+${abs.toFixed(3)}`, leader: false };
}

function manufacturer(raw) {
  if (!raw) return "—";
  const key = String(raw).trim().toLowerCase();
  return MANUFACTURERS[key] || raw;
}

function lapsLedTotal(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.reduce((sum, seg) => {
    const start = num(seg?.start_lap);
    const end = num(seg?.end_lap);
    if (start === null || end === null) return sum;
    return sum + Math.max(0, end - start + 1);
  }, 0);
}

// ---------- Рендер шапки ----------
function renderHeader(d) {
  const flag = FLAGS[d.flag_state] || { cls: "", text: "—" };
  el.flagChip.className = `flag-chip ${flag.cls}`;
  el.flagChip.textContent = flag.text;

  el.runName.textContent = d.run_name || SERIES[d.series_id] || "NASCAR";
  const track = d.track_name || "";
  const len = num(d.track_length);
  el.trackName.textContent = len ? `${track} · ${len} миль` : track || "—";

  if (SERIES[d.series_id]) {
    el.seriesBadge.textContent = SERIES[d.series_id];
    el.seriesBadge.hidden = false;
  } else {
    el.seriesBadge.hidden = true;
  }

  const lap = num(d.lap_number);
  const total = num(d.laps_in_race);
  el.lapValue.textContent = lap !== null ? (total ? `${lap}/${total}` : `${lap}`) : "—";

  const toGo = num(d.laps_to_go);
  el.toGoValue.textContent = toGo !== null ? toGo : "—";

  const st = d.stage;
  el.stageValue.textContent = st && num(st.stage_num) ? st.stage_num : "—";

  el.cautionValue.textContent = num(d.number_of_caution_segments) ?? "—";
  el.leadersValue.textContent = num(d.number_of_leaders) ?? "—";
}

// ---------- Рендер строки ----------
function statusPill(v) {
  // is_on_track true → на трассе; status: 1 running. Иначе пит/сход.
  if (v.is_on_track === false) {
    return `<span class="status-pill out">Пит / оф</span>`;
  }
  if (num(v.status) && num(v.status) !== 1) {
    return `<span class="status-pill pit">В боксах</span>`;
  }
  return `<span class="status-pill track">На трассе</span>`;
}

function rowHTML(v) {
  const pos = num(v.running_position) ?? 0;
  const car = v.vehicle_number ?? "?";
  const name = v.driver?.full_name || `${v.driver?.first_name ?? ""} ${v.driver?.last_name ?? ""}`.trim() || "—";
  const make = manufacturer(v.vehicle_manufacturer);
  const laps = num(v.laps_completed) ?? 0;
  const gap = fmtGap(v.delta, pos);
  const lastT = fmtLapTime(v.last_lap_time);
  const lastS = fmtSpeed(v.last_lap_speed);

  const isOpen = openRows.has(String(car));
  const leaderCls = pos === 1 ? "leader" : "";

  // Подстрока под именем (важно для мобильной вёрстки, где часть колонок скрыта)
  const subParts = [make, `круг ${laps}`, lastT !== "—" ? lastT : null].filter(Boolean);

  const detail = detailHTML(v);

  return `
    <div class="row ${leaderCls} ${isOpen ? "open" : ""}" data-car="${car}">
      <div class="row-main" role="row" tabindex="0" aria-expanded="${isOpen}">
        <span class="col-pos">${pos || "—"}</span>
        <span class="col-num">${car}</span>
        <span class="col-driver">
          <span class="driver-name">${escapeHTML(name)}</span>
          <span class="driver-sub">${escapeHTML(subParts.join(" · "))}</span>
        </span>
        <span class="col-make">${escapeHTML(make)}</span>
        <span class="col-laps">${laps}</span>
        <span class="col-gap ${gap.leader ? "leader-gap" : ""}">${gap.text}</span>
        <span class="col-last">
          <span class="lap-time">${lastT}</span>
          ${lastS ? `<br><span class="lap-speed">${lastS}</span>` : ""}
        </span>
        <span class="col-status">${statusPill(v)}</span>
      </div>
      <div class="row-details">${detail}</div>
    </div>`;
}

function detailHTML(v) {
  const items = [
    ["Стартовал", num(v.starting_position) ?? "—"],
    ["Лучший круг", fmtLapTime(v.best_lap_time)],
    ["Лучшая скорость", fmtSpeed(v.best_lap_speed) || "—"],
    ["Средняя позиция", (num(v.average_running_position) ?? null) !== null ? num(v.average_running_position).toFixed(1) : "—"],
    ["Δ за 10 кругов", fmtDiff(v.position_differential_last_10_laps)],
    ["Лидировал кругов", lapsLedTotal(v.laps_led) ?? "—"],
    ["Пит-стопов", Array.isArray(v.pit_stops) ? v.pit_stops.length : (num(v.pit_stops) ?? "—")],
    ["Марка", manufacturer(v.vehicle_manufacturer)],
  ];
  const cells = items
    .map(([label, val]) => `
      <div class="detail-item">
        <span class="d-label">${label}</span>
        <span class="d-value">${escapeHTML(String(val))}</span>
      </div>`)
    .join("");
  const sponsor = v.sponsor_name ? `<div class="detail-sponsor">${escapeHTML(v.sponsor_name)}</div>` : "";
  return `<div class="detail-grid">${cells}</div>${sponsor}`;
}

function fmtDiff(v) {
  const n = num(v);
  if (n === null || Number.isNaN(n)) return "—";
  if (n > 0) return `▲ ${n}`;
  if (n < 0) return `▼ ${Math.abs(n)}`;
  return "0";
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Рендер табло ----------
function renderBoard(data) {
  const vehicles = Array.isArray(data.vehicles) ? [...data.vehicles] : [];

  if (vehicles.length === 0) {
    el.board.hidden = true;
    el.emptyState.hidden = false;
    return;
  }

  el.emptyState.hidden = true;
  el.board.hidden = false;

  vehicles.sort((a, b) => (num(a.running_position) ?? 999) - (num(b.running_position) ?? 999));
  el.rows.innerHTML = vehicles.map(rowHTML).join("");
}

// ---------- Обновление статуса опроса ----------
function setRefresh(state, text) {
  el.refreshStatus.className = `refresh ${state}`;
  el.refreshStatus.textContent = text;
}

// ---------- Загрузка ----------
async function poll() {
  if (demoMode) return;
  try {
    const res = await fetch(`${FEED_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastOkAt = Date.now();
    renderHeader(data);
    renderBoard(data);
    setRefresh("", "Обновлено только что");
  } catch (err) {
    const ageSec = lastOkAt ? Math.round((Date.now() - lastOkAt) / 1000) : null;
    if (ageSec === null) {
      setRefresh("error", "Не удалось загрузить фид");
      showEmpty("Нет данных", "Не удалось связаться с фидом NASCAR. Проверьте соединение — повтор каждые 2 сек.");
    } else {
      setRefresh("error", `Нет связи · последнее обновление ${ageSec} сек назад`);
    }
  }
}

function tickStaleness() {
  if (demoMode || !lastOkAt) return;
  const ageSec = Math.round((Date.now() - lastOkAt) / 1000);
  if (ageSec * 1000 > STALE_MS) {
    setRefresh("stale", `Обновлено ${ageSec} сек назад`);
  }
}

function showEmpty(title, text) {
  el.board.hidden = true;
  el.emptyState.hidden = false;
  if (title) el.emptyTitle.textContent = title;
  if (text) el.emptyText.textContent = text;
}

// ---------- Управление опросом (пауза на скрытой вкладке) ----------
function startPolling() {
  if (timer) return;
  poll();
  timer = setInterval(() => { poll(); tickStaleness(); }, POLL_MS);
}
function stopPolling() {
  clearInterval(timer);
  timer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
    if (!demoMode) setRefresh("paused", "Пауза (вкладка неактивна)");
  } else if (!demoMode) {
    startPolling();
  }
});

// ---------- Раскрытие строк (делегирование) ----------
el.rows.addEventListener("click", (e) => toggleRow(e.target.closest(".row")));
el.rows.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleRow(e.target.closest(".row"));
  }
});
function toggleRow(row) {
  if (!row) return;
  const car = row.dataset.car;
  if (openRows.has(car)) { openRows.delete(car); row.classList.remove("open"); }
  else { openRows.add(car); row.classList.add("open"); }
  const main = row.querySelector(".row-main");
  if (main) main.setAttribute("aria-expanded", openRows.has(car));
}

// ---------- Демо-режим ----------
el.demoBtn.addEventListener("click", () => {
  demoMode = true;
  stopPolling();
  el.modeNote.textContent = "ДЕМО-режим";
  setRefresh("paused", "Демо-данные (не в эфире)");
  renderHeader(DEMO.top);
  renderBoard(DEMO);
});

// ---------- Старт ----------
setRefresh("", "Загрузка…");
startPolling();

// ---------- Демо-данные (образец структуры фида) ----------
const DEMO = {
  run_name: "Демо 400",
  track_name: "Demo Motor Speedway",
  track_length: 1.5,
  series_id: 1,
  flag_state: 1,
  lap_number: 168,
  laps_in_race: 267,
  laps_to_go: 99,
  number_of_caution_segments: 4,
  number_of_leaders: 6,
  stage: { stage_num: 3, finish_at_lap: 267, laps_in_stage: 107 },
  get top() { return this; },
  vehicles: [
    demoCar(1, "5", "Kyle Larson", "Chevrolet", 168, null, 30.114, 179.3, 29.902, 180.6, 3.1, 12, 4, 2, 62, 3),
    demoCar(2, "24", "William Byron", "Chevrolet", 168, 0.842, 30.201, 178.8, 29.977, 180.1, 2.4, 1, 3, 1, 21, 5),
    demoCar(3, "11", "Denny Hamlin", "Toyota", 168, 1.933, 30.255, 178.5, 30.011, 179.9, 4.0, 6, 2, 3, 18, -1),
    demoCar(4, "22", "Joey Logano", "Ford", 168, 3.512, 30.377, 177.8, 30.102, 179.3, 5.2, 3, 3, 4, 9, 0),
    demoCar(5, "9", "Chase Elliott", "Chevrolet", 168, 4.870, 30.410, 177.6, 30.155, 179.0, 6.6, 8, 2, 5, 4, 2),
    demoCar(6, "20", "Christopher Bell", "Toyota", 167, 1, 30.588, 176.5, 30.201, 178.7, 7.3, 4, 3, 6, 6, -2),
    demoCar(7, "12", "Ryan Blaney", "Ford", 167, 1, 30.611, 176.4, 30.244, 178.5, 8.1, 5, 2, 7, 0, 1),
    demoCar(8, "48", "Alex Bowman", "Chevrolet", 167, 1, 30.702, 175.9, 30.312, 178.1, 9.0, 15, 3, 8, 0, 0),
  ],
};

function demoCar(pos, num, name, make, laps, delta, lastT, lastS, bestT, bestS, avg, start, pits, bestRank, led, diff10) {
  return {
    running_position: pos,
    vehicle_number: num,
    driver: { full_name: name },
    vehicle_manufacturer: make,
    laps_completed: laps,
    delta: delta,
    last_lap_time: lastT,
    last_lap_speed: lastS,
    best_lap_time: bestT,
    best_lap_speed: bestS,
    average_running_position: avg,
    starting_position: start,
    pit_stops: Array.from({ length: pits }),
    laps_led: led ? [{ start_lap: 1, end_lap: led }] : [],
    position_differential_last_10_laps: diff10,
    is_on_track: true,
    status: 1,
    sponsor_name: `${make} Racing`,
  };
}
