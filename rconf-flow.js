/* =====================================================================
   rconf-flow.js — lógica pura do fluxo de conferência (testável offline)

   Não toca no DOM nem no storage: só calcula/transforma produtos.
   Usado por conferencia.html e resumo.html, e testado por flow-check.js.
   ===================================================================== */
(function (root) {
  "use strict";

  /* texto normalizado: minúsculas, sem acentos, espaços colapsados */
  function norm(s) {
    return String(s == null ? "" : s)
      .replace(/\u00a0/g, " ")
      .trim()
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  /* um produto corresponde à busca? (código OU descrição) */
  function matches(p, q) {
    var query = norm(q);
    if (!query) return true;
    return norm(p.codigo).indexOf(query) >= 0 || norm(p.descricao).indexOf(query) >= 0;
  }

  /* filtra por estado + busca. filtro: 'todos' | 'pendentes' | 'conferidos' */
  function filterList(produtos, opts) {
    opts = opts || {};
    var filtro = opts.filtro || "todos";
    var q = opts.query || "";
    return (produtos || []).filter(function (p) {
      if (filtro === "pendentes" && p.status !== "pendente") return false;
      if (filtro === "conferidos" && p.status !== "conferido") return false;
      return matches(p, q);
    });
  }

  /* progresso: {total, conferidos, faltando, pct, done} */
  function progress(produtos) {
    var list = produtos || [];
    var total = list.length, conferidos = 0;
    for (var i = 0; i < list.length; i++) if (list[i].status === "conferido") conferidos++;
    var pct = total ? Math.round((conferidos / total) * 100) : 0;
    return { total: total, conferidos: conferidos, faltando: total - conferidos, pct: pct, done: total > 0 && conferidos === total };
  }

  /* devolve nova lista com o produto marcado como conferido (ou pendente se qtd=null) */
  function setProduto(produtos, codigo, qtd) {
    return (produtos || []).map(function (p) {
      if (String(p.codigo) !== String(codigo)) return p;
      if (qtd === null || qtd === undefined) return { codigo: p.codigo, descricao: p.descricao, esperado: p.esperado, conferido: null, status: "pendente" };
      return { codigo: p.codigo, descricao: p.descricao, esperado: p.esperado, conferido: Number(qtd) || 0, status: "conferido" };
    });
  }

  /* aplica alterações pendentes (não sincronizadas) sobre a lista de produtos:
     devolve nova lista, sem alterar a original. pendentes: [{codigo, conferido}] */
  function applyPending(produtos, pendentes) {
    var list = produtos || [];
    var pends = pendentes || [];
    if (!pends.length) return list.slice();
    return list.map(function (p) {
      for (var i = 0; i < pends.length; i++) {
        var it = pends[i];
        if (it && String(p.codigo) === String(it.codigo)) {
          if (pends[i].conferido === null || pendentes[i].conferido === undefined) {
            return { codigo: p.codigo, descricao: p.descricao, esperado: p.esperado, conferido: null, status: "pendente" };
          }
          return { codigo: p.codigo, descricao: p.descricao, esperado: p.esperado, conferido: Number(pends[i].conferido) || 0, status: "conferido" };
        }
      }
      return p;
    });
  }

  function clampQty(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function formatInt(n) {
    n = Number(n) || 0;
    return n.toLocaleString("pt-BR");
  }

  /* resumo de uma conferência (idêntico ao Rconf.conf.resumo, sem depender do store) */
  function resumo(conf) {
    if (!conf || !conf.produtos) return null;
    var total = conf.produtos.length, conferidos = 0, esperadoTotal = 0, encontradoTotal = 0;
    var divergencias = [];
    for (var i = 0; i < conf.produtos.length; i++) {
      var p = conf.produtos[i];
      esperadoTotal += Number(p.esperado) || 0;
      if (p.status === "conferido") {
        conferidos++;
        encontradoTotal += Number(p.conferido) || 0;
        var dif = (Number(p.conferido) || 0) - (Number(p.esperado) || 0);
        if (dif !== 0) divergencias.push({ codigo: p.codigo, descricao: p.descricao, esperado: Number(p.esperado) || 0, conferido: Number(p.conferido) || 0, diferenca: dif });
      }
    }
    return { id: conf.id, arquivo: conf.arquivo, total: total, conferidos: conferidos, esperado: esperadoTotal, encontrado: encontradoTotal, diferencaTotal: encontradoTotal - esperadoTotal, divergencias: divergencias };
  }

  /* progresso legível para o banner de retomada: "37 de 248 produtos conferidos" */
  function resumoTexto(conf) {
    var pr = progress(conf && conf.produtos);
    return pr.conferidos + " de " + pr.total + " produtos conferidos";
  }

  function dataCurta(ts) {
    if (!ts) return "";
    try {
      var d = new Date(ts);
      return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) +
        " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  var api = {
    norm: norm, matches: matches, filterList: filterList, progress: progress,
    setProduto: setProduto, applyPending: applyPending, clampQty: clampQty, formatInt: formatInt,
    resumo: resumo, resumoTexto: resumoTexto, dataCurta: dataCurta
  };
  root.RconfFlow = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
