// WeMediaBuddy 设计原型 — 交互脚本
// 仅用于设计审核：视图切换、面包屑、Pi 停靠栏收起、画布点选/拖动/缩放

(function () {
  document.getElementById("prototype-viewport").innerHTML = Object.values(window.prototypeViews || {}).join("");

  var VIEW_NAMES = {
    today: "今日",
    knowledge: "知识系统",
    library: "资料库",
    canvas: "知识系统 / 关系画布",
    studio: "创作 / 编辑项目",
    publish: "发布",
    results: "结果",
    settings: "设置"
  };

  // ---- 视图切换 ----
  var navItems = document.querySelectorAll(".nav-item[data-view]");
  var crumbs = document.getElementById("crumbs");
  navItems.forEach(function (btn) {
    btn.addEventListener("click", function () {
      navItems.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      var name = btn.getAttribute("data-view");
      document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
      document.getElementById("view-" + name).classList.add("active");
      crumbs.innerHTML = "<b>" + VIEW_NAMES[name] + "</b>";
    });
  });

  // ---- Pi 停靠栏收起 ----
  var dock = document.getElementById("dock");
  var dockToggle = document.getElementById("dock-toggle");
  dockToggle.addEventListener("click", function () {
    dock.classList.toggle("collapsed");
    dockToggle.textContent = dock.classList.contains("collapsed") ? "⇤" : "⇥";
  });

  // ---- 画布：缩放 ----
  var field = document.getElementById("canvas-field");
  var zoomLabel = document.getElementById("zoom-label");
  var zoom = 1;
  function applyZoom() {
    field.style.transform = "scale(" + zoom + ")";
    field.style.transformOrigin = "0 0";
    zoomLabel.textContent = Math.round(zoom * 100) + "%";
  }
  document.getElementById("zoom-in").addEventListener("click", function () {
    zoom = Math.min(2, +(zoom + 0.1).toFixed(2)); applyZoom();
  });
  document.getElementById("zoom-out").addEventListener("click", function () {
    zoom = Math.max(0.5, +(zoom - 0.1).toFixed(2)); applyZoom();
  });

  // ---- 画布：节点选择与拖动 ----
  var nodes = Array.prototype.slice.call(document.querySelectorAll("[data-node]"));
  var selCount = document.getElementById("sel-count");
  var selectionBar = document.getElementById("selection-bar");
  var edgesSvg = document.getElementById("edges");

  function updateSelectionUI() {
    var n = nodes.filter(function (el) { return el.classList.contains("selected"); }).length;
    selCount.textContent = n;
    selectionBar.style.display = n > 0 ? "flex" : "none";
  }

  function drawEdges() {
    // 依据节点当前位置绘制三条示意关系
    edgesSvg.innerHTML = "";
    var wrap = field.getBoundingClientRect();
    function center(el) {
      return {
        x: el.offsetLeft + el.offsetWidth / 2,
        y: el.offsetTop + el.offsetHeight / 2
      };
    }
    var pairs = [
      [nodes[1], nodes[0], "支持"],
      [nodes[2], nodes[0], "反向验证"],
      [nodes[3], nodes[0], "判断"]
    ];
    pairs.forEach(function (p) {
      var a = center(p[0]), b = center(p[1]);
      var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
      line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
      line.setAttribute("stroke", "rgba(139,124,255,0.45)");
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("stroke-dasharray", p[2] === "反向验证" ? "5 4" : "none");
      edgesSvg.appendChild(line);
      // 边标签
      var label = document.createElement("div");
      label.className = "edge-label";
      label.textContent = p[2];
      label.style.left = (a.x + b.x) / 2 + "px";
      label.style.top = (a.y + b.y) / 2 + "px";
      field.appendChild(label);
    });
    // 清理旧标签（重绘时）
    Array.prototype.slice.call(field.querySelectorAll(".edge-label")).forEach(function (el, i, all) {
      if (i < all.length - pairs.length) el.remove();
    });
  }

  var dragState = null;
  nodes.forEach(function (el) {
    el.addEventListener("pointerdown", function (e) {
      dragState = { el: el, startX: e.clientX, startY: e.clientY, left: el.offsetLeft, top: el.offsetTop, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", function (e) {
      if (!dragState || dragState.el !== el) return;
      var dx = (e.clientX - dragState.startX) / zoom;
      var dy = (e.clientY - dragState.startY) / zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
      if (dragState.moved) {
        el.style.left = dragState.left + dx + "px";
        el.style.top = dragState.top + dy + "px";
        drawEdges();
      }
    });
    el.addEventListener("pointerup", function () {
      if (dragState && dragState.el === el && !dragState.moved) {
        el.classList.toggle("selected");
        updateSelectionUI();
      }
      dragState = null;
    });
  });

  // 点击空白清除选择（恢复当前页上下文）
  field.addEventListener("pointerdown", function (e) {
    if (e.target === field || e.target === edgesSvg) {
      nodes.forEach(function (el) { el.classList.remove("selected"); });
      updateSelectionUI();
    }
  });

  document.getElementById("sel-clear").addEventListener("click", function () {
    nodes.forEach(function (el) { el.classList.remove("selected"); });
    updateSelectionUI();
  });

  // ---- 设置页左侧锚点 ----
  var setNavBtns = document.querySelectorAll(".set-nav button");
  setNavBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      setNavBtns.forEach(function (x) { x.classList.remove("on"); });
      b.classList.add("on");
    });
  });

  // ---- 开关 ----
  document.querySelectorAll(".toggle").forEach(function (t) {
    t.addEventListener("click", function () { t.classList.toggle("on"); });
  });

  // ---- 资料库筛选 chips（视觉态） ----
  document.querySelectorAll(".lib-toolbar").forEach(function (bar) {
    bar.querySelectorAll(".chip").forEach(function (c) {
      c.addEventListener("click", function () { c.classList.toggle("on"); });
    });
  });

  // 初始化
  updateSelectionUI();
  // 等布局完成后画边
  requestAnimationFrame(drawEdges);

  // 原型说明浮条 8 秒后淡出
  setTimeout(function () {
    var note = document.getElementById("proto-note");
    note.style.transition = "opacity .6s";
    note.style.opacity = "0";
    setTimeout(function () { note.remove(); }, 700);
  }, 9000);
})();
