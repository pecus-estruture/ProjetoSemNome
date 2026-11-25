import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const env = (primary, ...aliases) => {
  for (const name of [primary, ...aliases]) {
    if (process.env[name]?.trim()) return process.env[name].trim();
  }
  return "";
};

const PORT = Number(process.env.PORT || 3000);
const PNCP_API_BASE_URL = (env("PNCP_API_BASE_URL", "PNCP_API_URL") || "https://pncp.gov.br/api/consulta/v1").replace(/\/+$/, "");
const NVIDIA_API_URL = env("NVIDIA_API_URL", "NVIDIA_API_BASE_URL") || "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_API_KEY = env("NVIDIA_API_KEY");
const NVIDIA_MODEL = env("NVIDIA_MODEL") || "meta/llama-3.1-8b-instruct";
const GOOGLE_SHEETS_WEBHOOK_URL = env("GOOGLE_SHEETS_WEBHOOK_URL", "GOOGLE_SHEETS_URL");
const TELEGRAM_API_BASE_URL = (env("TELEGRAM_API_BASE_URL", "TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/+$/, "");
const TELEGRAM_BOT_TOKEN = env("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = env("TELEGRAM_CHAT_ID");
const MAX_LEADS = Math.max(1, Number(process.env.MAX_LEADS || 200));
const MAX_CONTRATACOES = Math.max(1, Number(process.env.PNCP_MAX_CONTRATACOES || 100));
const PNCP_MODALIDADES = (process.env.PNCP_MODALIDADES || "1,2,3,4,5,6,7,8,9,10,11,12,13,14")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function httpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateDate(value, fieldName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(`${fieldName} deve estar no formato YYYY-MM-DD.`, 400);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw httpError(`${fieldName} não é uma data válida.`, 400);
  }

  return value;
}

function validateSearchInput(body = {}) {
  const uf = String(body.uf || "GO").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) {
    throw httpError("UF deve conter exatamente duas letras.", 400);
  }

  const dataInicial = validateDate(body.dataInicial, "dataInicial");
  const dataFinal = validateDate(body.dataFinal, "dataFinal");
  const start = new Date(`${dataInicial}T00:00:00.000Z`);
  const end = new Date(`${dataFinal}T00:00:00.000Z`);
  const days = Math.round((end - start) / 86400000);

  if (days < 0) {
    throw httpError("dataFinal deve ser igual ou posterior a dataInicial.", 400);
  }
  if (days > 31) {
    throw httpError("O período máximo de pesquisa é de 31 dias.", 400);
  }

  return { uf, dataInicial, dataFinal };
}

function makeUrl(base, pathname, params = {}) {
  const url = new URL(`${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function safeUrlForLog(value) {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/bot[^/]+/i, "/bot[redacted]");
    url.search = "";
    return url.toString();
  } catch {
    return "URL externa";
  }
}

async function request(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "PECUS-Consultoria-Licitacoes/1.0",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
      throw httpError(`HTTP ${response.status} em ${safeUrlForLog(url)}: ${detail}`, response.status);
    }

    return { status: response.status, body };
  } catch (error) {
    if (error.name === "AbortError") {
      throw httpError(`Tempo esgotado ao consultar ${safeUrlForLog(url)}.`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function asList(payload, preferredKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  for (const key of ["data", "content", "items", "itens", "results", "resultados", "elements", "elementos", "rows", "leads"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  return [];
}

function firstValue(object, keys) {
  if (!object || typeof object !== "object") return "";
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function cleanDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function getContractIdentity(contract) {
  const orgao = contract?.orgaoEntidade || contract?.orgao || contract?.entidade || {};
  let cnpj = cleanDigits(firstValue(contract, ["cnpjOrgao", "cnpj", "cnpjEntidade"]) || firstValue(orgao, ["cnpj", "cnpjOrgao"]));
  let ano = firstValue(contract, ["anoCompra", "anoContratacao", "ano"]);
  let sequencial = firstValue(contract, ["sequencialCompra", "sequencialContratacao", "sequencial"]);
  const control = String(firstValue(contract, ["numeroControlePNCP", "numeroControle", "id"]));

  if ((!cnpj || !ano || !sequencial) && control) {
    const slashFormat = control.match(/^(\d{14})-\d+-([0-9]+)\/(\d{4})$/);
    const dashFormat = control.match(/^(\d{14})-\d+-(\d{4})-([0-9]+)$/);
    const match = slashFormat || dashFormat;
    if (match) {
      cnpj ||= match[1];
      if (slashFormat) {
        sequencial ||= match[2];
        ano ||= match[3];
      } else {
        ano ||= match[2];
        sequencial ||= match[3];
      }
    }
  }

  if (!cnpj || !ano || !sequencial) return null;
  return { cnpj, ano: String(ano), sequencial: String(sequencial) };
}

async function fetchPaginated(pathname, params, { pageSize = 50, maxPages = 10, maxItems = Infinity } = {}) {
  const output = [];
  for (let page = 1; page <= maxPages && output.length < maxItems; page += 1) {
    const url = makeUrl(PNCP_API_BASE_URL, pathname, {
      ...params,
      pagina: page,
      tamanhoPagina: pageSize
    });
    const { body } = await request(url);
    const rows = asList(body);
    output.push(...rows);

    const total = Number(firstValue(body, ["totalRegistros", "total", "totalElements", "count"]));
    if (!rows.length || (total && output.length >= total) || rows.length < pageSize) break;
  }
  return output.slice(0, maxItems);
}

async function fetchItems(identity, contract) {
  if (Array.isArray(contract?.itens)) return contract.itens;
  const params = {};
  return fetchPaginated(`/orgaos/${identity.cnpj}/compras/${identity.ano}/${identity.sequencial}/itens`, params, {
    pageSize: 50,
    maxPages: 20,
    maxItems: 2000
  });
}

async function fetchResults(identity, item) {
  if (Array.isArray(item?.resultados)) return item.resultados;
  const numeroItem = firstValue(item, ["numeroItem", "itemNumero", "numero"]);
  if (!numeroItem) return [];
  const url = makeUrl(
    PNCP_API_BASE_URL,
    `/orgaos/${identity.cnpj}/compras/${identity.ano}/${identity.sequencial}/itens/${numeroItem}/resultados`
  );
  const { body } = await request(url);
  return asList(body, ["listaResultados", "resultados"]);
}

async function fetchHistory(identity) {
  try {
    const url = makeUrl(PNCP_API_BASE_URL, `/orgaos/${identity.cnpj}/compras/${identity.ano}/${identity.sequencial}/historico`);
    const { body } = await request(url);
    return asList(body, ["historico", "historicos", "logs"]);
  } catch (error) {
    console.warn("Histórico PNCP indisponível:", error.message);
    return [];
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return output;
}

function resultClassification(result) {
  const value = firstValue(result, ["ordemClassificacaoSrp", "ordemClassificacao", "classificacao", "colocacao", "posicao"]);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resultStatus(result) {
  return String(firstValue(result, [
    "situacaoCompraItemResultadoNome",
    "situacaoResultadoNome",
    "situacaoResultado",
    "status",
    "motivo",
    "justificativa",
    "observacao",
    "ocorrencia"
  ]) || "").trim();
}

function isLosingResult(result) {
  const classification = resultClassification(result);
  const status = resultStatus(result).toLocaleLowerCase("pt-BR");
  return (classification === 2 || classification === 3) || /inabilitad|desclassificad|eliminad|rejeitad|inapt|cancelad/.test(status);
}

function ordinal(value) {
  if (value === 1) return "1º";
  if (value === 2) return "2º";
  if (value === 3) return "3º";
  return `${value}º`;
}

function findHistoryReason(history, result) {
  if (!history.length) return "";
  const supplierId = cleanDigits(firstValue(result, ["niFornecedor", "cnpjFornecedor", "cpfFornecedor"]));
  const supplierName = String(firstValue(result, ["nomeRazaoSocialFornecedor", "razaoSocialFornecedor", "nomeFornecedor"]) || "").toLocaleLowerCase("pt-BR");
  const candidate = history.find((event) => {
    const text = JSON.stringify(event).toLocaleLowerCase("pt-BR");
    const mentionsSupplier = (supplierId && text.includes(supplierId)) || (supplierName && text.includes(supplierName));
    return mentionsSupplier && /inabilitad|desclassificad|eliminad|rejeitad|motivo|justificativ|ocorr/.test(text);
  });

  return String(firstValue(candidate, ["justificativa", "motivo", "ocorrencia", "descricao"]) || "").trim();
}

function buildOccurrence(result, history) {
  const status = resultStatus(result);
  const historyReason = findHistoryReason(history, result);
  if (historyReason) return historyReason;
  if (status && /inabilitad|desclassificad|eliminad|rejeitad|inapt|cancelad/i.test(status)) return status;

  const classification = resultClassification(result);
  if (classification && classification > 1) {
    return `Fornecedor classificado em ${ordinal(classification)} lugar, atrás do vencedor.`;
  }
  return "Fornecedor sem vitória registrada no resultado consultado.";
}

function contractTitle(contract, item) {
  return String(firstValue(item, ["descricao", "descricaoItem", "objeto"]) || firstValue(contract, ["objetoCompra", "objeto", "descricaoObjeto", "titulo"] ) || "Objeto não informado").trim();
}

function toLead(contract, identity, item, result, history) {
  const supplierName = String(firstValue(result, ["nomeRazaoSocialFornecedor", "razaoSocialFornecedor", "nomeFornecedor"]) || "Fornecedor não informado").trim();
  const supplierId = String(firstValue(result, ["niFornecedor", "cnpjFornecedor", "cpfFornecedor"]) || "").trim();
  const classification = resultClassification(result);
  const procurementId = String(firstValue(contract, ["numeroControlePNCP", "numeroControle", "id"]) || `${identity.cnpj}-${identity.ano}-${identity.sequencial}`);
  const numeroItem = String(firstValue(item, ["numeroItem", "itemNumero", "numero"]) || "");
  const occurrence = buildOccurrence(result, history);

  return {
    id: `${procurementId}:${numeroItem}:${supplierId || supplierName}`,
    fornecedor: supplierName,
    cnpj: supplierId,
    classificacao: classification,
    situacao: resultStatus(result) || (classification && classification > 1 ? `Não vencedor — ${ordinal(classification)} lugar` : "Não vencedor"),
    ocorrencia: occurrence,
    resumoIA: "",
    objeto: contractTitle(contract, item),
    numeroItem,
    numeroControlePNCP: procurementId,
    orgao: String(firstValue(contract?.orgaoEntidade || contract?.orgao || {}, ["razaoSocial", "nome", "nomeOrgao"]) || "Órgão público não informado"),
    uf: String(firstValue(contract, ["uf", "unidadeFederativa"]) || contract?.unidadeOrgao?.uf || "").toUpperCase(),
    dataPublicacao: firstValue(contract, ["dataPublicacaoPncp", "dataPublicacao", "dataInclusao"]),
    linkPNCP: firstValue(contract, ["urlSistemaOrigem", "linkSistemaOrigem", "urlPncp", "linkPncp"]) || `https://pncp.gov.br/app/editais/${encodeURIComponent(procurementId)}`
  };
}

function fallbackSummary(lead) {
  if (/inabilitad|desclassificad|eliminad|rejeitad|inapt|cancelad/i.test(lead.ocorrencia)) {
    return `Perdeu porque foi ${lead.ocorrencia.replace(/[.!?]+$/, "").toLocaleLowerCase("pt-BR")}.`;
  }
  if (lead.classificacao && lead.classificacao > 1) {
    return `Não venceu porque ficou em ${ordinal(lead.classificacao)} lugar na classificação do item.`;
  }
  return "Não venceu o item conforme a ocorrência registrada no PNCP.";
}

async function summarizeWithNvidia(lead) {
  if (!NVIDIA_API_KEY) return fallbackSummary(lead);

  const prompt = [
    "Resuma em uma única frase, em português do Brasil, por que o fornecedor não venceu a licitação.",
    "Se houver apenas classificação, diga a colocação. Não invente fatos, não use listas e não comece com rótulos.",
    `Fornecedor: ${lead.fornecedor}`,
    `Objeto: ${lead.objeto}`,
    `Ocorrência registrada: ${lead.ocorrencia}`,
    `Classificação: ${lead.classificacao ? ordinal(lead.classificacao) : "não informada"}`
  ].join("\n");

  try {
    const { body } = await request(NVIDIA_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        temperature: 0.2,
        max_tokens: 80,
        messages: [
          { role: "system", content: "Você é um analista objetivo de resultados de licitações." },
          { role: "user", content: prompt }
        ]
      })
    }, 30000);

    const content = body?.choices?.[0]?.message?.content;
    if (!content) return fallbackSummary(lead);
    const summary = String(content).replace(/\s+/g, " ").trim().replace(/^[-•]\s*/, "");
    return summary.length > 260 ? `${summary.slice(0, 257).replace(/\s+\S*$/, "")}...` : summary;
  } catch (error) {
    console.warn("Resumo NVIDIA indisponível:", error.message);
    return fallbackSummary(lead);
  }
}

async function searchPncp(filters) {
  const limitPerModality = Math.max(10, Math.ceil(MAX_CONTRATACOES / Math.max(PNCP_MODALIDADES.length, 1)));
  let successfulModalities = 0;
  let lastError;
  const contractsByModality = await mapWithConcurrency(PNCP_MODALIDADES, 3, async (codigoModalidadeContratacao) => {
    try {
      const contracts = await fetchPaginated("/contratacoes/publicacao", {
        dataInicial: filters.dataInicial.replaceAll("-", ""),
        dataFinal: filters.dataFinal.replaceAll("-", ""),
        codigoModalidadeContratacao,
        uf: filters.uf
      }, {
        pageSize: 50,
        maxPages: Math.ceil(limitPerModality / 50),
        maxItems: limitPerModality
      });
      successfulModalities += 1;
      return contracts;
    } catch (error) {
      lastError = error;
      console.warn(`Modalidade ${codigoModalidadeContratacao} indisponível:`, error.message);
      return [];
    }
  });

  if (!successfulModalities && lastError) throw lastError;
  const contracts = [...new Map(contractsByModality.flat().map((contract) => {
    const identity = getContractIdentity(contract);
    return [identity ? `${identity.cnpj}-${identity.ano}-${identity.sequencial}` : JSON.stringify(contract), contract];
  })).values()].slice(0, MAX_CONTRATACOES);

  const contractResults = await mapWithConcurrency(contracts, 3, async (contract) => {
    const identity = getContractIdentity(contract);
    if (!identity) return [];

    try {
      const items = await fetchItems(identity, contract);
      const itemCandidates = items.filter((item) => item && item.temResultado !== false);
      const itemResults = await mapWithConcurrency(itemCandidates, 4, async (item) => {
        try {
          const results = await fetchResults(identity, item);
          return { item, results };
        } catch (error) {
          console.warn(`Resultados do item indisponíveis (${identity.sequencial}/${firstValue(item, ["numeroItem"])}):`, error.message);
          return { item, results: [] };
        }
      });

      const losingRows = itemResults.flatMap(({ item, results }) => results.filter(isLosingResult).map((result) => ({ item, result })));
      if (!losingRows.length) return [];
      const history = await fetchHistory(identity);
      return losingRows.map(({ item, result }) => toLead(contract, identity, item, result, history));
    } catch (error) {
      console.warn(`Contratação ${identity.sequencial} indisponível:`, error.message);
      return [];
    }
  });

  const unique = new Map();
  for (const lead of contractResults.flat()) unique.set(lead.id, lead);
  return [...unique.values()].slice(0, MAX_LEADS);
}

async function sendToGoogleSheets(filters, leads) {
  const webhook = GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhook) return { sent: false, skipped: true, reason: "GOOGLE_SHEETS_WEBHOOK_URL não configurada" };

  const { status, body } = await request(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "upsert",
      origem: "pecus-consultoria-licitacoes",
      pesquisadoEm: new Date().toISOString(),
      filtros,
      leads
    })
  }, 30000);
  return { sent: true, status, response: body };
}

function telegramText(filters, leads) {
  const lines = [
    "PECUS Consultoria em Licitações",
    `Pesquisa: ${filters.uf} | ${filters.dataInicial} a ${filters.dataFinal}`,
    `Leads encontrados: ${leads.length}`
  ];

  for (const lead of leads.slice(0, 12)) {
    lines.push(`• ${lead.fornecedor} — ${lead.resumoIA || lead.ocorrencia}`);
  }
  if (leads.length > 12) lines.push(`• +${leads.length - 12} leads na planilha/dashboard.`);
  return lines.join("\n");
}

async function sendToTelegram(filters, leads) {
  const token = TELEGRAM_BOT_TOKEN;
  const chatId = TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, skipped: true, reason: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID não configurados" };

  const url = makeUrl(TELEGRAM_API_BASE_URL, `/bot${token}/sendMessage`);
  const { status, body } = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: telegramText(filters, leads), disable_web_page_preview: true })
  }, 30000);
  return { sent: true, status, response: body };
}

function extractLeadsFromWebhook(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  return asList(payload, ["leads", "data", "rows", "records", "values"]);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pecus-consultoria-licitacoes",
    timestamp: new Date().toISOString(),
    config: {
      pncp: Boolean(PNCP_API_BASE_URL),
      nvidia: Boolean(NVIDIA_API_KEY),
      googleSheets: Boolean(GOOGLE_SHEETS_WEBHOOK_URL),
      telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    }
  });
});

app.get("/api/leads", async (_req, res, next) => {
  const webhook = GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhook) {
    return res.json({ ok: true, configured: false, leads: [], message: "Configure GOOGLE_SHEETS_WEBHOOK_URL para carregar leads salvos." });
  }

  try {
    const { body } = await request(webhook, {}, 30000);
    return res.json({ ok: true, configured: true, leads: extractLeadsFromWebhook(body), source: body });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/buscar", async (req, res, next) => {
  try {
    const filters = validateSearchInput(req.body);
    const rawLeads = await searchPncp(filters);
    const leads = await mapWithConcurrency(rawLeads, 4, async (lead) => ({
      ...lead,
      resumoIA: await summarizeWithNvidia(lead)
    }));

    const [sheetsResult, telegramResult] = await Promise.allSettled([
      sendToGoogleSheets(filters, leads),
      sendToTelegram(filters, leads)
    ]);

    const integration = {
      sheets: sheetsResult.status === "fulfilled" ? sheetsResult.value : { sent: false, error: sheetsResult.reason.message },
      telegram: telegramResult.status === "fulfilled" ? telegramResult.value : { sent: false, error: telegramResult.reason.message }
    };

    return res.json({ ok: true, filtros: filters, total: leads.length, leads, integracoes: integration });
  } catch (error) {
    return next(error);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ ok: false, error: error.message || "Erro interno do servidor." });
});

app.listen(PORT, () => {
  console.log(`PECUS Consultoria em Licitações disponível em http://localhost:${PORT}`);
});
