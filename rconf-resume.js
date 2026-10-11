/* =====================================================================
   rconf-resume.js — retomada da conferência em andamento (home)

   Fonte principal: o SERVIDOR (API). Se houver conferência em andamento,
   transforma a barra de status em "X de N produtos conferidos" e reinicia
   a tela de conferência no ponto exato.

   Isolamento entre contas:
   - dados locais são sempre da MESMA conta (guardados por ID, nunca por nome);
   - uma conferência local NUNCA é enviada ao servidor em automático: se o
     servidor não tem conferência e existe cópia local da mesma conta, a barra
     leva a "Nova Conferência", onde a recuperação é EXPLÍCITA (botão
     "Continuar"). Sem API, retoma direto da cópia local.
   ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  var R = window.Rconf;
  if (!R || !R.session || !R.conf) return;
  var u = R.session.user();
  if (!u) return;

  var localConf = R.conf.get(u);
  var api = window.RconfApi;
  var st = document.querySelector(".status");
  if (!st) return;

  function fmt(n) { return Number(n || 0).toLocaleString("pt-BR"); }

  function paint(conf, target) {
    if (!conf || !conf.produtos || !conf.produtos.length) return;
    target = target || "conferencia.html";
    var feitos = 0;
    for (var i = 0; i < conf.produtos.length; i++) if (conf.produtos[i].status === "conferido") feitos++;
    var total = conf.produtos.length;

    st.style.pointerEvents = "auto";
    st.style.cursor = "pointer";
    st.style.borderColor = "rgba(255,122,26,.42)";
    st.setAttribute("role", "button");
    st.setAttribute("data-resume", target);

    var p = st.querySelector("p");
    if (p) p.textContent = fmt(feitos) + " de " + fmt(total) + " produtos conferidos";
    var tag = st.querySelector(".tag");
    if (tag) { tag.textContent = "Em andamento"; tag.style.color = "#ffa14a"; tag.style.borderColor = "rgba(255,122,26,.5)"; }
    var orb = st.querySelector(".orb");
    if (orb) orb.style.background = "#ff7a1a";

    st.addEventListener("click", function () { window.location.href = target; });
    window.RCONF_CONF = conf;
  }

  function mirror(conf) { try { R.conf.save(u, conf); } catch (e) {} }

  function paintCount(n, target) {
    if (!n) return;
    target = target || "historico.html";
    st.style.pointerEvents = "auto";
    st.style.cursor = "pointer";
    st.style.borderColor = "rgba(255,122,26,.42)";
    st.setAttribute("role", "button");
    st.setAttribute("data-resume", target);

    var p = st.querySelector("p");
    if (p) p.textContent = n + " conferências em andamento";
    var tag = st.querySelector(".tag");
    if (tag) { tag.textContent = "Em andamento"; tag.style.color = "#ffa14a"; tag.style.borderColor = "rgba(255,122,26,.5)"; }
    var orb = st.querySelector(".orb");
    if (orb) orb.style.background = "#ff7a1a";

    st.addEventListener("click", function () { window.location.href = target; });
  }

  if (api && typeof api.confList === "function") {
    api.confList().then(function (d) {
      var open = (d && d.conferencias) || [];
      if (open.length === 1) {
        mirror(open[0]);
        paint(open[0], "conferencia.html?id=" + encodeURIComponent(open[0].id));
        return;
      }
      if (open.length > 1) {
        paintCount(open.length, "historico.html");   // várias: escolhe no histórico
        return;
      }
      // Sem conferência no servidor: NUNCA enviar automaticamente a cópia
      // local. Se existir cópia local da MESMA conta, leva a "Nova
      // Conferência", onde a recuperação é explícita (botão "Continuar").
      if (localConf) paint(localConf, "nova-conferencia.html");
    }).catch(function () { paint(localConf); });
  } else {
    var locais = (R.confs && R.confs.list) ? R.confs.list(u) : [];
    if (locais.length > 1) { paintCount(locais.length, "historico.html"); return; }
    paint(localConf);
  }
})();
