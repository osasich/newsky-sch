(() => {
  "use strict";

  const SCRIPT_URL = document.currentScript?.src || location.href;
  const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const DAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  const AIRPORT_ALIASES = [
    [/борисп|бориспіл|borysp|borisp/i, "UKBB"],
    [/риг|riga/i, "EVRA"],
    [/кишин|chișinău|chisinau/i, "LUKK"],
    [/львів|львов|lviv/i, "UKLL"],
    [/одес|odes/i, "UKOO"],
    [/харків|харьков|khark/i, "UKHH"],
  ];
  const state = {
    flights: [],
    airports: {},
    airportStats: new Map(),
    markers: new Map(),
    routeLayers: [],
    canvasRenderer: null,
    map: null,
    markerLayer: null,
    routeLayer: null,
    type: "all",
    day: "all",
    airframe: "all",
    search: "",
    selectedAirport: null,
    airportMode: "outbound",
    selectedRoute: null,
    explicitPair: null,
    detailBack: null,
    toastTimer: null,
  };

  const dom = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    bindStaticEvents();
    initMap();

    try {
      const [csvText, airportResponse] = await Promise.all([
        fetch(new URL("../data/schedules.csv", SCRIPT_URL)).then(assertResponse).then((response) => response.text()),
        fetch(new URL("../data/airports.json", SCRIPT_URL)).then(assertResponse).then((response) => response.json()),
      ]);
      state.airports = airportResponse;
      state.flights = normalizeFlights(parseCsv(csvText));
      buildAirportStats();
      populateControls();
      renderMarkers();
      updateSummary();
      applyCurrentView(false);
      restoreHashSelection();
      if (!location.hash) fitNetwork();
      dom.loadingScreen.classList.add("done");
    } catch (error) {
      console.error(error);
      dom.loadingScreen.classList.add("done");
      dom.filterResult.innerHTML = "<span class=\"error-text\">Не вдалося прочитати дані розкладу.</span>";
      showToast("Не вдалося завантажити CSV або координати аеропортів.");
    }
  }

  function assertResponse(response) {
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`);
    return response;
  }

  function cacheDom() {
    const ids = [
      "summary-schedules", "summary-airports", "search-panel", "mobile-filter-button", "close-mobile-filters",
      "route-form", "origin-input", "destination-input", "airport-options", "roundtrip-input", "swap-route",
      "flight-search", "type-filter", "day-filter", "airframe-filter", "reset-filters", "filter-result",
      "fit-map", "clear-selection", "details-panel", "details-empty", "details-content", "loading-screen", "toast",
      "brand-home",
    ];
    ids.forEach((id) => { dom[toCamel(id)] = document.getElementById(id); });
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  }

  function bindStaticEvents() {
    dom.routeForm.addEventListener("submit", handleRouteSearch);
    dom.swapRoute.addEventListener("click", () => {
      const current = dom.originInput.value;
      dom.originInput.value = dom.destinationInput.value;
      dom.destinationInput.value = current;
    });
    dom.flightSearch.addEventListener("input", debounce(() => {
      state.search = dom.flightSearch.value.trim().toLowerCase();
      applyCurrentView(false);
    }, 120));

    dom.typeFilter.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-type]");
      if (!button) return;
      state.type = button.dataset.type;
      setActiveButton(dom.typeFilter, button);
      applyCurrentView(false);
    });
    dom.dayFilter.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-day]");
      if (!button) return;
      state.day = button.dataset.day;
      setActiveButton(dom.dayFilter, button);
      applyCurrentView(false);
    });
    dom.airframeFilter.addEventListener("change", () => {
      state.airframe = dom.airframeFilter.value;
      applyCurrentView(false);
    });
    dom.resetFilters.addEventListener("click", resetFilters);
    dom.fitMap.addEventListener("click", fitNetwork);
    dom.clearSelection.addEventListener("click", clearSelection);
    dom.brandHome.addEventListener("click", (event) => { event.preventDefault(); clearSelection(); fitNetwork(); });
    dom.mobileFilterButton.addEventListener("click", () => toggleMobileFilters(true));
    dom.closeMobileFilters.addEventListener("click", () => toggleMobileFilters(false));

    document.addEventListener("keydown", (event) => {
      const shortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (shortcut) {
        event.preventDefault();
        if (window.innerWidth <= 820) toggleMobileFilters(true);
        dom.flightSearch.focus();
      }
      if (event.key === "Escape") {
        toggleMobileFilters(false);
        if (state.selectedAirport || state.selectedRoute || state.explicitPair) clearSelection();
      }
    });
  }

  function initMap() {
    state.map = L.map("map", {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 2,
      maxZoom: 11,
      worldCopyJump: true,
      attributionControl: true,
    }).setView([47, 27], 4);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      subdomains: "abc",
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(state.map);

    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    state.canvasRenderer = L.canvas({ padding: .5 });
    state.markerLayer = L.layerGroup().addTo(state.map);
    state.routeLayer = L.layerGroup().addTo(state.map);
  }

  function parseCsv(text) {
    const cleaned = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .join("\n");
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let index = 0; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      const next = cleaned[index + 1];
      if (char === '"' && quoted && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        row.push(field);
        field = "";
      } else if (char === "\n" && !quoted) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (char !== "\r") {
        field += char;
      }
    }
    row.push(field);
    rows.push(row);
    const headers = rows.shift().map((value) => value.trim());
    return rows
      .filter((values) => values.some((value) => value !== ""))
      .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }

  function normalizeFlights(rows) {
    return rows.map((row, index) => {
      const days = Object.fromEntries(DAY_KEYS.map((day) => [day, row[day].toLowerCase() === "true"]));
      const rawAirframes = row.airframes.trim();
      return {
        id: `${row.number}-${row.dep}-${row.arr}-${index}`,
        number: row.number.trim(),
        dep: row.dep.trim().toUpperCase(),
        arr: row.arr.trim().toUpperCase(),
        type: row.type.trim().toLowerCase(),
        duration: Number(row.duration) || 0,
        days,
        frequency: DAY_KEYS.reduce((total, day) => total + (days[day] ? 1 : 0), 0),
        airframes: rawAirframes,
        airframeList: rawAirframes.toLowerCase() === "pax" || rawAirframes.toLowerCase() === "cargo"
          ? []
          : rawAirframes.split(",").map((item) => item.trim()).filter(Boolean),
        active: row.active.toLowerCase() === "true",
      };
    });
  }

  function buildAirportStats() {
    const stats = new Map();
    Object.keys(state.airports).forEach((code) => {
      stats.set(code, { departures: 0, arrivals: 0, weeklyOut: 0, weeklyIn: 0, pax: 0, cargo: 0 });
    });
    state.flights.forEach((flight) => {
      const dep = stats.get(flight.dep);
      const arr = stats.get(flight.arr);
      if (dep) {
        dep.departures += 1;
        dep.weeklyOut += flight.frequency;
        dep[flight.type] += flight.frequency;
      }
      if (arr) {
        arr.arrivals += 1;
        arr.weeklyIn += flight.frequency;
      }
    });
    state.airportStats = stats;
  }

  function populateControls() {
    const airports = Object.values(state.airports).sort((a, b) => a.code.localeCompare(b.code));
    const fragment = document.createDocumentFragment();
    airports.forEach((airport) => {
      const option = document.createElement("option");
      option.value = airportInputLabel(airport);
      option.label = [airport.city, countryName(airport.country), airport.iata].filter(Boolean).join(" · ");
      fragment.appendChild(option);
    });
    dom.airportOptions.appendChild(fragment);

    const categories = new Map();
    state.flights.forEach((flight) => {
      flight.airframeList.forEach((code) => {
        if (!categories.has(code)) categories.set(code, flight.type);
      });
    });
    [...categories.keys()].sort(naturalSort).forEach((code) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = `${code} · включно із загальними ${categories.get(code).toUpperCase()}`;
      option.dataset.category = categories.get(code);
      dom.airframeFilter.appendChild(option);
    });
  }

  function updateSummary() {
    dom.summarySchedules.textContent = formatNumber(state.flights.length);
    dom.summaryAirports.textContent = formatNumber(Object.keys(state.airports).length);
  }

  function renderMarkers() {
    state.markerLayer.clearLayers();
    state.markers.clear();
    const filteredFlights = filterFlights(state.flights);
    const filteredActivity = new Map();
    filteredFlights.forEach((flight) => {
      filteredActivity.set(flight.dep, (filteredActivity.get(flight.dep) || 0) + flight.frequency);
      filteredActivity.set(flight.arr, (filteredActivity.get(flight.arr) || 0) + flight.frequency);
    });
    const topCodes = [...state.airportStats.entries()]
      .sort((a, b) => (b[1].weeklyOut + b[1].weeklyIn) - (a[1].weeklyOut + a[1].weeklyIn))
      .slice(0, 7)
      .map(([code]) => code);

    Object.values(state.airports).forEach((airport) => {
      const totalStats = state.airportStats.get(airport.code);
      const total = totalStats ? totalStats.weeklyOut + totalStats.weeklyIn : 0;
      const current = filteredActivity.get(airport.code) || 0;
      const selected = airport.code === state.selectedAirport;
      const marker = L.circleMarker([airport.lat, airport.lon], {
        renderer: state.canvasRenderer,
        radius: selected ? 10 : clamp(3.2 + Math.sqrt(total) * .32, 4, 10),
        weight: selected ? 2 : 1,
        color: selected ? "#effff8" : current ? "#9cf5d2" : "#536b72",
        fillColor: selected ? "#9cf5d2" : current ? "#56d6bd" : "#263d44",
        fillOpacity: selected ? .88 : current ? .43 : .18,
        opacity: selected ? 1 : current ? .78 : .34,
        bubblingMouseEvents: false,
      });
      const tooltipText = `${airport.code} · ${airport.city || airport.name}`;
      marker.bindTooltip(tooltipText, {
        className: "airport-label",
        direction: "top",
        offset: [0, -5],
        permanent: topCodes.includes(airport.code),
      });
      marker.on("click", () => selectAirport(airport.code));
      marker.on("mouseover", () => marker.setStyle({ fillOpacity: .9, opacity: 1 }));
      marker.on("mouseout", () => {
        if (airport.code !== state.selectedAirport) marker.setStyle({ fillOpacity: current ? .43 : .18, opacity: current ? .78 : .34 });
      });
      marker.addTo(state.markerLayer);
      state.markers.set(airport.code, marker);
    });
  }

  function applyCurrentView(zoomToContent) {
    const filtered = filterFlights(state.flights);
    updateFilterResult(filtered);
    renderMarkers();

    if (state.selectedRoute) {
      renderRouteDetail(state.selectedRoute.from, state.selectedRoute.to, state.selectedRoute.return, zoomToContent);
    } else if (state.explicitPair) {
      renderPairView(state.explicitPair.from, state.explicitPair.to, state.explicitPair.return, zoomToContent);
    } else if (state.selectedAirport) {
      renderAirportView(state.selectedAirport, zoomToContent);
    } else if (state.search) {
      const matches = filtered.slice(0, 120);
      renderSearchView(matches, zoomToContent);
    } else {
      clearRouteLayers();
      showEmptyDetails();
    }
  }

  function filterFlights(flights) {
    return flights.filter((flight) => {
      if (!flight.active) return false;
      if (state.type !== "all" && flight.type !== state.type) return false;
      if (state.day !== "all" && !flight.days[state.day]) return false;
      if (state.airframe !== "all" && !allowsAirframe(flight, state.airframe)) return false;
      if (state.search && !flightSearchText(flight).includes(state.search)) return false;
      return true;
    });
  }

  function allowsAirframe(flight, selected) {
    if (flight.airframeList.includes(selected)) return true;
    const option = dom.airframeFilter.querySelector(`option[value="${cssEscape(selected)}"]`);
    const category = option?.dataset.category;
    return flight.airframes.toLowerCase() === category;
  }

  function flightSearchText(flight) {
    const dep = state.airports[flight.dep] || {};
    const arr = state.airports[flight.arr] || {};
    return [
      flight.number, `ukl${flight.number}`, flight.dep, flight.arr, flight.type, flight.airframes,
      dep.name, dep.city, dep.iata, arr.name, arr.city, arr.iata,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function selectAirport(code, zoom = true) {
    if (!state.airports[code]) return;
    state.selectedAirport = code;
    state.airportMode = "outbound";
    state.selectedRoute = null;
    state.explicitPair = null;
    state.search = "";
    dom.flightSearch.value = "";
    dom.originInput.value = airportInputLabel(state.airports[code]);
    dom.destinationInput.value = "";
    dom.clearSelection.hidden = false;
    setHash(`airport=${code}`);
    toggleMobileFilters(false);
    renderMarkers();
    renderAirportView(code, zoom);
  }

  function renderAirportView(code, zoom) {
    const airport = state.airports[code];
    if (!airport) return;
    const filtered = filterFlights(state.flights);
    let related;
    if (state.airportMode === "inbound") related = filtered.filter((flight) => flight.arr === code);
    else if (state.airportMode === "all") related = filtered.filter((flight) => flight.dep === code || flight.arr === code);
    else related = filtered.filter((flight) => flight.dep === code);

    const groups = groupAirportRoutes(code, related, state.airportMode);
    drawRouteGroups(groups, false);
    renderAirportDetails(code, groups, related);
    if (zoom) state.map.flyTo([airport.lat, airport.lon], Math.max(state.map.getZoom(), 4), { duration: .65 });
  }

  function groupAirportRoutes(code, flights, mode) {
    const grouped = new Map();
    flights.forEach((flight) => {
      const counterpart = flight.dep === code ? flight.arr : flight.dep;
      const key = mode === "all" ? counterpart : `${flight.dep}|${flight.arr}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          from: mode === "all" ? code : flight.dep,
          to: mode === "all" ? counterpart : flight.arr,
          return: mode === "all",
          counterpart,
          flights: [],
        });
      }
      grouped.get(key).flights.push(flight);
    });
    return [...grouped.values()].sort((a, b) => weeklyOperations(b.flights) - weeklyOperations(a.flights));
  }

  function renderAirportDetails(code, groups, related) {
    const airport = state.airports[code];
    const stats = state.airportStats.get(code) || {};
    const list = groups.length
      ? groups.map((group) => routeCardHtml(group)).join("")
      : emptyResultsHtml("Немає рейсів за цими фільтрами", "Скиньте частину фільтрів або виберіть інший день.");
    const title = airport.city || airport.name;

    dom.detailsContent.innerHTML = `
      <div class="details-header">
        <div class="details-title-row">
          <div class="details-title"><span class="eyebrow">Аеропорт · ${esc(airport.iata || countryName(airport.country))}</span><h2>${esc(code)}</h2><p>${esc(title)} · ${esc(countryName(airport.country))}</p></div>
          <button class="details-close" type="button" data-action="close-details" aria-label="Закрити">×</button>
        </div>
        <div class="airport-stats">
          <div><strong>${formatNumber(stats.departures || 0)}</strong><span>розкладів звідси</span></div>
          <div><strong>${formatNumber(stats.weeklyOut || 0)}</strong><span>рейсів / тиждень</span></div>
          <div><strong>${formatNumber(groups.length)}</strong><span>напрямків зараз</span></div>
        </div>
      </div>
      <div class="tabs" role="tablist">
        <button class="${state.airportMode === "outbound" ? "active" : ""}" type="button" data-mode="outbound">Вильоти</button>
        <button class="${state.airportMode === "inbound" ? "active" : ""}" type="button" data-mode="inbound">Прильоти</button>
        <button class="${state.airportMode === "all" ? "active" : ""}" type="button" data-mode="all">Усі</button>
      </div>
      <div class="route-list">${list}</div>`;
    showDetailsContent();
    bindDetailsEvents();
  }

  function routeCardHtml(group) {
    const destination = state.airports[group.counterpart] || {};
    const routeType = summarizeType(group.flights);
    const arrow = group.return ? "↔" : "→";
    return `<button class="route-card" type="button" data-route-from="${esc(group.from)}" data-route-to="${esc(group.to)}" data-route-return="${group.return}">
      <span class="route-main"><em class="${routeType}"></em>${esc(group.from)} <i>${arrow}</i> ${esc(group.to)}</span>
      <span class="route-place">${esc(destination.city || destination.name || group.counterpart)}</span>
      <span class="route-meta"><b>${formatNumber(group.flights.length)}</b>${pluralizeFlights(group.flights.length)} · ${formatNumber(weeklyOperations(group.flights))}/тиж.</span>
    </button>`;
  }

  function bindDetailsEvents() {
    dom.detailsContent.querySelector("[data-action='close-details']")?.addEventListener("click", clearSelection);
    dom.detailsContent.querySelectorAll("button[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        state.airportMode = button.dataset.mode;
        renderAirportView(state.selectedAirport, false);
      });
    });
    dom.detailsContent.querySelectorAll("[data-route-from]").forEach((button) => {
      button.addEventListener("click", () => {
        openRouteDetail(button.dataset.routeFrom, button.dataset.routeTo, button.dataset.routeReturn === "true");
      });
    });
    dom.detailsContent.querySelector("[data-action='back-details']")?.addEventListener("click", handleDetailsBack);
  }

  function openRouteDetail(from, to, includeReturn = false, zoom = true) {
    state.selectedRoute = { from, to, return: includeReturn };
    state.detailBack = state.selectedAirport
      ? { kind: "airport", code: state.selectedAirport }
      : state.explicitPair
        ? { kind: "pair", ...state.explicitPair }
        : { kind: "search" };
    renderRouteDetail(from, to, includeReturn, zoom);
  }

  function renderRouteDetail(from, to, includeReturn, zoom) {
    const flights = filterFlights(state.flights).filter((flight) =>
      (flight.dep === from && flight.arr === to) || (includeReturn && flight.dep === to && flight.arr === from)
    );
    const groups = [{ key: `${from}|${to}`, from, to, return: includeReturn, counterpart: to, flights }];
    drawRouteGroups(groups, true);
    renderRouteDetailPanel(from, to, includeReturn, flights);
    if (zoom) fitRoute(from, to);
  }

  function renderRouteDetailPanel(from, to, includeReturn, flights) {
    const fromAirport = state.airports[from] || {};
    const toAirport = state.airports[to] || {};
    const arrow = includeReturn ? "↔" : "→";
    const cards = flights.length
      ? [...flights].sort(sortFlights).map(flightCardHtml).join("")
      : emptyResultsHtml("Рейсів не знайдено", "Змініть день, тип рейсу або фільтр літака.");
    const average = flights.length ? Math.round(flights.reduce((sum, flight) => sum + flight.duration, 0) / flights.length) : 0;
    dom.detailsContent.innerHTML = `
      <div class="route-detail-head">
        <button class="back-button" type="button" data-action="back-details">← Назад до маршрутів</button>
        <h2>${esc(from)} <span>${arrow}</span> ${esc(to)}</h2>
        <p>${esc(fromAirport.city || fromAirport.name || from)} · ${esc(toAirport.city || toAirport.name || to)}</p>
        <div class="route-detail-summary">
          <div><strong>${formatNumber(flights.length)}</strong><span>розкладів</span></div>
          <div><strong>${formatNumber(weeklyOperations(flights))}</strong><span>рейсів / тиж.</span></div>
          <div><strong>${average ? formatDuration(average) : "—"}</strong><span>середня тривалість</span></div>
        </div>
      </div>
      <div class="flight-section-title">Деталі рейсів</div>
      <div>${cards}</div>`;
    showDetailsContent();
    bindDetailsEvents();
  }

  function flightCardHtml(flight) {
    const rule = airframeRule(flight);
    return `<article class="flight-card">
      <div class="flight-card-top"><span class="flight-number">UKL ${esc(flight.number)}</span><span class="flight-kind ${flight.type === "cargo" ? "cargo" : ""}">${esc(flight.type)}</span></div>
      <div class="flight-facts">
        <div><span>Маршрут</span><strong>${esc(flight.dep)} → ${esc(flight.arr)}</strong></div>
        <div><span>Тривалість</span><strong>${formatDuration(flight.duration)}</strong></div>
      </div>
      ${weekdaysHtml(flight)}
      <div class="airframe-rule"><i></i><span>${esc(rule)}</span></div>
    </article>`;
  }

  function airframeRule(flight) {
    const normalized = flight.airframes.toLowerCase();
    if (normalized === "pax") return "Можна використовувати будь-який пасажирський літак флоту UKL.";
    if (normalized === "cargo") return "Можна використовувати будь-який вантажний літак флоту UKL.";
    if (flight.airframeList.length > 1) return `Дозволені типи літаків: ${flight.airframeList.join(" або ")}.`;
    return `Дозволений тип літака: ${flight.airframes || "будь-який доступний"}.`;
  }

  function weekdaysHtml(flight) {
    return `<div class="weekdays" aria-label="Дні виконання">${DAY_KEYS.map((day, index) => `<i class="${flight.days[day] ? "on" : ""}" title="${DAY_SHORT[index]}">${DAY_SHORT[index].slice(0, 1)}</i>`).join("")}</div>`;
  }

  function handleDetailsBack() {
    state.selectedRoute = null;
    if (state.detailBack?.kind === "airport") renderAirportView(state.detailBack.code, false);
    else if (state.detailBack?.kind === "pair") renderPairView(state.detailBack.from, state.detailBack.to, state.detailBack.return, false);
    else if (state.detailBack?.kind === "close") clearSelection();
    else renderSearchView(filterFlights(state.flights).slice(0, 120), false);
  }

  function handleRouteSearch(event) {
    event.preventDefault();
    const from = resolveAirportInput(dom.originInput.value);
    const to = resolveAirportInput(dom.destinationInput.value);
    if (!from || !to) {
      showToast("Оберіть обидва аеропорти зі списку або введіть ICAO-коди.");
      return;
    }
    if (from === to) {
      showToast("Аеропорти вильоту та прильоту мають бути різними.");
      return;
    }
    state.selectedAirport = null;
    state.selectedRoute = null;
    state.search = "";
    dom.flightSearch.value = "";
    state.explicitPair = { from, to, return: dom.roundtripInput.checked };
    state.detailBack = null;
    dom.clearSelection.hidden = false;
    dom.originInput.value = airportInputLabel(state.airports[from]);
    dom.destinationInput.value = airportInputLabel(state.airports[to]);
    setHash(`route=${from}-${to}${state.explicitPair.return ? "-return" : ""}`);
    toggleMobileFilters(false);
    renderMarkers();
    renderPairView(from, to, state.explicitPair.return, true);
  }

  function renderPairView(from, to, includeReturn, zoom) {
    const flights = filterFlights(state.flights).filter((flight) =>
      (flight.dep === from && flight.arr === to) || (includeReturn && flight.dep === to && flight.arr === from)
    );
    if (!flights.length) showToast("За вибраними фільтрами рейсів на цьому маршруті немає.");
    const group = { key: `${from}|${to}`, from, to, return: includeReturn, counterpart: to, flights };
    drawRouteGroups([group], true);
    state.detailBack = { kind: "close" };
    renderRouteDetailPanel(from, to, includeReturn, flights);
    if (zoom) fitRoute(from, to);
  }

  function renderSearchView(flights, zoom) {
    if (!state.search) return;
    const grouped = groupByDirectedRoute(flights);
    drawRouteGroups(grouped, false);
    const list = grouped.length
      ? grouped.slice(0, 80).map(routeCardHtml).join("")
      : emptyResultsHtml("Нічого не знайдено", "Спробуйте номер без префікса UKL або ICAO-код аеропорту.");
    dom.detailsContent.innerHTML = `
      <div class="details-header">
        <div class="details-title-row"><div class="details-title"><span class="eyebrow">Результати пошуку</span><h2>${formatNumber(flights.length)}</h2><p>розкладів відповідають запиту «${esc(state.search)}»</p></div><button class="details-close" type="button" data-action="close-details" aria-label="Закрити">×</button></div>
      </div><div class="route-list">${list}</div>`;
    showDetailsContent();
    bindDetailsEvents();
    if (zoom && grouped.length) fitGroups(grouped);
  }

  function groupByDirectedRoute(flights) {
    const grouped = new Map();
    flights.forEach((flight) => {
      const key = `${flight.dep}|${flight.arr}`;
      if (!grouped.has(key)) grouped.set(key, { key, from: flight.dep, to: flight.arr, return: false, counterpart: flight.arr, flights: [] });
      grouped.get(key).flights.push(flight);
    });
    return [...grouped.values()].sort((a, b) => weeklyOperations(b.flights) - weeklyOperations(a.flights));
  }

  function drawRouteGroups(groups, focused) {
    clearRouteLayers();
    groups.forEach((group) => {
      const fromAirport = state.airports[group.from];
      const toAirport = state.airports[group.to];
      if (!fromAirport || !toAirport || !group.flights.length) return;
      const type = summarizeType(group.flights);
      const color = type === "cargo" ? "#ffb757" : type === "mixed" ? "#9cf5d2" : "#43cee0";
      const points = arcPoints(fromAirport, toAirport);
      const line = L.polyline(points, {
        renderer: state.canvasRenderer, color, weight: focused ? 4 : clamp(1.8 + Math.log2(weeklyOperations(group.flights) + 1) * .55, 2, 5),
        opacity: focused ? .95 : .74, interactive: true, bubblingMouseEvents: false, smoothFactor: 1.2,
      }).addTo(state.routeLayer);
      line.bindTooltip(`${group.from} ${group.return ? "↔" : "→"} ${group.to} · ${group.flights.length} ${pluralizeFlights(group.flights.length)}`, { className: "route-tooltip", sticky: true });
      line.on("mouseover", () => line.setStyle({ weight: focused ? 5.5 : 5, opacity: 1 }));
      line.on("mouseout", () => line.setStyle({ weight: focused ? 4 : clamp(1.8 + Math.log2(weeklyOperations(group.flights) + 1) * .55, 2, 5), opacity: focused ? .95 : .74 }));
      line.on("click", () => openRouteDetail(group.from, group.to, group.return, false));
      state.routeLayers.push(line);
    });
  }

  function clearRouteLayers() {
    state.routeLayer.clearLayers();
    state.routeLayers = [];
  }

  function arcPoints(from, to) {
    let lonDelta = to.lon - from.lon;
    if (lonDelta > 180) lonDelta -= 360;
    if (lonDelta < -180) lonDelta += 360;
    const latDelta = to.lat - from.lat;
    const distance = Math.sqrt(lonDelta * lonDelta + latDelta * latDelta);
    const bend = Math.min(distance * .12, 9) * (from.code < to.code ? 1 : -1);
    const points = [];
    for (let step = 0; step <= 32; step += 1) {
      const t = step / 32;
      const lat = from.lat + latDelta * t + Math.sin(Math.PI * t) * bend;
      const lon = from.lon + lonDelta * t;
      points.push([lat, lon]);
    }
    return points;
  }

  function fitNetwork() {
    const points = Object.values(state.airports).map((airport) => [airport.lat, airport.lon]);
    if (!points.length) return;
    state.map.fitBounds(L.latLngBounds(points), mapPadding({ maxZoom: 4 }));
  }

  function fitRoute(from, to) {
    const a = state.airports[from];
    const b = state.airports[to];
    if (!a || !b) return;
    state.map.fitBounds(L.latLngBounds([[a.lat, a.lon], [b.lat, b.lon]]), mapPadding({ maxZoom: 7 }));
  }

  function fitGroups(groups) {
    const points = [];
    groups.forEach((group) => {
      [group.from, group.to].forEach((code) => {
        const airport = state.airports[code];
        if (airport) points.push([airport.lat, airport.lon]);
      });
    });
    if (points.length) state.map.fitBounds(L.latLngBounds(points), mapPadding({ maxZoom: 6 }));
  }

  function mapPadding(options = {}) {
    if (window.innerWidth <= 820) return { paddingTopLeft: [30, 30], paddingBottomRight: [30, 220], ...options };
    return { paddingTopLeft: [390, 55], paddingBottomRight: [440, 55], ...options };
  }

  function resetFilters() {
    state.type = "all";
    state.day = "all";
    state.airframe = "all";
    state.search = "";
    dom.flightSearch.value = "";
    dom.airframeFilter.value = "all";
    setActiveButton(dom.typeFilter, dom.typeFilter.querySelector("[data-type='all']"));
    setActiveButton(dom.dayFilter, dom.dayFilter.querySelector("[data-day='all']"));
    applyCurrentView(false);
  }

  function clearSelection() {
    state.selectedAirport = null;
    state.selectedRoute = null;
    state.explicitPair = null;
    state.detailBack = null;
    state.airportMode = "outbound";
    dom.originInput.value = "";
    dom.destinationInput.value = "";
    dom.clearSelection.hidden = true;
    setHash("");
    clearRouteLayers();
    renderMarkers();
    if (state.search) renderSearchView(filterFlights(state.flights).slice(0, 120), false);
    else showEmptyDetails();
  }

  function showEmptyDetails() {
    dom.detailsContent.hidden = true;
    dom.detailsEmpty.hidden = false;
    dom.detailsPanel.classList.remove("open");
  }

  function showDetailsContent() {
    dom.detailsEmpty.hidden = true;
    dom.detailsContent.hidden = false;
    dom.detailsPanel.classList.add("open");
  }

  function updateFilterResult(flights) {
    const weekly = weeklyOperations(flights);
    dom.filterResult.innerHTML = `<span><b>${formatNumber(flights.length)}</b> розкладів · <b>${formatNumber(weekly)}</b> рейсів на тиждень</span>`;
  }

  function resolveAirportInput(value) {
    const normalized = value.trim().toUpperCase();
    if (!normalized) return null;
    const prefix = normalized.match(/^([A-Z]{4})(?:\s|—|-|$)/)?.[1];
    if (prefix && state.airports[prefix]) return prefix;
    const exactCode = state.airports[normalized] ? normalized : null;
    if (exactCode) return exactCode;
    const alias = AIRPORT_ALIASES.find(([pattern]) => pattern.test(value.trim()));
    if (alias && state.airports[alias[1]]) return alias[1];
    const candidates = Object.values(state.airports).filter((airport) => {
      const text = [airport.code, airport.iata, airport.name, airport.city].filter(Boolean).join(" ").toUpperCase();
      return text.includes(normalized);
    });
    return candidates.length === 1 ? candidates[0].code : null;
  }

  function restoreHashSelection() {
    const value = location.hash.replace(/^#/, "");
    const airportMatch = value.match(/^airport=([A-Z]{4})$/i);
    const routeMatch = value.match(/^route=([A-Z]{4})-([A-Z]{4})(-return)?$/i);
    if (airportMatch && state.airports[airportMatch[1].toUpperCase()]) {
      selectAirport(airportMatch[1].toUpperCase(), false);
    } else if (routeMatch) {
      const from = routeMatch[1].toUpperCase();
      const to = routeMatch[2].toUpperCase();
      if (state.airports[from] && state.airports[to]) {
        dom.originInput.value = airportInputLabel(state.airports[from]);
        dom.destinationInput.value = airportInputLabel(state.airports[to]);
        dom.roundtripInput.checked = Boolean(routeMatch[3]);
        state.explicitPair = { from, to, return: Boolean(routeMatch[3]) };
        dom.clearSelection.hidden = false;
        renderPairView(from, to, Boolean(routeMatch[3]), false);
      }
    }
  }

  function setHash(value) {
    try {
      history.replaceState(null, "", value ? `#${value}` : location.pathname + location.search);
    } catch (_) {
      location.hash = value;
    }
  }

  function toggleMobileFilters(open) {
    dom.searchPanel.classList.toggle("open", open);
    dom.mobileFilterButton.setAttribute("aria-expanded", String(open));
  }

  function setActiveButton(container, activeButton) {
    container.querySelectorAll("button").forEach((button) => button.classList.toggle("active", button === activeButton));
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.add("show");
    state.toastTimer = setTimeout(() => dom.toast.classList.remove("show"), 3200);
  }

  function airportInputLabel(airport) {
    return `${airport.code} — ${airport.city || airport.name}`;
  }

  function countryName(code) {
    try { return new Intl.DisplayNames(["uk"], { type: "region" }).of(code) || code; }
    catch (_) { return code; }
  }

  function summarizeType(flights) {
    const types = new Set(flights.map((flight) => flight.type));
    if (types.size > 1) return "mixed";
    return types.has("cargo") ? "cargo" : "pax";
  }

  function weeklyOperations(flights) {
    return flights.reduce((total, flight) => total + flight.frequency, 0);
  }

  function formatDuration(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest} хв`;
    return rest ? `${hours} год ${String(rest).padStart(2, "0")} хв` : `${hours} год`;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("uk-UA").format(value);
  }

  function pluralizeFlights(value) {
    const mod10 = value % 10;
    const mod100 = value % 100;
    if (mod10 === 1 && mod100 !== 11) return "рейс";
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "рейси";
    return "рейсів";
  }

  function sortFlights(a, b) {
    if (a.dep !== b.dep) return a.dep.localeCompare(b.dep);
    return naturalSort(a.number, b.number);
  }

  function naturalSort(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  function emptyResultsHtml(title, text) {
    return `<div class="empty-results"><strong>${esc(title)}</strong>${esc(text)}</div>`;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }
})();
