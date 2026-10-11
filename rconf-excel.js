/* =====================================================================
   rconf-excel.js — leitura/validação de planilhas Excel (offline)

   Usa a biblioteca local `vendor/xlsx.full.min.js` (SheetJS, sem CDN).
   O parser em si (`parseRows`) é puro e testável sem navegador.

   Formato esperado (somente 3 colunas obrigatórias):
     Código | Descrição | Quantidade
   Cabeçalhos são detectados de forma tolerante a maiúsculas/minúsculas,
   acentos e espaços extras, e podem estar em qualquer ordem.
   ===================================================================== */
(function (root) {
  "use strict";

  /* ---------- normalização de texto de cabeçalho ---------- */
  function normHeader(s) {
    return String(s == null ? "" : s)
      .replace(/\u00a0/g, " ")
      .trim()
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  var ALIASES = {
    codigo: ["codigo", "cod", "codigos", "codigo do produto", "codigo produto", "cod produto", "sku", "referencia", "ref", "codigo interno", "cod item", "codigo item"],
    descricao: ["descricao", "descricao do produto", "descricao produto", "desc", "descricao do item", "produto", "nome", "nome do produto", "nome produto", "item"],
    quantidade: ["quantidade", "quantidade esperada", "qtd", "qtde", "qnt", "quant", "quantidade total", "estoque", "saldo", "qte", "quantidade estoque"]
  };

  function matchField(value) {
    var n = normHeader(value);
    if (!n) return null;
    for (var f in ALIASES) {
      if (ALIASES[f].indexOf(n) >= 0) return f;
    }
    return null;
  }

  /* ---------- conversão de quantidade (aceita número ou texto) ---------- */
  function toNumber(v) {
    if (typeof v === "number") return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    var s = String(v).replace(/\u00a0/g, " ").trim();
    if (!s) return NaN;
    s = s.replace(/[^0-9.,-]/g, "");
    if (!s) return NaN;
    if (s.indexOf(",") >= 0 && s.indexOf(".") >= 0) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (s.indexOf(",") >= 0) {
      s = s.replace(",", ".");
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, "");
    }
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  /* ---------- núcleo: analisa uma matriz de linhas (array de arrays) ---------- */
  function parseRows(rows) {
    if (!rows || !rows.length) return { ok: false, status: "empty", erro: "A planilha está vazia.", produtos: [], duplicados: [], faltando: [], totalEsperado: 0, codigos: 0 };

    /* 1) acha a linha de cabeçalho entre as primeiras linhas */
    var headerRow = -1, colMap = {};
    var scan = Math.min(rows.length, 10);
    for (var r = 0; r < scan; r++) {
      var line = rows[r] || [];
      var map = {}, encontrados = 0;
      for (var c = 0; c < line.length; c++) {
        var f = matchField(line[c]);
        if (f && !(f in map)) { map[f] = c; encontrados++; }
      }
      if (encontrados > Object.keys(colMap).length) { colMap = map; headerRow = r; }
    }

    var obrigatorios = ["codigo", "descricao", "quantidade"];
    var faltando = obrigatorios.filter(function (f) { return !(f in colMap); });
    if (faltando.length) {
      return { ok: false, status: "missing_columns", erro: "Colunas obrigatórias ausentes: " + faltando.join(", "), faltando: faltando, produtos: [], duplicados: [], totalEsperado: 0, codigos: 0 };
    }

    /* 2) lê as linhas de dados */
    var produtos = [], vistos = {}, duplicados = [];
    for (var i = headerRow + 1; i < rows.length; i++) {
      var row = rows[i] || [];
      var codigoRaw = row[colMap.codigo];
      var codigo = codigoRaw == null ? "" : String(codigoRaw).replace(/\u00a0/g, " ").trim();
      var descricao = row[colMap.descricao] == null ? "" : String(row[colMap.descricao]).trim();
      var qtdRaw = row[colMap.quantidade];
      if (!codigo && !descricao && (qtdRaw == null || String(qtdRaw).trim() === "")) continue; // linha vazia
      if (!codigo) continue; // ignora linhas sem código
      var key = codigo.toUpperCase();
      if (vistos[key] !== undefined) { if (duplicados.indexOf(codigo) < 0) duplicados.push(codigo); continue; }
      vistos[key] = true;
      var q = toNumber(qtdRaw);
      produtos.push({ codigo: codigo, descricao: descricao, esperado: isNaN(q) ? 0 : q, conferido: null, status: "pendente" });
    }

    var totalEsperado = produtos.reduce(function (a, p) { return a + p.esperado; }, 0);

    if (!produtos.length) return { ok: false, status: "empty", erro: "Nenhum produto encontrado na planilha.", produtos: [], duplicados: [], faltando: [], totalEsperado: 0, codigos: 0 };

    if (duplicados.length) {
      return { ok: false, status: "duplicates", erro: "Existem códigos duplicados na planilha.", duplicados: duplicados, faltando: [], produtos: produtos, totalEsperado: totalEsperado, codigos: produtos.length };
    }

    return {
      ok: true, status: "ok", erro: null,
      headerRow: headerRow, colunas: colMap,
      produtos: produtos, duplicados: [], faltando: [],
      totalEsperado: totalEsperado, codigos: produtos.length
    };
  }

  /* ---------- a partir de um ArrayBuffer .xlsx/.xls ---------- */
  function parseArrayBuffer(ab, XLSX) {
    var lib = XLSX || root.XLSX;
    if (!lib) return { ok: false, status: "no_lib", erro: "Leitor de Excel indisponível.", produtos: [], duplicados: [], faltando: [], totalEsperado: 0, codigos: 0 };
    var wb;
    try { wb = lib.read(new Uint8Array(ab), { type: "array", dense: false }); }
    catch (e) { return { ok: false, status: "read_error", erro: "Não foi possível ler o arquivo. Use .xlsx ou .xls.", produtos: [], duplicados: [], faltando: [], totalEsperado: 0, codigos: 0 }; }
    if (!wb || !wb.SheetNames || !wb.SheetNames.length) return { ok: false, status: "empty", erro: "A planilha está vazia.", produtos: [], duplicados: [], faltando: [], totalEsperado: 0, codigos: 0 };
    var ws = wb.Sheets[wb.SheetNames[0]];
    var rows = lib.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null, raw: true });
    return parseRows(rows);
  }

  var api = { parseRows: parseRows, parseArrayBuffer: parseArrayBuffer, normHeader: normHeader, matchField: matchField, toNumber: toNumber, ALIASES: ALIASES };
  root.RconfExcel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
